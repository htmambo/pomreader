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
  /** load 调用次数（验证 cache 命中） */
  loadCount = 0;

  async load(fileName: string, _source: string): Promise<{ fileName: string; fns: string[] }> {
    this.loadCount++;
    this.loaded.add(fileName);
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

  it('load cache 命中：第二次 ensureLoaded 不再调 sandbox.load', async () => {
    const { adapter, mock } = makeAdapter();
    await adapter.fetchCatalog('https://example.com', {} as never);
    expect(mock.loadCount).toBe(1);
    await adapter.fetchChapter({ title: '1', url: 'https://example.com/1' }, {} as never);
    expect(mock.loadCount).toBe(1); // 不再 +1
  });
});