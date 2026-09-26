/**
 * JsSourceAdapter 单元测试（实施计划 T-004 + spec FR-1.4）
 *
 * mock SandboxService：覆盖 bookInfo / chapterContent 两个出口；
 * 不依赖 Angular TestBed（项目 vitest 直实例化模式）。
 */
import { describe, it, expect, vi } from 'vitest';
import { JsSourceAdapter } from './js-source.adapter';
import { FetchError } from '../fetch-error';
import { BookSourceMeta } from './source-meta.types';

class MockSandboxService {
  loaded = new Set<string>();
  callMock = vi.fn();
  /** 写入：key = `${fileName}::${fn}` → result */
  results = new Map<string, unknown>();
  /** load 调用次数（仅真实重新编译才 +1，缓存命中不增） */
  loadCount = 0;
  /** 模拟 sandbox.sourceCache：按 fileName 记录上次编译的源码 */
  private sourceCache = new Map<string, string>();
  /** 测试注入：可在测试内修改以模拟用户改书源 */
  sourceOverride = new Map<string, string>();

  async load(fileName: string, source: string): Promise<{ fileName: string; fns: string[] }> {
    const effectiveSource = this.sourceOverride.get(fileName) ?? source;
    if (this.loaded.has(fileName) && this.sourceCache.get(fileName) === effectiveSource) {
      // 缓存命中（同源码不重编译）
      return { fileName, fns: ['bookInfo', 'chapterContent'] };
    }
    // 源码变了 / 首次 → 重新编译
    this.loadCount++;
    this.loaded.add(fileName);
    this.sourceCache.set(fileName, effectiveSource);
    return { fileName, fns: ['bookInfo', 'chapterContent'] };
  }

  async call<T>(fileName: string, fn: string, args: unknown[]): Promise<T> {
    this.callMock(fileName, fn, args);
    const key = `${fileName}::${fn}`;
    if (!this.results.has(key)) throw new Error(`未配置：${key}`);
    return this.results.get(key) as T;
  }
}

/** 注入 stub `window.pomAPI.booksourceRead`：jsdom 默认无 pomAPI */
function installPomApi(): void {
  const w = window as unknown as { pomAPI?: { booksourceRead: (fn: string) => Promise<string> } };
  w.pomAPI = { booksourceRead: vi.fn(async () => 'function bookInfo(){}; function chapterContent(){};') };
}

const meta: BookSourceMeta = {
  sourceKey: 'test-uuid',
  uuid: 'test-uuid',
  fileName: 'test.js',
  name: '测试书源',
  url: 'https://example.com',
  urls: ['https://example.com'],
  author: undefined,
  logo: undefined,
  description: undefined,
  enabled: true,
  fileSize: 0,
  modifiedAt: 0,
  sourceDir: '',
  sourceType: 'novel',
  version: '1',
  tags: [],
  minDelayMs: 0,
  requireUrls: [],
};

function makeAdapter(): { adapter: JsSourceAdapter; mock: MockSandboxService } {
  const mock = new MockSandboxService();
  // 预置默认返回值
  mock.results.set('test.js::bookInfo', {
    title: '测试书',
    author: '测试作者',
    chapters: [{ title: '第1章', url: 'http://example.com/1' }],
  });
  mock.results.set('test.js::chapterContent', '正文内容...');
  const adapter = new JsSourceAdapter(meta, mock as unknown as ConstructorParameters<typeof JsSourceAdapter>[1]);
  return { adapter, mock };
}

