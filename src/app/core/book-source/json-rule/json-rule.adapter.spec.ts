/**
 * 规则书源适配器单测（P1.5）
 *
 * 断言的是**对外契约**（`BookSourceAdapter` / `RawSearchItem`），不是引擎内部行为 ——
 * 引擎语义由 `engine.spec.ts` 与差分基座负责。
 */
import { describe, it, expect, vi } from 'vitest';
import { JsonRuleAdapter } from './json-rule.adapter';
import { extractMetaUuid, hasMetaUuid } from '../book-source.adapter';
import type { BookSourceDoc } from '../../models/book-source-doc.model';
import type { RuleEngine } from './engine';

function makeDoc(overrides: Partial<BookSourceDoc> = {}): BookSourceDoc {
  return {
    format: 'pomreader.booksource',
    schemaVersion: 1,
    uuid: 'source-uuid',
    name: '示例书源',
    homepage: 'https://example.com',
    urls: ['https://example.com'],
    enabled: true,
    sourceType: 'novel',
    headers: {},
    rules: {
      siteName: '示例站点',
      searchPath: '/search?q={keyword}',
      searchItemPattern: 'ul.list li',
      bookTitlePattern: 'h1',
      bookAuthorPattern: 'css:.author',
      chapterItemPattern: 'ul.chapter-list a',
      contentPattern: 'div#content',
    },
    ...overrides,
  };
}

/** 假引擎：只记录被调用的入口，按用例给返回 */
function fakeEngine(partial: Partial<RuleEngine> = {}): RuleEngine {
  return {
    search: async () => [],
    bookInfo: async () => ({ title: '', author: '', category: '', cover: '', chapters: [] }),
    chapterList: async () => [],
    chapterContent: async () => '',
    ...partial,
  };
}

describe('身份与匹配', () => {
  it('meta.uuid 可被 registry 的 duck-typing 工具读到', () => {
    const a = new JsonRuleAdapter(makeDoc(), () => fakeEngine());
    expect(extractMetaUuid(a)).toBe('source-uuid');
    expect(hasMetaUuid(a)).toBe(true);
  });

  it('name 缺省回退到 uuid（与旧适配器 name → fileName 的回退方向一致）', () => {
    const a = new JsonRuleAdapter(makeDoc({ name: '' }), () => fakeEngine());
    expect(a.name).toBe('source-uuid');
  });

  it('按第一个 @url 匹配主机名，含子域、忽略 www.', () => {
    const a = new JsonRuleAdapter(makeDoc(), () => fakeEngine());
    expect(a.match('https://example.com/book/1')).toBe(true);
    expect(a.match('https://www.example.com/book/1')).toBe(true);
    expect(a.match('https://m.example.com/x')).toBe(true);
    expect(a.match('https://other.test/book/1')).toBe(false);
  });

  it('urls 为空时回退 homepage 建匹配', () => {
    const a = new JsonRuleAdapter(makeDoc({ urls: [] }), () => fakeEngine());
    expect(a.match('https://example.com/')).toBe(true);
  });

  it('主机名非法时 match 恒 false（不抛，交给启发式兜底）', () => {
    const a = new JsonRuleAdapter(makeDoc({ urls: ['not a url'], homepage: 'also bad' }), () =>
      fakeEngine(),
    );
    expect(a.match('https://example.com/')).toBe(false);
  });
});

