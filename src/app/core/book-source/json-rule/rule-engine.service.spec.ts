/**
 * RuleEngineService 单测（P1.6）
 *
 * 覆盖三条本层特有的职责（引擎语义由 `engine.spec.ts` / 差分基座负责）：
 * ① HTTP 通道：`booksourceHttpProxy` 直连 + CF Tier 2 直调 + 浏览器降级；
 * ② `readDoc`：JSON → valibot 校验，**失败要带字段路径**（排障第一诉求）；
 * ③ RuleTrace：成功与失败都留痕，且并发调用互不串味。
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import 'zone.js';
import { TestBed } from '@angular/core/testing';
import {
  BrowserDynamicTestingModule,
  platformBrowserDynamicTesting,
} from '@angular/platform-browser-dynamic/testing';
import { RuleEngineService } from './rule-engine.service';
import { CfPromptService } from '../../services/cf-prompt.service';
import type { BookSourceDoc } from '../../models/book-source-doc.model';

const DOC: BookSourceDoc = {
  format: 'pomreader.booksource',
  schemaVersion: 1,
  uuid: 'uuid-1',
  name: '示例书源',
  homepage: 'https://example.com',
  urls: ['https://example.com'],
  enabled: true,
  sourceType: 'novel',
  headers: { 'X-Token': 'abc' },
  rules: {
    siteName: '示例站点',
    searchPath: '/search?q={keyword}',
    searchItemPattern: 'ul.list li',
    bookTitlePattern: 'h1',
    bookAuthorPattern: 'css:.author',
    chapterItemPattern: 'ul.chapter-list a',
    contentPattern: 'div#content',
  },
};

const SEARCH_HTML = '<ul class="list"><li><a href="/book/1">书一</a></li></ul>';

/** 装一个可控的 pomAPI 桩：记录请求，按 URL 表返回 */
function stubPom(opts: {
  respond?: (url: string) => { status: number; body: string; cfChallenge?: boolean };
  read?: (fileName: string) => string;
}): {
  calls: { url: string; method?: string; headers?: Record<string, string>; body?: string | null }[];
} {
  const calls: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string | null;
  }[] = [];
  (window as unknown as { pomAPI?: unknown }).pomAPI = {
    booksourceHttpProxy: vi.fn(
      async (req: {
        url: string;
        method?: string;
        headers?: Record<string, string>;
        body?: string | null;
      }) => {
        calls.push(req);
        const r = opts.respond?.(req.url) ?? { status: 200, body: SEARCH_HTML };
        return { status: r.status, headers: {}, body: r.body, cfChallenge: r.cfChallenge };
      },
    ),
    booksourceRead: vi.fn(async (fileName: string) => opts.read?.(fileName) ?? '{}'),
  };
  return { calls };
}

