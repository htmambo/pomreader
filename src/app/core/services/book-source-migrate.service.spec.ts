/**
 * 迁移编排服务测试（书源 JSON 规则化 P3.1）
 *
 * 用假 `window.pomAPI` 覆盖编排语义：分派、幂等、单个失败不中断整批、报告只在有变更时落盘。
 * 判定逻辑本身在 `rule-migrate.spec.ts`（纯函数），本文件不重复测那些分支。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BookSourceMigrateService } from './book-source-migrate.service';
import { serializeSourceDoc } from '../logic/source-doc-build';
import type { MigrationReport } from '../logic/rule-migrate';

const TEMPLATE_JS = `// @name        示例源
// @version     1.2.0
// @url         https://example.com
// @enabled     true

const BASE_URL = "https://example.com"
const SEARCH_PATH = "/s.php"
const SEARCH_METHOD = "GET"
const SEARCH_ITEM_RULE = "ul.search li a"
const BOOK_TITLE_RULE = "<h1>([\\\\s\\\\S]*?)</h1>"
const BOOK_AUTHOR_RULE = "作者：([^<]{1,30})"
const CHAPTER_ITEM_RULE = "ul.info li a"
const CONTENT_RULE = "div.txt"

function stripTags(html) {
  return String(html || '').replace(/<[^>]+>/g, '').trim()
}

function absUrl(href, base) {
  try { return new URL(href, base).href } catch { return href || '' }
}

async function search(key, page) {
  return []
}

async function bookInfo(bookUrl) {
  return { title: '', author: '', chapters: [] }
}

async function chapterList(bookUrl) {
  return []
}

async function chapterContent(chapterUrl) {
  return ''
}
`;

const HANDEDIT_JS = `${TEMPLATE_JS}
function myHack() { return 1 }
`;

interface FakeApi {
  list: unknown[];
  files: Record<string, string>;
  converted: Array<{ jsFileName: string; json: string; sourceDir?: string }>;
  archived: Array<{ jsFileName: string; reason: string; sourceDir?: string }>;
  report: unknown;
  listThrows: boolean;
  readThrows: Record<string, boolean>;
  convertThrows: Record<string, boolean>;
}

let api: FakeApi;
let originalWindow: unknown;

function metaOf(fileName: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    fileName,
    uuid: fileName,
    name: fileName,
    url: 'https://example.com',
    urls: ['https://example.com'],
    author: null,
    logo: null,
    description: null,
    enabled: true,
    sourceType: 'novel',
    version: '1.2.0',
    updateUrl: null,
    tags: [],
    minDelayMs: 0,
    requireUrls: [],
    sourceDir: '/userData/booksources',
    ...over,
  };
}

function installWindow(): void {
  (globalThis as unknown as { window: unknown }).window = {
    pomAPI: {
      booksourceList: async (): Promise<unknown[]> => {
        if (api.listThrows) throw new Error('主进程列表通道挂了');
        return api.list;
      },
      booksourceRead: async (fileName: string): Promise<string> => {
        if (api.readThrows[fileName]) throw new Error(`读不到 ${fileName}`);
        return api.files[fileName] ?? '';
      },
      booksourceConvert: async (
        jsFileName: string,
        json: string,
        sourceDir?: string,
      ): Promise<string> => {
        if (api.convertThrows[jsFileName]) throw new Error(`写盘失败: ${jsFileName}`);
        api.converted.push({ jsFileName, json, sourceDir });
        return jsFileName.replace(/\.js$/i, '.json');
      },
      booksourceArchive: async (jsFileName: string, reason: string, sourceDir?: string) => {
        api.archived.push({ jsFileName, reason, sourceDir });
        return jsFileName;
      },
      booksourceMigrationReportWrite: async (report: unknown): Promise<void> => {
        api.report = report;
      },
      booksourceMigrationReportRead: async (): Promise<unknown> => api.report,
    },
  };
}

beforeEach(() => {
  originalWindow = (globalThis as unknown as { window?: unknown }).window;
  api = {
    list: [],
    files: {},
    converted: [],
    archived: [],
    report: null,
    listThrows: false,
    readThrows: {},
    convertThrows: {},
  };
  installWindow();
});

afterEach(() => {
  (globalThis as unknown as { window?: unknown }).window = originalWindow;
  vi.restoreAllMocks();
});

describe('BookSourceMigrateService.migrate', () => {
  it('无 pomAPI（浏览器 dev）时直接返回 null，不报错', async () => {
    (globalThis as unknown as { window: unknown }).window = {};
    await expect(new BookSourceMigrateService().migrate()).resolves.toBeNull();
  });

  it('没有 .js 源时不返回报告、也不落报告文件', async () => {
    api.list = [metaOf('a.json', { format: 'json', uuid: 'a.json' })];
    await expect(new BookSourceMigrateService().migrate()).resolves.toBeNull();
    expect(api.report).toBeNull();
  });

  it('纯模板源被转换：产出 JSON + 走 convert 通道', async () => {
    api.list = [metaOf('a.js')];
    api.files['a.js'] = TEMPLATE_JS;
    const report = await new BookSourceMigrateService().migrate();
    expect(report?.converted).toHaveLength(1);
    expect(api.archived).toEqual([]);
    const written = JSON.parse(api.converted[0]!.json) as Record<string, unknown>;
    expect(written['uuid']).toBe('a.js');
    expect(written['format']).toBe('pomreader.booksource');
    // 落盘文本与渲染端约定同格式
    expect(api.converted[0]!.json).toBe(serializeSourceDoc(JSON.parse(api.converted[0]!.json)));
  });

  it('needs-manual 源：只归档、不产 JSON', async () => {
    api.list = [metaOf('a.js')];
    api.files['a.js'] = HANDEDIT_JS;
    const report = await new BookSourceMigrateService().migrate();
    expect(report?.needsManual).toHaveLength(1);
    expect(report?.needsManual[0]?.reason).toContain('myHack');
    expect(api.converted).toEqual([]);
    expect(api.archived[0]?.jsFileName).toBe('a.js');
  });

  it('同 uuid 的 JSON 已存在 → skip，且不碰任何文件', async () => {
    api.list = [metaOf('a.js'), metaOf('a.json', { format: 'json', uuid: 'a.js' })];
    api.files['a.js'] = TEMPLATE_JS;
    // 全是 skip = 什么都没变 → 不返回报告也不落盘（否则管理页会弹一个零条目的空窗）
    await expect(new BookSourceMigrateService().migrate()).resolves.toBeNull();
    expect(api.converted).toEqual([]);
    expect(api.archived).toEqual([]);
    expect(api.report).toBeNull();
  });

  it('skip 与真实迁移混合时，skipped 计入报告', async () => {
    api.list = [metaOf('a.js'), metaOf('a.json', { format: 'json', uuid: 'a.js' }), metaOf('b.js')];
    api.files['a.js'] = TEMPLATE_JS;
    api.files['b.js'] = TEMPLATE_JS;
    const report = await new BookSourceMigrateService().migrate();
    expect(report?.skipped).toBe(1);
    expect(report?.converted.map((i) => i.fileName)).toEqual(['b.js']);
  });

  it('一个源写盘失败不中断整批，失败项进 failed 且仍写报告', async () => {
    api.list = [metaOf('bad.js'), metaOf('good.js')];
    api.files['bad.js'] = TEMPLATE_JS;
    api.files['good.js'] = TEMPLATE_JS;
    api.convertThrows['bad.js'] = true;
    const report = await new BookSourceMigrateService().migrate();
    expect(report?.failed).toHaveLength(1);
    expect(report?.failed[0]?.reason).toContain('写盘失败');
    expect(report?.converted.map((i) => i.fileName)).toEqual(['good.js']);
  });

  it('读文件失败同样只记 failed，不抛出', async () => {
    api.list = [metaOf('a.js')];
    api.readThrows['a.js'] = true;
    const report = await new BookSourceMigrateService().migrate();
    expect(report?.failed[0]?.reason).toContain('读不到');
  });

  it('同批里两个 .js 撞同一 uuid：后者降级 skip，不覆盖先迁出的文档', async () => {
    api.list = [metaOf('dup.js'), metaOf('other.js', { uuid: 'dup.js' })];
    api.files['dup.js'] = TEMPLATE_JS;
    api.files['other.js'] = TEMPLATE_JS;
    const report = await new BookSourceMigrateService().migrate();
    expect(report?.converted).toHaveLength(1);
    expect(report?.skipped).toBe(1);
  });

  it('列表通道整体失败时返回 null（存量 .js 原样保留，用户照常可用）', async () => {
    api.listThrows = true;
    await expect(new BookSourceMigrateService().migrate()).resolves.toBeNull();
  });

  it('同一次启动只迁一遍（第二次调用直接返回上次结果）', async () => {
    api.list = [metaOf('a.js')];
    api.files['a.js'] = TEMPLATE_JS;
    const svc = new BookSourceMigrateService();
    await svc.migrate();
    await svc.migrate();
    expect(api.converted).toHaveLength(1);
  });
});

describe('BookSourceMigrateService.readReport', () => {
  it('无报告返回 null', async () => {
    api.report = null;
    await expect(new BookSourceMigrateService().readReport()).resolves.toBeNull();
  });

  it('坏形状的报告被归一成空数组（不抛，管理页不能因弹窗崩）', async () => {
    api.report = { converted: 'nope', needsManual: [{ nope: 1 }] };
    const r = (await new BookSourceMigrateService().readReport()) as MigrationReport;
    expect(r.converted).toEqual([]);
    expect(r.needsManual).toEqual([]);
    expect(r.skipped).toBe(0);
  });

  it('正常报告原样带回（含 jsonFileName）', async () => {
    api.report = {
      at: '2026-09-29T00:00:00.000Z',
      converted: [{ fileName: 'a.js', jsonFileName: 'a.json', reason: 'ok' }],
      needsManual: [],
      failed: [],
      skipped: 0,
    };
    const r = await new BookSourceMigrateService().readReport();
    expect(r?.converted[0]?.jsonFileName).toBe('a.json');
  });
});
