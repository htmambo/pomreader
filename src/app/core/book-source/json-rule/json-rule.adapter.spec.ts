/**
 * JsonRuleAdapter 单元测试（方案 §3.2 / P1）
 *
 * 用例面镜像 js-source.adapter.spec.ts（26 例）：假 RuleEngineService 替代
 * MockSandboxService，断言 adapter 行为与 JsSourceAdapter 一致。
 * 不依赖 Angular TestBed（adapter 手动 new，项目 vitest 直实例化模式）。
 */
import { describe, it, expect, vi } from 'vitest';
import { JsonRuleAdapter } from './json-rule.adapter';
import { FetchError } from '../fetch-error';
import { type BookSourceMeta } from '../source-meta.types';
import { type RuleEngineService } from './rule-engine.service';

/** 假 RuleEngineService：key = 入口名 → result；记录调用参数与次数 */
class MockRuleEngineService {
  bookInfoMock = vi.fn();
  chapterContentMock = vi.fn();
  chapterListMock = vi.fn();
  searchMock = vi.fn();
  results = new Map<string, unknown>();

  async bookInfo(meta: BookSourceMeta, url: string): Promise<unknown> {
    this.bookInfoMock(meta, url);
    return this.get('bookInfo');
  }
  async chapterContent(meta: BookSourceMeta, url: string): Promise<unknown> {
    this.chapterContentMock(meta, url);
    return this.get('chapterContent');
  }
  async chapterList(meta: BookSourceMeta, url: string): Promise<unknown> {
    this.chapterListMock(meta, url);
    return this.get('chapterList');
  }
  async search(meta: BookSourceMeta, kw: string, page: number): Promise<unknown> {
    this.searchMock(meta, kw, page);
    return this.get('search');
  }
  private get(key: string): unknown {
    if (!this.results.has(key)) throw new Error(`未配置：${key}`);
    return this.results.get(key);
  }
}

