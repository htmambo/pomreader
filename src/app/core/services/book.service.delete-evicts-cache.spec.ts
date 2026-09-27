import { describe, it, expect, beforeEach } from 'vitest';
import { Book } from '../models/book.model';
import { Chapter } from '../models/chapter.model';
import { BookService } from './book.service';
import { BookSourceRegistry } from '../book-source/book-source.registry';
import { BookSourceAdapter, PageFetcher, ResolvedBook } from '../book-source/book-source.adapter';
import { ImportViaSourceService } from '../book-source/import-via-source.service';

/**
 * Phase 4 R6-2 / commit 031ce1a hardening：
 *   BookService.deleteBook 必须调用 ChapterLoader.evictCache(bookId)
 *   防止已删除书的章节残留在 loader 缓存中
 *
 * 本 spec 锁定此调用契约（vs 单独测试 ChapterLoader.evictCache）：
 *   - 单独 spec 验证 evictCache 工作 → 已有（chapter-loader.spec.ts）
 *   - 本 spec 验证 BookService.deleteBook 链路触发 evictCache
 */

function emptyFetcher(): PageFetcher {
  return { fetchHtml: async () => '', fetchRendered: async () => '' };
}

class StubAdapter implements BookSourceAdapter {
  constructor(public readonly name: string) {}
  match(): boolean {
    return true;
  }
  async fetchCatalog(): Promise<ResolvedBook> {
    return { title: 'stub', author: 'stub', chapters: [] };
  }
  async fetchChapter(): Promise<string> {
    return '';
  }
}

function makeBook(overrides: Partial<Book> = {}): Book {
  return {
    id: 'book-1',
    title: 'Test',
    author: 'Author',
    chapterCount: 1,
    totalChars: 100,
    importedAt: '2026-01-01T00:00:00Z',
    source: 'online',
    sourceUrl: 'http://test/1',
    ...overrides,
  };
}

function makeChapters(bookId: string, count: number): Chapter[] {
  return Array.from({ length: count }, (_, i) => ({
    bookId,
    index: i,
    title: `ch${i + 1}`,
    content: `content ${i + 1}`,
    loaded: true,
  }));
}

describe('BookService.deleteBook → ChapterLoader.evictCache 联动契约', () => {
  let fakeDb: {
    bookPut: (b: Book) => Promise<void>;
    bookDelete: (id: string) => Promise<void>;
    chapterPutMany: (chs: Chapter[]) => Promise<void>;
    chapterAll: (id: string) => Promise<Chapter[]>;
  };
  let svc: BookService;
  let evictCalls: string[];

  beforeEach(() => {
    evictCalls = [];
    fakeDb = {
      bookPut: async () => undefined,
      bookDelete: async () => undefined,
      chapterPutMany: async () => undefined,
      chapterAll: async () => [],
    };
    const registry = BookSourceRegistry.forTest(emptyFetcher());
    registry.register(new StubAdapter('stub'));
    const importViaSource = Object.create(ImportViaSourceService.prototype);
    importViaSource.importByUrl = async () => ({ book: { chapters: [] } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    svc = BookService.forTest(fakeDb as any, registry, importViaSource as any);
    // Spy on loader.evictCache: 替换为 spy 记录调用
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (svc as any).loader.evictCache = (id: string) => {
      evictCalls.push(id);
    };
  });

  it('deleteBook 后应触发 loader.evictCache(bookId)', async () => {
    await svc.addBook(makeBook({ id: 'b1' }), makeChapters('b1', 3));
    // 先填充 loader 缓存（mock）
    await svc.getChapters('b1');
    expect(evictCalls).toHaveLength(0);

    await svc.deleteBook('b1');
    expect(evictCalls).toEqual(['b1']);
  });

  it('多次 deleteBook 各自触发对应 evictCache', async () => {
    await svc.addBook(makeBook({ id: 'b1' }), []);
    await svc.addBook(makeBook({ id: 'b2' }), []);

    await svc.deleteBook('b1');
    expect(evictCalls).toEqual(['b1']);

    await svc.deleteBook('b2');
    expect(evictCalls).toEqual(['b1', 'b2']);
  });

  it('即使 book 不存在也应触发 evictCache 调用（避免残留孤儿）', async () => {
    await svc.deleteBook('nonexistent');
    expect(evictCalls).toEqual(['nonexistent']);
  });
});