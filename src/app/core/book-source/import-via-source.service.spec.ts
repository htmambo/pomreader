/**
 * ImportViaSourceService · importByUrl bookSourceUuid 锚定测试
 *
 * 验证 importByUrl 返回 ImportByUrlResult { book, bookSourceUuid }（结构统一）：
 * - JsSourceAdapter 来源 → bookSourceUuid = meta.uuid（精确锚定）
 * - 内置 adapter（无 meta.uuid）/ 不传 sourceName / 空 uuid → UNIVERSAL_BOOK_SOURCE_UUID 兜底
 * - sourceName 指定但 match 失败 / 源不存在 → 抛 FetchError（不静默降级）
 */
import { describe, it, expect, vi } from 'vitest';
import { BookSourceAdapter, PageFetcher, ResolvedBook } from './book-source.adapter';
import { BookSourceRegistry } from './book-source.registry';
import { JsSourceAdapter } from './js-source/js-source.adapter';
import { BookSourceMeta } from './js-source/source-meta.types';
import { ImportViaSourceService } from './import-via-source.service';
import { UNIVERSAL_BOOK_SOURCE_UUID } from './book-source.constants';

function emptyFetcher(): PageFetcher {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { fetchHtml: async () => '', fetchRendered: async () => '' } as any;
}

/** mock 内置 adapter（match url，返回固定 ResolvedBook，避免 HeuristicAdapter 内部 catalog-empty 抛错） */
class StubAdapter implements BookSourceAdapter {
  constructor(
    public readonly name: string,
    public readonly meta?: { uuid?: string },
  ) {}
  match(): boolean { return true; }
  async fetchCatalog(): Promise<ResolvedBook> {
    return { title: 'stub book', author: 'stub', chapters: [{ title: 'ch1', url: 'http://a/1' }] };
  }
  async fetchChapter(): Promise<string> { return ''; }
}

describe('ImportViaSourceService · importByUrl bookSourceUuid 锚定', () => {
  it('指定 JsSourceAdapter 来源时，importByUrl 返回 { book, bookSourceUuid: meta.uuid }', async () => {
    const w = window as unknown as { pomAPI?: { booksourceRead: (fn: string) => Promise<string> } };
    const origPom = w.pomAPI;
    w.pomAPI = { booksourceRead: async () => 'function bookInfo(){};' };
    try {
      const reg = BookSourceRegistry.forTest(emptyFetcher());
      const meta: BookSourceMeta = {
        sourceKey: 'uuid-hetushu',
        uuid: 'uuid-hetushu',
        fileName: 'hetushu.js',
        name: 'hetushu',
        url: 'https://www.hetushu.com',
        urls: ['https://www.hetushu.com'],
        enabled: true, fileSize: 0, modifiedAt: 0, sourceDir: '',
        sourceType: 'novel', version: '1', tags: [], minDelayMs: 0, requireUrls: [],
      };
      const sandbox = {
        load: async () => ({ fileName: meta.fileName, fns: ['bookInfo'] }),
        call: async (_file: string, fn: string) => {
          if (fn === 'bookInfo') {
            return {
              name: '测试书',
              author: '测试作者',
              chapters: [{ name: '第1章', url: 'http://a/1' }],
            };
          }
          return null;
        },
      };
      const adapter = new JsSourceAdapter(meta, sandbox as never);
      reg.registerJsAdapter(adapter);

      const svc = ImportViaSourceService.forTest(reg, emptyFetcher());
      const result = await svc.importByUrl('https://www.hetushu.com/book/5763/', 'hetushu');
      expect(result.book.title).toBe('测试书');
      expect(result.bookSourceUuid).toBe('uuid-hetushu');
    } finally {
      if (origPom === undefined) delete w.pomAPI;
      else w.pomAPI = origPom;
    }
  });

  it('指定内置 adapter（无 meta.uuid）时，bookSourceUuid 返回 UNIVERSAL 兜底', async () => {
    const reg = BookSourceRegistry.forTest(emptyFetcher());
    reg.register(new StubAdapter('stub-no-uuid'));
    const svc = ImportViaSourceService.forTest(reg, emptyFetcher());
    const result = await svc.importByUrl('https://random.com/book/123/', 'stub-no-uuid');
    expect(result.book.title).toBe('stub book');
    expect(result.bookSourceUuid).toBe(UNIVERSAL_BOOK_SOURCE_UUID);
  });

  it('不传 sourceName 走 registry 自动 resolve：bookSourceUuid 同样为 UNIVERSAL', async () => {
    const reg = BookSourceRegistry.forTest(emptyFetcher());
    reg.register(new StubAdapter('stub-no-uuid'));
    const svc = ImportViaSourceService.forTest(reg, emptyFetcher());
    const result = await svc.importByUrl('https://random.com/book/123/');
    expect(result.book.title).toBe('stub book');
    expect(result.bookSourceUuid).toBe(UNIVERSAL_BOOK_SOURCE_UUID);
  });

  it('forTest 静态工厂：构造时跳过 inject（不抛 NG0203）', () => {
    const reg = BookSourceRegistry.forTest(emptyFetcher());
    const svc = ImportViaSourceService.forTest(reg, emptyFetcher());
    expect(svc).toBeDefined();
    vi.fn();
  });

  // ========== P0-1 / P0-2 回归 + 边界用例 ==========

  it('P0-1 回归：sourceName 指定但 match 失败抛 FetchError（不静默降级）', async () => {
    const reg = BookSourceRegistry.forTest(emptyFetcher());
    class NoMatchAdapter extends StubAdapter {
      override match(): boolean { return false; }
    }
    reg.register(new NoMatchAdapter('a-source'));
    const svc = ImportViaSourceService.forTest(reg, emptyFetcher());
    await expect(svc.importByUrl('https://example.com/book/', 'a-source'))
      .rejects.toMatchObject({ code: 'unsupported-source' });
  });

  it('P0-1 回归：sourceName 指定但 registry.get 找不到源抛 FetchError', async () => {
    const reg = BookSourceRegistry.forTest(emptyFetcher());
    const svc = ImportViaSourceService.forTest(reg, emptyFetcher());
    await expect(svc.importByUrl('https://example.com/book/', '不存在的源'))
      .rejects.toMatchObject({ code: 'unsupported-source' });
  });

  it('空 uuid 归一化为 UNIVERSAL（破损数据兜底）', async () => {
    const reg = BookSourceRegistry.forTest(emptyFetcher());
    class EmptyUuidAdapter extends StubAdapter {
      constructor() { super('empty-uuid', { uuid: '' }); }
    }
    reg.register(new EmptyUuidAdapter());
    const svc = ImportViaSourceService.forTest(reg, emptyFetcher());
    const result = await svc.importByUrl('https://example.com/book/', 'empty-uuid');
    expect(result.bookSourceUuid).toBe(UNIVERSAL_BOOK_SOURCE_UUID);
  });
});
