/**
 * P1 差分测试（方案 §7.1 —— 没有它 P1 不能合）：
 * 同一逻辑书源的两种载体（fixtures/booksources/<id>.js ↔ <id>.json），吃**同一份 HTML 字节**，
 * JS 沙箱引擎与 JSON 规则引擎四入口（search / bookInfo / chapterList / chapterContent）输出逐字段等价。
 *
 * 离线打桩（F17，零网络）：
 *  - JS 侧：真实 JsSourceAdapter → 真实 SandboxService → FixtureWorker（fixtures/worker-stub.ts，
 *    worker 协议本地实现）。出站 `type:'http'` 由真实 SandboxService.proxyHttp 处理，其
 *    `window.pomAPI.booksourceHttpProxy` 被 mock 成 URL → fixtures/html/<id>/*.html 映射；
 *    出站 `type:'query'` 由真实 SandboxService.proxyQuery 处理（主线程 DOMParser 真实实现
 *    + pom.cssRules=0 门禁，sandbox.service.ts:673-731，不复制不移植 —— 否则等于拿自己测自己）。
 *  - JSON 侧：真实 JsonRuleAdapter → 真实 RuleEngineService（TestBed 注入，CfPromptService mock），
 *    booksourceHttpProxy 复用**同一个** URL→HTML mock，booksourceRead mock 成读 .json fixture。
 *
 * 除输出等价外，还断言两侧 HTTP 请求序列（method/url/body/headers）逐项一致 ——
 * 防止「URL 构造不同但恰好命中同一 fixture」的静默分叉。
 *
 * 样本清单 / 覆盖矩阵 / 已知差异登记：fixtures/MANIFEST.md。
 */
import 'zone.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TestBed } from '@angular/core/testing';
import {
  BrowserDynamicTestingModule,
  platformBrowserDynamicTesting,
} from '@angular/platform-browser-dynamic/testing';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FixtureWorker } from '../../../../../fixtures/worker-stub';
import { type PageFetcher } from '../book-source.adapter';
import { CfPromptService } from '../js-source/cf-prompt.service';
import { JsSourceAdapter } from '../js-source/js-source.adapter';
import { SandboxService } from '../js-source/sandbox.service';
import { type BookSourceMeta } from '../js-source/source-meta.types';
import { CSS_RULES_DISABLED_MESSAGE } from './engine';
import { JsonRuleAdapter } from './json-rule.adapter';
import { RuleEngineService } from './rule-engine.service';

// ── fixtures 定位与 URL 映射 ────────────────────────────────────────────────

// vitest 以仓库根为 cwd 运行（vitest.config.ts 未改 root），直接按 cwd 定位 fixtures
const FIXTURES_DIR = join(process.cwd(), 'fixtures');

function readFixture(...parts: string[]): string {
  return readFileSync(join(FIXTURES_DIR, ...parts), 'utf8');
}

/** URL → 本地 HTML fixture（约定见 fixtures/MANIFEST.md「维护」节）；未命中即抛错，杜绝静默分叉 */
function htmlForUrl(url: string): string {
  const u = new URL(url);
  const id = u.hostname.split('.')[0];
  const p = u.pathname.replace(/\/+$/, '') || '/';
  let page: string;
  if (p.startsWith('/search')) page = 'search';
  else if (p === '/book/1/toc') page = 'toc';
  else if (p.startsWith('/book/1/chapter/')) page = 'chapter';
  else if (p === '/book/1') page = 'detail';
  else throw new Error(`fixture miss: ${url}（URL 约定见 fixtures/MANIFEST.md）`);
  return readFixture('html', id, `${page}.html`);
}

// ── 样本定义（与 fixtures/MANIFEST.md 清单一一对应）──────────────────────────

interface SampleDef {
  id: string;
  origin: string;
  /** CSS 规则源：flag=0 时应抛 CSS 禁用文案；正则规则源不受影响 */
  cssBased: boolean;
}

const SAMPLES: SampleDef[] = [
  { id: 'sample-css', origin: 'https://sample-css.invalid', cssBased: true },
  { id: 'sample-regex', origin: 'https://sample-regex.invalid', cssBased: false },
  { id: 'sample-post', origin: 'https://sample-post.invalid', cssBased: false },
  { id: 'sample-post-raw', origin: 'https://sample-post-raw.invalid', cssBased: true },
  { id: 'sample-clean', origin: 'https://sample-clean.invalid', cssBased: true },
  { id: 'sample-gbk', origin: 'https://sample-gbk.invalid', cssBased: true },
  { id: 'sample-extra', origin: 'https://sample-extra.invalid', cssBased: true },
];