describe('fetchCatalog → ResolvedBook', () => {
  it('引擎字段直映射，缺省文案与旧适配器一致', async () => {
    const a = new JsonRuleAdapter(makeDoc(), () =>
      fakeEngine({
        bookInfo: async () => ({
          title: '',
          author: '',
          category: '',
          cover: '',
          chapters: [{ name: '', url: '' }],
        }),
      }),
    );
    const book = await a.fetchCatalog('https://example.com/book/1', {} as never);
    expect(book).toEqual({
      title: '示例书源',
      author: '未知',
      kind: undefined,
      coverImageUrl: undefined,
      chapters: [{ title: '未知章节', url: '' }],
    });
  });

  it('category → kind、cover → coverImageUrl', async () => {
    const a = new JsonRuleAdapter(makeDoc(), () =>
      fakeEngine({
        bookInfo: async () => ({
          title: '书名',
          author: '作者',
          category: '玄幻',
          cover: 'https://example.com/c.jpg',
          chapters: [{ name: '第一章', url: 'https://example.com/c/1' }],
        }),
      }),
    );
    const book = await a.fetchCatalog('https://example.com/book/1', {} as never);
    expect(book.title).toBe('书名');
    expect(book.kind).toBe('玄幻');
    expect(book.coverImageUrl).toBe('https://example.com/c.jpg');
    expect(book.chapters).toEqual([{ title: '第一章', url: 'https://example.com/c/1' }]);
  });

  it('引擎没给 chapters → 抛 parse-failed（响亮失败，不返回空目录）', async () => {
    const a = new JsonRuleAdapter(makeDoc(), () =>
      fakeEngine({ bookInfo: async () => ({ ...({} as never), chapters: undefined }) }),
    );
    await expect(a.fetchCatalog('https://example.com/book/1', {} as never)).rejects.toThrow(
      /chapters/,
    );
  });
});

describe('fetchChapter', () => {
  it('返回引擎正文', async () => {
    const a = new JsonRuleAdapter(makeDoc(), () =>
      fakeEngine({ chapterContent: async () => '正文' }),
    );
    expect(
      await a.fetchChapter({ title: '第一章', url: 'https://example.com/c/1' }, {} as never),
    ).toBe('正文');
  });
});

describe('search（duck-typed 聚合入口）', () => {
  it('空白关键词直接返回 []，不建引擎不请求', async () => {
    const factory = vi.fn(() => fakeEngine());
    const a = new JsonRuleAdapter(makeDoc(), factory);
    expect(await a.search('   ')).toEqual([]);
    expect(factory).not.toHaveBeenCalled();
  });

  it('页码非正整数兜底为 1', async () => {
    const search = vi.fn(async () => []);
    const a = new JsonRuleAdapter(makeDoc(), () => fakeEngine({ search }));
    await a.search('kw', 0);
    await a.search('kw', -3);
    await a.search('kw', 1.5);
    expect(search.mock.calls.map((c) => c[1])).toEqual([1, 1, 1]);
  });

  it('字段映射：kind 落到 kind、author 落到 author，空串归一成 undefined', async () => {
    const a = new JsonRuleAdapter(makeDoc(), () =>
      fakeEngine({
        search: async () => [{ name: '书一', author: '甲', kind: '玄幻', bookUrl: '/book/1' }],
      }),
    );
    const items = await a.search('kw');
    expect(items).toEqual([{ name: '书一', url: '/book/1', author: '甲', kind: '玄幻' }]);
  });

  it('丢弃「名字与链接都为空」的幽灵条目', async () => {
    const a = new JsonRuleAdapter(makeDoc(), () =>
      fakeEngine({
        search: async () => [
          { name: '  ', author: '', kind: '', bookUrl: '' },
          { name: '书一', author: '', kind: '', bookUrl: '/book/1' },
        ],
      }),
    );
    expect(await a.search('kw')).toHaveLength(1);
  });

  it('截断到 100 条（对齐旧适配器 MAX_SEARCH_RESULTS）', async () => {
    const a = new JsonRuleAdapter(makeDoc(), () =>
      fakeEngine({
        search: async () =>
          Array.from({ length: 130 }, (_, i) => ({
            name: `书${i}`,
            author: '',
            kind: '',
            bookUrl: `/b/${i}`,
          })),
      }),
    );
    expect(await a.search('kw')).toHaveLength(100);
  });

  it('引擎抛错时向上抛（由调用方 allSettled 隔离），并留日志', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = new JsonRuleAdapter(makeDoc(), () =>
      fakeEngine({
        search: async () => {
          throw new Error('引擎炸了');
        },
      }),
    );
    await expect(a.search('kw')).rejects.toThrow('引擎炸了');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('每次调用都现造引擎（改完 JSON 立即生效，与旧适配器语义一致）', () => {
  it('两次 search 会各自取一次工厂', async () => {
    const factory = vi.fn(() => fakeEngine());
    const a = new JsonRuleAdapter(makeDoc(), factory);
    await a.search('kw');
    await a.search('kw');
    expect(factory).toHaveBeenCalledTimes(2);
  });
});