const meta: BookSourceMeta = {
  sourceKey: 'test-uuid',
  uuid: 'test-uuid',
  fileName: 'test.json',
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

function makeAdapter(): { adapter: JsonRuleAdapter; mock: MockRuleEngineService } {
  const mock = new MockRuleEngineService();
  mock.results.set('bookInfo', {
    title: '测试书',
    author: '测试作者',
    chapters: [{ name: '第1章', url: 'http://example.com/1' }],
  });
  mock.results.set('chapterContent', '正文内容...');
  const adapter = new JsonRuleAdapter(meta, mock as unknown as RuleEngineService);
  return { adapter, mock };
}

describe('JsonRuleAdapter', () => {
  it('match 按主机名命中（example.com 及其子域）', () => {
    const { adapter } = makeAdapter();
    expect(adapter.match('https://example.com/book/1')).toBe(true);
    expect(adapter.match('https://www.example.com/book/1')).toBe(true);
    expect(adapter.match('https://other.com/book/1')).toBe(false);
  });

  it('match 无 url/urls 时不命中', () => {
    const mock = new MockRuleEngineService();
    const noUrlMeta = { ...meta, url: '', urls: [] };
    const adapter = new JsonRuleAdapter(noUrlMeta, mock as unknown as RuleEngineService);
    expect(adapter.match('https://example.com/book/1')).toBe(false);
  });

  it('fetchCatalog 走 engineService.bookInfo，返回书名/作者/章节', async () => {
    const { adapter, mock } = makeAdapter();
    const r = await adapter.fetchCatalog('https://example.com/book/1', {} as never);
    expect(r.title).toBe('测试书');
    expect(r.author).toBe('测试作者');
    expect(r.chapters).toHaveLength(1);
    expect(r.chapters[0].title).toBe('第1章');
    expect(mock.bookInfoMock).toHaveBeenCalledWith(meta, 'https://example.com/book/1');
  });

  it('fetchChapter 走 engineService.chapterContent', async () => {
    const { adapter, mock } = makeAdapter();
    const text = await adapter.fetchChapter(
      { title: '第1章', url: 'https://example.com/1' },
      {} as never,
    );
    expect(text).toBe('正文内容...');
    expect(mock.chapterContentMock).toHaveBeenCalledWith(meta, 'https://example.com/1');
  });

  it('fetchChapter 非 string 返回空串', async () => {
    const { adapter, mock } = makeAdapter();
    mock.results.set('chapterContent', { weird: true });
    const text = await adapter.fetchChapter(
      { title: 'c', url: 'https://example.com/1' },
      {} as never,
    );
    expect(text).toBe('');
  });

  it('bookInfo 缺 chapters 抛 FetchError("parse-failed")', async () => {
    const { adapter, mock } = makeAdapter();
    mock.results.set('bookInfo', { title: '空书', author: 'x' });
    await expect(adapter.fetchCatalog('https://example.com', {} as never)).rejects.toThrow(
      FetchError,
    );
    await expect(adapter.fetchCatalog('https://example.com', {} as never)).rejects.toMatchObject({
      code: 'parse-failed',
    });
  });

  it('bookInfo 返回 null 抛 FetchError("parse-failed")', async () => {
    const { adapter, mock } = makeAdapter();
    mock.results.set('bookInfo', null);
    await expect(adapter.fetchCatalog('https://example.com', {} as never)).rejects.toMatchObject({
      code: 'parse-failed',
    });
  });

  // ========== fetchCatalog 字段 fallback 链（与 JsSourceAdapter 同一套约定） ==========

  it('fetchCatalog 标准 legado 字段 name/bookUrl 也能解析（不只 title/url）', async () => {
    const { adapter, mock } = makeAdapter();
    mock.results.set('bookInfo', {
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
    mock.results.set('bookInfo', {
      title: '备用字段',
      name: 'legado 标准字段',
      chapters: [{ title: 't1', name: 'legado 章名', url: 'https://a/1' }],
    });
    const r = await adapter.fetchCatalog('https://example.com', {} as never);
    expect(r.title).toBe('legado 标准字段');
    expect(r.chapters[0].title).toBe('legado 章名');
  });

  it('fetchCatalog kind/cover 走 fallback 链（引擎返回 category/cover → kind/coverImageUrl）', async () => {
    const { adapter, mock } = makeAdapter();
    mock.results.set('bookInfo', {
      title: '书',
      author: '作者',
      category: '玄幻',
      cover: 'https://example.com/cover.jpg',
      chapters: [],
    });
    const r = await adapter.fetchCatalog('https://example.com', {} as never);
    expect(r.kind).toBe('玄幻');
    expect(r.coverImageUrl).toBe('https://example.com/cover.jpg');
  });

  it('fetchCatalog 章节 url 缺省时为空字符串（不抛错）', async () => {
    const { adapter, mock } = makeAdapter();
    mock.results.set('bookInfo', {
      title: '测试',
      author: '作者',
      chapters: [{ name: 'no-url chapter' }],
    });
    const r = await adapter.fetchCatalog('https://example.com', {} as never);
    expect(r.chapters[0]).toEqual({ title: 'no-url chapter', url: '' });
  });

  it('每次入口调用都经 service（无实例级缓存，改完立即生效）', async () => {
    const { adapter, mock } = makeAdapter();
    await adapter.fetchCatalog('https://example.com', {} as never);
    mock.results.set('bookInfo', {
      title: '改后的书',
      author: 'x',
      chapters: [{ name: '1', url: 'http://a' }],
    });
    const r = await adapter.fetchCatalog('https://example.com', {} as never);
    expect(mock.bookInfoMock).toHaveBeenCalledTimes(2);
    expect(r.title).toBe('改后的书');
  });

  // ========== search() duck-typed 入口 ==========

  it('search() 委托引擎并返回规范化后的数组（bookUrl → url）', async () => {
    const { adapter, mock } = makeAdapter();
    mock.results.set('search', [
      { name: '庆余年', author: '猫腻', kind: '架空', bookUrl: 'https://example.com/book/5' },
      { name: '赘婿', author: '愤怒的香蕉', kind: '', bookUrl: 'https://example.com/book/6' },
    ]);
    const items = await adapter.search('网文');
    expect(items).toEqual([
      { name: '庆余年', author: '猫腻', kind: '架空', url: 'https://example.com/book/5' },
      { name: '赘婿', author: '愤怒的香蕉', url: 'https://example.com/book/6' },
    ]);
    expect(mock.searchMock).toHaveBeenCalledWith(meta, '网文', 1);
  });

  it('search() 兼容 legado 多种字段命名（title/url/description 兜底）', async () => {
    const { adapter, mock } = makeAdapter();
    mock.results.set('search', [
      { title: '标准书名', bookUrl: 'https://a/1', description: '用 description' },
      { name: '现代书名', url: 'https://a/2', intro: '用 intro' },
    ]);
    const items = await adapter.search('kw');
    expect(items[0]).toEqual({ name: '标准书名', url: 'https://a/1', intro: '用 description' });
    expect(items[1]).toEqual({ name: '现代书名', url: 'https://a/2', intro: '用 intro' });
  });

  it('search() 引擎抛错时透传错误并打 console.warn', async () => {
    const { adapter } = makeAdapter();
    // 不预设 search 结果 → mock 抛 '未配置' 错误
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(adapter.search('kw')).rejects.toThrow('未配置');
    expect(warnSpy).toHaveBeenCalled();
    const msg = String(warnSpy.mock.calls[0]?.[0] ?? '');
    expect(msg).toContain('[JsonRuleAdapter]');
    expect(msg).toContain('测试书源');
    expect(msg).toContain('search 失败');
    warnSpy.mockRestore();
  });

  it('search() 非数组返回兜底为 []', async () => {
    const { adapter, mock } = makeAdapter();
    mock.results.set('search', { name: 'not an array' });
    expect(await adapter.search('kw')).toEqual([]);
  });

  it('search() 空关键词（trim 后空）直接返回 [] 不调引擎', async () => {
    const { adapter, mock } = makeAdapter();
    expect(await adapter.search('')).toEqual([]);
    expect(await adapter.search('   ')).toEqual([]);
    expect(await adapter.search(undefined as unknown as string)).toEqual([]);
    expect(mock.searchMock).not.toHaveBeenCalled();
  });

  it('search() page 缺省默认 1 / 显式传入按传入值', async () => {
    const { adapter, mock } = makeAdapter();
    mock.results.set('search', []);
    await adapter.search('kw');
    expect(mock.searchMock).toHaveBeenCalledWith(meta, 'kw', 1);
    await adapter.search('kw', 3);
    expect(mock.searchMock).toHaveBeenCalledWith(meta, 'kw', 3);
  });

  it('search() page=0 / -1 / 1.5 兜底为 1', async () => {
    const { adapter, mock } = makeAdapter();
    mock.results.set('search', []);
    await adapter.search('kw', 0);
    await adapter.search('kw', -1);
    await adapter.search('kw', 1.5);
    for (const call of mock.searchMock.mock.calls) {
      expect(call[2]).toBe(1);
    }
  });

  it('search() 结果截断（>100 条只取前 100）', async () => {
    const { adapter, mock } = makeAdapter();
    const big = Array.from({ length: 150 }, (_, i) => ({
      name: `书${i}`,
      bookUrl: `https://a/${i}`,
    }));
    mock.results.set('search', big);
    const items = await adapter.search('kw');
    expect(items).toHaveLength(100);
    expect(items[0].name).toBe('书0');
    expect(items[99].name).toBe('书99');
  });

  it('search() 全空条目 [{}] / [{name:""}] 过滤为 []', async () => {
    const { adapter, mock } = makeAdapter();
    mock.results.set('search', [{}, { name: '' }, { name: '   ' }, { title: '' }]);
    expect(await adapter.search('kw')).toEqual([]);
  });

  it('search() 混合全空 + 正常条目：只保留正常条目', async () => {
    const { adapter, mock } = makeAdapter();
    mock.results.set('search', [
      {},
      { name: '正常书', bookUrl: 'http://a/1' },
      { title: '', url: '' },
    ]);
    expect(await adapter.search('kw')).toEqual([{ name: '正常书', url: 'http://a/1' }]);
  });

  it('search() pickString trim 后空字符串视为无值', async () => {
    const { adapter, mock } = makeAdapter();
    mock.results.set('search', [
      { name: '  有效书名  ', author: '  作者  ', bookUrl: '  http://a/1  ' },
    ]);
    expect(await adapter.search('kw')).toEqual([
      { name: '有效书名', author: '作者', url: 'http://a/1' },
    ]);
  });

  it('search() 非字符串字段（数字/布尔）跳过，fallback 到下一 key', async () => {
    const { adapter, mock } = makeAdapter();
    mock.results.set('search', [{ name: 123, bookUrl: true, author: null }]);
    expect(await adapter.search('kw')).toEqual([]);
  });
});