/** 已知差异 #1 触发样本（MANIFEST）：只跑 search，不进等价矩阵 */
const BADHREF: SampleDef = {
  id: 'sample-badhref',
  origin: 'https://sample-badhref.invalid',
  cssBased: true,
};
/** needs-manual 反例：含模板外语句，无 .json 载体，不进等价矩阵 */
const MANUAL: SampleDef = {
  id: 'sample-manual',
  origin: 'https://sample-manual.invalid',
  cssBased: true,
};

type Entry = 'search' | 'bookInfo' | 'chapterList' | 'chapterContent';
const ENTRIES: Entry[] = ['search', 'bookInfo', 'chapterList', 'chapterContent'];
const KEYWORD = '剑来';

// ── pomAPI mock + 请求捕获（两侧共用同一份 HTML 字节）────────────────────────

interface CapturedRequest {
  method: string;
  url: string;
  body: string | null;
  headers: Record<string, string>;
}

let captured: CapturedRequest[] = [];

function sortedHeaders(h: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(h ?? {}).sort()) out[k] = (h ?? {})[k];
  return out;
}

function installPomApi(): void {
  (window as unknown as { pomAPI?: unknown }).pomAPI = {
    booksourceRead: async (fileName: string) => readFixture('booksources', fileName),
    booksourceHttpProxy: async (req: {
      url: string;
      method?: string;
      headers?: Record<string, string>;
      body?: string | null;
    }) => {
      captured.push({
        method: req.method ?? 'GET',
        url: req.url,
        body: req.body ?? null,
        headers: sortedHeaders(req.headers),
      });
      return { status: 200, headers: {}, body: htmlForUrl(req.url) };
    },
  };
}

// ── 两侧 runner ──────────────────────────────────────────────────────────────

interface SideResult {
  value?: unknown;
  error?: string;
  requests: CapturedRequest[];
}

/** meta 手工构造（与生产 scanDir/parse 产物同形态）；name 取样本 id —— 两侧一致即可 */
function makeMeta(sample: SampleDef, ext: 'js' | 'json'): BookSourceMeta {
  const fileName = `${sample.id}.${ext}`;
  return {
    sourceKey: fileName,
    uuid: fileName,
    fileName,
    name: sample.id,
    url: sample.origin,
    urls: [sample.origin],
    author: undefined,
    logo: undefined,
    description: undefined,
    enabled: true,
    fileSize: 0,
    modifiedAt: 0,
    sourceDir: '',
    sourceType: 'novel',
    version: '1.2.0',
    tags: [],
    minDelayMs: 0,
    requireUrls: [],
  };
}

const NO_FETCHER = null as unknown as PageFetcher;

let engineService: RuleEngineService;

async function runJsEntry(sample: SampleDef, entry: Entry): Promise<SideResult> {
  const meta = makeMeta(sample, 'js');
  const worker = new FixtureWorker();
  const sandbox = SandboxService.forTest(worker as unknown as Worker);
  const adapter = new JsSourceAdapter(meta, sandbox);
  captured = [];
  try {
    let value: unknown;
    switch (entry) {
      case 'search':
        value = await adapter.search(KEYWORD, 1);
        break;
      case 'bookInfo':
        value = await adapter.fetchCatalog(`${sample.origin}/book/1`, NO_FETCHER);
        break;
      case 'chapterList': {
        // adapter 不暴露 chapterList 单入口 → 经 SandboxService 直调
        // （先 load 源码，与 JsSourceAdapter.ensureLoaded 同款语义）
        await sandbox.load(meta.fileName, readFixture('booksources', meta.fileName));
        value = await sandbox.call(meta.fileName, 'chapterList', [`${sample.origin}/book/1/toc`]);
        break;
      }
      case 'chapterContent':
        value = await adapter.fetchChapter(
          { title: '第一章', url: `${sample.origin}/book/1/chapter/1` },
          NO_FETCHER,
        );
        break;
    }
    return { value, requests: captured };
  } catch (e) {
    return { error: (e as Error)?.message ?? String(e), requests: captured };
  }
}

async function runRuleEntry(sample: SampleDef, entry: Entry): Promise<SideResult> {
  const meta = makeMeta(sample, 'json');
  const adapter = new JsonRuleAdapter(meta, engineService);
  captured = [];
  try {
    let value: unknown;
    switch (entry) {
      case 'search':
        value = await adapter.search(KEYWORD, 1);
        break;
      case 'bookInfo':
        value = await adapter.fetchCatalog(`${sample.origin}/book/1`, NO_FETCHER);
        break;
      case 'chapterList':
        value = await engineService.chapterList(meta, `${sample.origin}/book/1/toc`);
        break;
      case 'chapterContent':
        value = await adapter.fetchChapter(
          { title: '第一章', url: `${sample.origin}/book/1/chapter/1` },
          NO_FETCHER,
        );
        break;
    }
    return { value, requests: captured };
  } catch (e) {
    return { error: (e as Error)?.message ?? String(e), requests: captured };
  }
}