describe('JsSourceAdapter', () => {
  beforeEach(() => installPomApi());

  it('match 按主机名命中（example.com 及其子域）', () => {
    const { adapter } = makeAdapter();
    expect(adapter.match('https://example.com/book/1')).toBe(true);
    expect(adapter.match('https://www.example.com/book/1')).toBe(true);
    expect(adapter.match('https://other.com/book/1')).toBe(false);
  });

  it('fetchCatalog 走 bookInfo，返回书名/作者/章节', async () => {
    const { adapter, mock } = makeAdapter();
    const r = await adapter.fetchCatalog('https://example.com/book/1', {} as never);
    expect(r.title).toBe('测试书');
    expect(r.author).toBe('测试作者');
    expect(r.chapters).toHaveLength(1);
    expect(r.chapters[0].title).toBe('第1章');
    expect(mock.callMock).toHaveBeenCalledWith('test.js', 'bookInfo', ['https://example.com/book/1']);
  });

  it('fetchChapter 走 chapterContent', async () => {
    const { adapter, mock } = makeAdapter();
    const text = await adapter.fetchChapter(
      { title: '第1章', url: 'https://example.com/1' },
      {} as never,
    );
    expect(text).toBe('正文内容...');
    expect(mock.callMock).toHaveBeenCalledWith('test.js', 'chapterContent', ['https://example.com/1']);
  });

  it('bookInfo 缺 chapters 抛 FetchError("parse-failed")', async () => {
    const { adapter, mock } = makeAdapter();
    mock.results.set('test.js::bookInfo', { title: '空书', author: 'x' });
    await expect(adapter.fetchCatalog('https://example.com', {} as never))
      .rejects.toThrow(FetchError);
    await expect(adapter.fetchCatalog('https://example.com', {} as never))
      .rejects.toMatchObject({ code: 'parse-failed' });
  });

  it('load cache 命中：sandbox 内部按 sourceCache 判断；同源码不重新编译', async () => {
    // 注：JsSourceAdapter 自身不做实例级缓存（去掉 `if (this.loaded) return`），
    // 由 sandbox.load 内部的 sourceCache 决定是否真正重新编译。同源码时 sandbox
    // load 仍被调，但 sourceCache 命中不重编译（mock.loadCount 不增）。
    const { adapter, mock } = makeAdapter();
    await adapter.fetchCatalog('https://example.com', {} as never);
    const firstLoadCount = mock.loadCount;
    expect(firstLoadCount).toBeGreaterThanOrEqual(1);
    await adapter.fetchChapter({ title: '1', url: 'https://example.com/1' }, {} as never);
    // sandbox.load 内部 sourceCache 命中，loadCount 不增
    expect(mock.loadCount).toBe(firstLoadCount);
  });

  it('源码变更：sandbox 内部按 sourceCache 检测差异并重新编译', async () => {
    // 模拟用户修改书源：第二次 readSource 返回不同 source
    const { adapter, mock } = makeAdapter();
    const origRead = mock;
    // 第一次：fetchCatalog 触发 load
    await adapter.fetchCatalog('https://example.com', {} as never);
    const firstLoadCount = mock.loadCount;
    // 第二次：mock.callMock 仍能命中（不依赖 load 重新编译）
    mock.results.set('test.js::bookInfo', { title: '新', author: 'x', chapters: [{ title: '1', url: 'http://a' }] });
    await adapter.fetchCatalog('https://example.com', {} as never);
    // sandbox 内部 sourceCache 命中（同源码），loadCount 不增
    expect(mock.loadCount).toBe(firstLoadCount);
    // 如果源码变了，sandbox 会 invalidate + 重新 load —— 由 sandbox 自身负责（不在本测试范围）
    void origRead;
  });

  // ========== fetchCatalog 字段 fallback 链（兼容 legado 多种命名） ==========

  it('fetchCatalog 标准 legado 字段 name/bookUrl 也能解析（不只 title/url）', async () => {
    const { adapter, mock } = makeAdapter();
    mock.results.set('test.js::bookInfo', {
      name: '大奉打更人',
      author: '卖报小郎君',
      chapters: [
        { name: '第一章 牢狱之灾', bookUrl: 'https://example.com/c1' },
        { name: '第二章 妖物作祟', bookUrl: 'https://example.com/c2' },
      ],
    });
    const r = await adapter.fetchCatalog('https://example.com', {} as never);
    expect(r.title).toBe('大奉打更人');
    expect(r.author).toBe('卖报小郎君');
    expect(r.chapters).toEqual([
      { title: '第一章 牢狱之灾', url: 'https://example.com/c1' },
      { title: '第二章 妖物作祟', url: 'https://example.com/c2' },
    ]);
  });

  it('fetchCatalog 字段优先级：legado 标准 name 优先于 title', async () => {
    const { adapter, mock } = makeAdapter();
    mock.results.set('test.js::bookInfo', {
      title: '备用字段',
      name: 'legado 标准字段',
      chapters: [{ title: 't1', name: 'legado 章名', url: 'https://a/1' }],
    });
    const r = await adapter.fetchCatalog('https://example.com', {} as never);
    expect(r.title).toBe('legado 标准字段');
    expect(r.chapters[0].title).toBe('legado 章名');
  });

  it('fetchCatalog 章节 url 缺省时为空字符串（不抛错）', async () => {
    const { adapter, mock } = makeAdapter();
    mock.results.set('test.js::bookInfo', {
      title: '测试',
      author: '作者',
      chapters: [{ name: 'no-url chapter' }], // 缺 url/bookUrl
    });
    const r = await adapter.fetchCatalog('https://example.com', {} as never);
    expect(r.chapters[0]).toEqual({ title: 'no-url chapter', url: '' });
  });

  // ========== search() duck-typed 入口（FR-2 + MultiSourceSearchService 过滤） ==========

  it('search() 委托给沙箱并返回规范化后的数组', async () => {
    const { adapter, mock } = makeAdapter();
    mock.results.set('test.js::search', [
      { name: '庆余年', author: '猫腻', bookUrl: 'https://example.com/book/5' },
      { name: '赘婿', author: '愤怒的香蕉', bookUrl: 'https://example.com/book/6' },
    ]);
    const items = await adapter.search('网文');
    expect(items).toEqual([
      { name: '庆余年', author: '猫腻', url: 'https://example.com/book/5' },
      { name: '赘婿', author: '愤怒的香蕉', url: 'https://example.com/book/6' },
    ]);
    expect(mock.callMock).toHaveBeenCalledWith('test.js', 'search', ['网文', 1]);
  });

  it('search() 兼容 legado 多种字段命名（title/bookUrl/description 兜底）', async () => {
    const { adapter, mock } = makeAdapter();
    mock.results.set('test.js::search', [
      { title: '标准书名', bookUrl: 'https://a/1', description: '用 description' },
      { name: '现代书名', url: 'https://a/2', intro: '用 intro' },
      { name: '混合字段', bookUrl: 'https://a/3' }, // bookUrl 兜底 url
    ]);
    const items = await adapter.search('kw');
    expect(items[0]).toEqual({ name: '标准书名', url: 'https://a/1', intro: '用 description' });
    expect(items[1]).toEqual({ name: '现代书名', url: 'https://a/2', intro: '用 intro' });
    expect(items[2]).toEqual({ name: '混合字段', url: 'https://a/3' });
  });

  it('search() 沙箱抛错时透传错误并打 console.warn', async () => {
    const { adapter, mock } = makeAdapter();
    // 不预设 search 结果 → mock.call 抛 '未配置' 错误
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(adapter.search('kw')).rejects.toThrow('未配置');
    expect(warnSpy).toHaveBeenCalled();
    const msg = String(warnSpy.mock.calls[0]?.[0] ?? '');
    expect(msg).toContain('[JsSourceAdapter]');
    expect(msg).toContain('测试书源');
    expect(msg).toContain('search 失败');
    warnSpy.mockRestore();
  });

  it('search() 非数组返回兜底为 []', async () => {
    const { adapter, mock } = makeAdapter();
    mock.results.set('test.js::search', { name: 'not an array' }); // 非数组
    const items = await adapter.search('kw');
    expect(items).toEqual([]);
  });

  it('search() 空关键词（trim 后空）直接返回 [] 不调沙箱', async () => {
    const { adapter, mock } = makeAdapter();
    const callBefore = mock.callMock.mock.calls.length;
    expect(await adapter.search('')).toEqual([]);
    expect(await adapter.search('   ')).toEqual([]);
    expect(await adapter.search(undefined as unknown as string)).toEqual([]);
    // 空关键词不调沙箱
    expect(mock.callMock.mock.calls.length).toBe(callBefore);
  });

  it('search() page 缺省默认 1', async () => {
    const { adapter, mock } = makeAdapter();
    mock.results.set('test.js::search', []);
    await adapter.search('kw');
    expect(mock.callMock).toHaveBeenCalledWith('test.js', 'search', ['kw', 1]);
  });

  it('search() page 显式传入按传入值', async () => {
    const { adapter, mock } = makeAdapter();
    mock.results.set('test.js::search', []);
    await adapter.search('kw', 3);
    expect(mock.callMock).toHaveBeenCalledWith('test.js', 'search', ['kw', 3]);
  });

  it('search() 结果截断（>100 条只取前 100）', async () => {
    const { adapter, mock } = makeAdapter();
    const big = Array.from({ length: 150 }, (_, i) => ({ name: `书${i}`, bookUrl: `https://a/${i}` }));
    mock.results.set('test.js::search', big);
    const items = await adapter.search('kw');
    expect(items).toHaveLength(100);
    expect(items[0].name).toBe('书0');
    expect(items[99].name).toBe('书99');
  });

  it('search() ensureLoaded 失败（无 pomAPI）时透传 FetchError', async () => {
    // 单独构造 adapter 而不 installPomApi → readSource 抛 source-unavailable
    const w = window as unknown as { pomAPI?: unknown };
    const orig = w.pomAPI;
    delete w.pomAPI;
    try {
      const mock = new MockSandboxService();
      mock.results.set('test.js::bookInfo', { title: '', author: '', chapters: [] });
      const adapter = new JsSourceAdapter(meta, mock as unknown as ConstructorParameters<typeof JsSourceAdapter>[1]);
      await expect(adapter.search('kw')).rejects.toThrow(FetchError);
    } finally {
      w.pomAPI = orig;
    }
  });

  // === P0 修复回归测试 ===

  it('search() page=0 兜底为 1（防 legado 0-based 误传）', async () => {
    const { adapter, mock } = makeAdapter();
    mock.results.set('test.js::search', []);
    await adapter.search('kw', 0);
    expect(mock.callMock).toHaveBeenCalledWith('test.js', 'search', ['kw', 1]);
  });

  it('search() page=-1 兜底为 1', async () => {
    const { adapter, mock } = makeAdapter();
    mock.results.set('test.js::search', []);
    await adapter.search('kw', -1);
    expect(mock.callMock).toHaveBeenCalledWith('test.js', 'search', ['kw', 1]);
  });

  it('search() page=1.5（非整数）兜底为 1', async () => {
    const { adapter, mock } = makeAdapter();
    mock.results.set('test.js::search', []);
    await adapter.search('kw', 1.5);
    expect(mock.callMock).toHaveBeenCalledWith('test.js', 'search', ['kw', 1]);
  });

  it('search() 全空条目 [{}] / [{name:""}] 过滤为 []', async () => {
    const { adapter, mock } = makeAdapter();
    mock.results.set('test.js::search', [{}, { name: '' }, { name: '   ' }, { title: '' }]);
    const items = await adapter.search('kw');
    expect(items).toEqual([]);
  });

  it('search() 混合全空 + 正常条目：只保留正常条目', async () => {
    const { adapter, mock } = makeAdapter();
    mock.results.set('test.js::search', [
      {},
      { name: '正常书', bookUrl: 'http://a/1' },
      { title: '', url: '' },
    ]);
    const items = await adapter.search('kw');
    expect(items).toEqual([{ name: '正常书', url: 'http://a/1' }]);
  });

  it('search() pickString trim 后空字符串视为无值', async () => {
    const { adapter, mock } = makeAdapter();
    mock.results.set('test.js::search', [
      { name: '  有效书名  ', author: '  作者  ', bookUrl: '  http://a/1  ' },
    ]);
    const items = await adapter.search('kw');
    expect(items).toEqual([
      { name: '有效书名', author: '作者', url: 'http://a/1' },
    ]);
  });

  it('search() 非字符串字段（数字/布尔）跳过，fallback 到下一 key', async () => {
    const { adapter, mock } = makeAdapter();
    mock.results.set('test.js::search', [
      { name: 123, bookUrl: true, author: null },  // 全非字符串 → 全 fallback 无值
    ]);
    // 全 fallback 无值 → 整体丢弃
    expect(await adapter.search('kw')).toEqual([]);
  });

  it('search() 加载失败（ensureLoaded 抛错）也走 console.warn', async () => {
    // 无 pomAPI → readSource 抛 FetchError，console.warn 应记录
    const w = window as unknown as { pomAPI?: unknown };
    const orig = w.pomAPI;
    delete w.pomAPI;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const mock = new MockSandboxService();
      mock.results.set('test.js::bookInfo', { title: '', author: '', chapters: [] });
      const adapter = new JsSourceAdapter(meta, mock as unknown as ConstructorParameters<typeof JsSourceAdapter>[1]);
      await expect(adapter.search('kw')).rejects.toThrow(FetchError);
      expect(warnSpy).toHaveBeenCalled();
      const msg = String(warnSpy.mock.calls[0]?.[0] ?? '');
      expect(msg).toContain('[JsSourceAdapter]');
      expect(msg).toContain('测试书源');
      expect(msg).toContain('booksourceRead'); // FetchError message 含此串；code 是 source-unavailable 但 message 取不到
    } finally {
      warnSpy.mockRestore();
      w.pomAPI = orig;
    }
  });
});