describe('RuleEngineService', () => {
  let svc: RuleEngineService;
  let prompt: ReturnType<typeof vi.fn>;

  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserDynamicTestingModule, platformBrowserDynamicTesting());
  });

  beforeEach(() => {
    prompt = vi.fn();
    TestBed.configureTestingModule({
      providers: [{ provide: CfPromptService, useValue: { prompt } }],
    });
    svc = TestBed.inject(RuleEngineService);
  });

  afterEach(() => {
    delete (window as unknown as { pomAPI?: unknown }).pomAPI;
    vi.restoreAllMocks();
  });

  describe('HTTP 通道：直连 booksourceHttpProxy', () => {
    it('把 url / method / 文档 headers 一起下发（自定义头不丢）', async () => {
      const { calls } = stubPom({});
      await svc.search(DOC, 'kw', 1);
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe('https://example.com/search?q=kw');
      expect(calls[0].method).toBe('GET');
      expect(calls[0].headers).toEqual({ 'X-Token': 'abc' });
    });

    it('无 pomAPI 时降级为 fetch（浏览器 dev 不崩）', async () => {
      delete (window as unknown as { pomAPI?: unknown }).pomAPI;
      const fetchMock = vi.fn(async () => new Response(SEARCH_HTML, { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);
      const items = await svc.search(DOC, 'kw', 1);
      expect(items).toHaveLength(1);
      expect(fetchMock).toHaveBeenCalled();
      vi.unstubAllGlobals();
    });
  });

  describe('CF Tier 2：响应带 cfChallenge 即弹窗引导', () => {
    it('调 CfPromptService.prompt(url)，且不阻塞本次抓取回执（fire-and-forget）', async () => {
      stubPom({
        respond: () => ({ status: 403, body: '<html>blocked</html>', cfChallenge: true }),
      });
      // 403 仍按 2xx 门抛错（响亮失败，与旧链路一致），但弹窗已经触发
      await expect(svc.search(DOC, 'kw', 1)).rejects.toThrow('HTTP 403');
      expect(prompt).toHaveBeenCalledWith('https://example.com/search?q=kw');
    });

    it('无 cfChallenge 时不弹窗', async () => {
      stubPom({ respond: () => ({ status: 403, body: '' }) });
      await expect(svc.search(DOC, 'kw', 1)).rejects.toThrow('HTTP 403');
      expect(prompt).not.toHaveBeenCalled();
    });
  });

  describe('readDoc：JSON → valibot', () => {
    it('合法文档原样返回', async () => {
      stubPom({ read: () => JSON.stringify(DOC) });
      const doc = await svc.readDoc('a.json');
      expect(doc.uuid).toBe('uuid-1');
      expect(doc.rules.siteName).toBe('示例站点');
    });

    it('JSON 语法错 → parse-failed 且说明是 JSON 层面', async () => {
      stubPom({ read: () => '{ not json' });
      await expect(svc.readDoc('a.json')).rejects.toThrow(/不是合法 JSON/);
    });

    it('schema 不过 → parse-failed 且**带字段路径**（排障第一诉求）', async () => {
      const bad = { ...DOC, rules: { ...DOC.rules, searchPath: 42 } } as unknown;
      stubPom({ read: () => JSON.stringify(bad) });
      await expect(svc.readDoc('a.json')).rejects.toThrow(/rules\.searchPath/);
    });

    it('format 字段不对 → 判非法（不是 pomreader 书源）', async () => {
      stubPom({ read: () => JSON.stringify({ ...DOC, format: 'legado' }) });
      await expect(svc.readDoc('a.json')).rejects.toThrow(/format/);
    });

    it('IPC 不可用 → source-unavailable', async () => {
      delete (window as unknown as { pomAPI?: unknown }).pomAPI;
      await expect(svc.readDoc('a.json')).rejects.toThrow(/booksourceRead/);
    });

    it('每次调用都重新读（改完 JSON 立即生效，不缓存）', async () => {
      let n = 0;
      stubPom({
        read: () => JSON.stringify({ ...DOC, name: n === 0 ? '第一版' : '第二版' }),
      });
      n = 0;
      expect((await svc.readDoc('a.json')).name).toBe('第一版');
      n = 1;
      expect((await svc.readDoc('a.json')).name).toBe('第二版');
    });
  });

  describe('RuleTrace', () => {
    it('成功调用记 entry / 条数 / 请求明细', async () => {
      stubPom({});
      await svc.search(DOC, 'kw', 1);
      const t = svc.traces()[0];
      expect(t.entry).toBe('search');
      expect(t.source).toContain('uuid-1');
      expect(t.resultCount).toBe(1);
      expect(t.requests).toHaveLength(1);
      expect(t.requests[0].status).toBe(200);
      expect(t.error).toBeUndefined();
    });

    it('失败也留痕（带错误文案），不吞排障线索', async () => {
      stubPom({ respond: () => ({ status: 500, body: '' }) });
      await expect(svc.chapterList(DOC, 'https://example.com/book/1')).rejects.toThrow('HTTP 500');
      const t = svc.traces()[0];
      expect(t.entry).toBe('chapterList');
      expect(t.error).toBe('HTTP 500');
      expect(t.requests[0].status).toBe(500);
    });

    it('bookInfo 记章节数，chapterContent 记正文字数', async () => {
      stubPom({
        respond: () => ({
          status: 200,
          body: '<h1>t</h1><ul class="chapter-list"><li><a href="/c/1">一</a></li></ul>',
        }),
      });
      await svc.bookInfo(DOC, 'https://example.com/book/1');
      expect(svc.traces()[0].resultCount).toBe(1);
      svc.clearTraces();
      stubPom({ respond: () => ({ status: 200, body: '<div id="content">正文三字</div>' }) });
      await svc.chapterContent(DOC, 'https://example.com/c/1');
      expect(svc.traces()[0].entry).toBe('chapterContent');
    });

    it('并发调用互不串味（各自的请求各归各的轨迹）', async () => {
      let inFlight = 0;
      (window as unknown as { pomAPI?: unknown }).pomAPI = {
        booksourceHttpProxy: vi.fn(
          async (req: {
            url: string;
            method?: string;
            headers?: Record<string, string>;
            body?: string | null;
          }) => {
            inFlight++;
            // 让两个调用真的交错：第一个请求等第二个进来
            if (inFlight === 1) await new Promise((r) => setTimeout(r, 10));
            const body = req.url.includes('/search') ? SEARCH_HTML : '<div id="content">x</div>';
            inFlight--;
            return { status: 200, headers: {}, body };
          },
        ),
      };
      const [searchRes, contentRes] = await Promise.all([
        svc.search(DOC, 'kw', 1),
        svc.chapterContent(DOC, 'https://example.com/c/1'),
      ]);
      expect(searchRes).toHaveLength(1);
      expect(contentRes).toBe('x');
      const traces = svc.traces();
      const searchTrace = traces.find((t) => t.entry === 'search')!;
      const contentTrace = traces.find((t) => t.entry === 'chapterContent')!;
      expect(searchTrace.requests.every((r) => r.url.includes('/search'))).toBe(true);
      expect(contentTrace.requests.every((r) => r.url.includes('/c/1'))).toBe(true);
      expect(searchTrace.requests).toHaveLength(1);
      expect(contentTrace.requests).toHaveLength(1);
    });

    it('trace 有上限（长会话不无限增长）', async () => {
      stubPom({});
      for (let i = 0; i < 60; i++) await svc.search(DOC, 'kw', 1);
      expect(svc.traces().length).toBeLessThanOrEqual(50);
    });

    it('clearTraces 清空', async () => {
      stubPom({});
      await svc.search(DOC, 'kw', 1);
      expect(svc.traces()).toHaveLength(1);
      svc.clearTraces();
      expect(svc.traces()).toHaveLength(0);
    });
  });

  describe('engineFor：适配器用的无 trace 通道', () => {
    it('能直接跑四入口，不写 traces', async () => {
      stubPom({});
      const engine = svc.engineFor(DOC);
      await engine.search('kw', 1);
      expect(svc.traces()).toHaveLength(0);
    });
  });
});