// ── 字段级 diff（失败时打印，辅助定位不一致字段）──────────────────────────────

function fieldDiff(a: unknown, b: unknown, path = '$'): string[] {
  if (Object.is(a, b)) return [];
  const bothObjs = a !== null && b !== null && typeof a === 'object' && typeof b === 'object';
  if (!bothObjs || Array.isArray(a) !== Array.isArray(b)) {
    return [`${path}: js=${JSON.stringify(a)} ≠ rule=${JSON.stringify(b)}`];
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out: string[] = [];
  for (const k of keys) {
    out.push(
      ...fieldDiff(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
        `${path}.${k}`,
      ),
    );
  }
  return out;
}

function expectSame(label: string, jsValue: unknown, ruleValue: unknown): void {
  const diffs = fieldDiff(jsValue, ruleValue);
  if (diffs.length > 0) {
    console.error(
      `[diff-test] ${label} 字段级 diff（前 50 条）：\n${diffs.slice(0, 50).join('\n')}`,
    );
  }
  expect(ruleValue, label).toEqual(jsValue);
}

/** 等价断言：两侧都成功 + 输出逐字段一致 + HTTP 请求序列逐项一致 */
async function assertEntryEqual(sample: SampleDef, entry: Entry): Promise<SideResult> {
  const js = await runJsEntry(sample, entry);
  const rule = await runRuleEntry(sample, entry);
  const label = `${sample.id}/${entry}`;
  expect(js.error, `${label} JS 侧意外失败`).toBeUndefined();
  expect(rule.error, `${label} JSON 侧意外失败`).toBeUndefined();
  expectSame(label, js.value, rule.value);
  expect(rule.requests, `${label} HTTP 请求序列`).toEqual(js.requests);
  return js;
}

/** 非空产物检查（证明「正常解析」而非「双双失败得相同空结果」） */
function nonEmpty(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'string') return value.length > 0;
  if (value && typeof value === 'object') {
    const chapters = (value as { chapters?: unknown }).chapters;
    return Array.isArray(chapters) && chapters.length > 0;
  }
  return false;
}

// ── needs-manual 识别：结构白名单轻量标记 ────────────────────────────────────
// 白名单取自方案 §4.2（真正的迁移判定在 P3 rule-migrate.ts 实现）；此处是差分框架的
// 标记器：识别 needs-manual 反例，同时护栏其余 .js fixture 不被手滑改出模板外语句。

const WHITELIST_FUNCTIONS = new Set([
  'isCssRule',
  'ruleSelector',
  'stripTags',
  'absUrl',
  'matchAll',
  'extractLinks',
  'extractSearchItems',
  'searchExtraRules',
  'extractText',
  'extractHtml',
  'extractAttr',
  'buildFormBody',
  'search',
  'bookInfo',
  'chapterList',
  'chapterContent',
]);
const WHITELIST_CONSTS = new Set([
  'BASE_URL',
  'HEADERS',
  'REGEX_HINT_CHARS',
  'MAX_EXTRACT_LINKS',
  'SEARCH_PATH',
  'SEARCH_METHOD',
  'SEARCH_BODY_PARAMS',
  'SEARCH_CONTENT_TYPE',
  'SEARCH_RAW_BODY',
  'SEARCH_ITEM_RULE',
  'SEARCH_AUTHOR_RULE',
  'SEARCH_CATEGORY_RULE',
  'BOOK_TITLE_RULE',
  'BOOK_AUTHOR_RULE',
  'CHAPTER_ITEM_RULE',
  'CONTENT_RULE',
  'CONTENT_REPLACE_RULES',
  'BOOK_CATEGORY_RULE',
  'COVER_RULE',
]);

/** 返回白名单外的顶层声明名（空数组 = 纯模板源）；头部注释块不参与判定（F14） */
function detectNonTemplateStatements(source: string): string[] {
  const body = source.replace(/^(\/\/[^\n]*\n)+/, '');
  const offenders: string[] = [];
  const re = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|^const\s+([A-Za-z_$][\w$]*)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const fnName = m[1];
    const constName = m[2];
    if (fnName && !WHITELIST_FUNCTIONS.has(fnName)) offenders.push(fnName);
    if (constName && !WHITELIST_CONSTS.has(constName)) offenders.push(constName);
  }
  return offenders;
}

// ── 测试本体 ──────────────────────────────────────────────────────────────────

interface RawItem {
  name: string;
  author?: string;
  kind?: string;
  url?: string;
  bookUrl?: string;
}

describe('book-source 双引擎差分测试（方案 §7.1）', () => {
  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserDynamicTestingModule, platformBrowserDynamicTesting());
  });

  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [RuleEngineService, { provide: CfPromptService, useValue: { prompt: vi.fn() } }],
    });
    engineService = TestBed.inject(RuleEngineService);
    installPomApi();
  });

  afterEach(() => {
    localStorage.removeItem('pom.cssRules');
    delete (window as unknown as { pomAPI?: unknown }).pomAPI;
  });

  describe('等价矩阵（默认 flag）：7 样本 × 4 入口，输出逐字段一致 + 请求序列一致', () => {
    for (const sample of SAMPLES) {
      describe(sample.id, () => {
        for (const entry of ENTRIES) {
          it(`${entry} 两引擎输出逐字段等价`, async () => {
            await assertEntryEqual(sample, entry);
          });
        }
      });
    }
  });

  describe('fixtures 接线自检（绝对值锚点，防止两侧一致地错）', () => {
    it('sample-css/search：重复 URL 收敛去重 + 空名条目（img-only 锚点）丢弃', async () => {
      const js = await assertEntryEqual(SAMPLES[0], 'search');
      const items = js.value as RawItem[];
      expect(items.map((i) => i.name)).toEqual(['剑来传奇', '雪中行']);
      expect(items.map((i) => i.url)).toEqual([
        'https://sample-css.invalid/book/1',
        'https://sample-css.invalid/book/2',
      ]);
    });

    it('sample-regex/search：正则条目不去重（/book/1 重复保留），版本漂移旧源无增强规则常量', async () => {
      const js = await assertEntryEqual(SAMPLES[1], 'search');
      const items = js.value as RawItem[];
      expect(items.map((i) => i.url)).toEqual([
        'https://sample-regex.invalid/book/1',
        'https://sample-regex.invalid/book/2',
        'https://sample-regex.invalid/book/1',
      ]);
    });

    it('sample-post/search：POST form body 与自定义 headers 逐字节一致，正则增强规则提取 author/kind', async () => {
      const js = await assertEntryEqual(SAMPLES[2], 'search');
      const items = js.value as RawItem[];
      expect(items.map((i) => [i.name, i.author, i.kind])).toEqual([
        ['凡人修仙传', '忘语', '仙侠'],
        ['仙逆', '耳根', '仙侠'],
      ]);
      expect(js.requests).toEqual([
        {
          method: 'POST',
          url: 'https://sample-post.invalid/search',
          body: `q=${encodeURIComponent(KEYWORD)}&page=1`,
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Referer: 'https://sample-post.invalid/',
            'X-Requested-With': 'XMLHttpRequest',
          },
        },
      ]);
    });

    it('sample-post-raw/search：POST_RAW body 模板替换（keyword 不 encode）+ JSON Content-Type 缺省回填', async () => {
      const js = await assertEntryEqual(SAMPLES[3], 'search');
      expect(js.requests).toEqual([
        {
          method: 'POST',
          url: 'https://sample-post-raw.invalid/search',
          body: `{"q":"${KEYWORD}","page":1}`,
          headers: { 'Content-Type': 'application/json', 'X-Client': 'pomreader-diff-test' },
        },
      ]);
    });

    it('sample-clean/chapterContent：多条净化规则按序生效（广告行/地址行/本章完被清除）', async () => {
      const js = await assertEntryEqual(SAMPLES[4], 'chapterContent');
      const text = js.value as string;
      expect(text).toContain('天亮了，他睁开眼睛。');
      expect(text).toContain('路上无人，只有风声。');
      expect(text).not.toContain('广告');
      expect(text).not.toContain('最新章节地址');
      expect(text).not.toContain('本章完');
    });

    it('sample-gbk/bookInfo：GBK meta 声明样本，缺省规则走 DEFAULT_PATTERNS 回填（分类正则 + css:img 封面）', async () => {
      const js = await assertEntryEqual(SAMPLES[5], 'bookInfo');
      const book = js.value as {
        title: string;
        author: string;
        kind?: string;
        coverImageUrl?: string;
        chapters: Array<{ title: string; url: string }>;
      };
      expect(book.title).toBe('天龙八部');
      expect(book.author).toBe('金庸');
      expect(book.kind).toBe('武侠');
      expect(book.coverImageUrl).toBe('https://sample-gbk.invalid/static/cover-t.jpg');
      expect(book.chapters).toHaveLength(2);
    });

    it('sample-extra/search：CSS 增强规则在条目作用域内提取 author/kind', async () => {
      const js = await assertEntryEqual(SAMPLES[6], 'search');
      const items = js.value as RawItem[];
      expect(items.map((i) => [i.name, i.author, i.kind])).toEqual([
        ['诛仙', '萧鼎', '仙侠'],
        ['搜神记', '树下野狐', '玄幻'],
      ]);
    });
  });

  describe('pom.cssRules=0 止血开关矩阵（F6c：该门是现状生产行为，两列都必须验）', () => {
    beforeEach(() => {
      localStorage.setItem('pom.cssRules', '0');
    });

    for (const sample of SAMPLES.filter((s) => s.cssBased)) {
      for (const entry of ENTRIES) {
        it(`${sample.id}/${entry} flag=0：两侧抛同一文案`, async () => {
          const js = await runJsEntry(sample, entry);
          const rule = await runRuleEntry(sample, entry);
          // JSON 侧引擎直接抛（engine.ts assertCssAllowed）
          expect(rule.error).toBe(CSS_RULES_DISABLED_MESSAGE);
          // JS 侧经 worker error 通道回传的是 err.stack 全文（sandbox.worker.ts:382-393），
          // 首行即同一文案 —— 断言包含而非全等
          expect(js.error ?? '').toContain(CSS_RULES_DISABLED_MESSAGE);
          // 已知差异 #2（MANIFEST）显式锁定：引擎 fail-fast 不发请求（0 次）；
          // 模板先发 1 次请求再在 query 门禁响亮失败（结果字段无差异）
          expect(rule.requests).toHaveLength(0);
          expect(js.requests).toHaveLength(1);
        });
      }
    }

    for (const sample of SAMPLES.filter((s) => !s.cssBased)) {
      for (const entry of ENTRIES) {
        it(`${sample.id}/${entry} flag=0：正则规则源不受开关影响，输出仍逐字段一致`, async () => {
          const js = await assertEntryEqual(sample, entry);
          expect(nonEmpty(js.value), 'flag=0 下正则源应仍有产出').toBe(true);
        });
      }
    }
  });

  describe('已知差异显式锁定（登记于 fixtures/MANIFEST.md，不算失败）', () => {
    it('known-diff#1 sample-badhref/search：CSS 分支非法 href —— JS 侧丢弃条目 / TS 侧保留原始 href', async () => {
      const js = await runJsEntry(BADHREF, 'search');
      const rule = await runRuleEntry(BADHREF, 'search');
      expect(js.error).toBeUndefined();
      expect(rule.error).toBeUndefined();
      // JS 侧：proxyQuery 的 abs() 在 new URL 失败时返回 ''（sandbox.service.ts:706-712），
      // links 过滤后该条目整体消失
      expect((js.value as RawItem[]).map((i) => i.url)).toEqual([
        'https://sample-badhref.invalid/book/1',
        'https://sample-badhref.invalid/book/2',
      ]);
      // TS 侧：absUrl 失败原样返回 href（smart-rules.ts:143-149）→ 条目保留，url 为非法原始串
      expect((rule.value as RawItem[]).map((i) => i.url)).toEqual([
        'https://sample-badhref.invalid/book/1',
        'http://[bad',
        'https://sample-badhref.invalid/book/2',
      ]);
    });
  });

  describe('needs-manual 反例（sample-manual：含模板外语句，识别并标记，不进等价断言）', () => {
    it('结构白名单检测：自定义声明被标记（CUSTOM_BLACKLIST / isBlacklisted）', () => {
      const offenders = detectNonTemplateStatements(readFixture('booksources', 'sample-manual.js'));
      expect(offenders).toContain('CUSTOM_BLACKLIST');
      expect(offenders).toContain('isBlacklisted');
    });

    it('等价矩阵与已知差异样本的 .js 全部通过纯模板检测（fixture 完整性护栏）', () => {
      for (const s of [...SAMPLES, BADHREF]) {
        const offenders = detectNonTemplateStatements(readFixture('booksources', `${s.id}.js`));
        expect(offenders, `${s.id}.js 应为纯模板生成源`).toEqual([]);
      }
    });

    it('JS 侧仍可执行且自定义过滤生效（黑名单条目被滤除）—— 证明其确为可运行的手改源', async () => {
      const js = await runJsEntry(MANUAL, 'search');
      expect(js.error).toBeUndefined();
      expect((js.value as RawItem[]).map((i) => i.name)).toEqual(['平凡的世界', '白鹿原']);
    });
  });
});
