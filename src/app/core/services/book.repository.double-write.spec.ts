import { describe, it, expect, beforeEach } from 'vitest';
import { Book } from '../models/book.model';
import { BookService } from './book.service';
import { BookSourceRegistry } from '../book-source/book-source.registry';
import { BookSourceAdapter, PageFetcher, ResolvedBook } from '../book-source/book-source.adapter';
import { ImportViaSourceService } from '../book-source/import-via-source.service';

/**
 * R6-1 缓解：BookRepositoryPort forTest stub 双写语义契约测试
 *
 * 契约（review_code Round 6 P2 R6-1 / Phase 4 收口）:
 *   - db-first（source of truth）, mirror-second（同步读路径缓存）
 *   - db 抛错 → 测试即失败，_books 不被污染（await 后再镜像）
 *   - 错误传播语义：原 stub 不调 db = 吞错；现 stub 调 db = 抛错（更接近 prod）
 *
 * 本 spec 通过 fakeDb.bookPut 配置 throw 来锁定此契约。
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
    chapterCount: 0,
    totalChars: 0,
    importedAt: '2026-01-01T00:00:00Z',
    source: 'online',
    sourceUrl: 'http://test/1',
    ...overrides,
  };
}

describe('BookService.forTest stub — R6-1 双写契约', () => {
  let fakeDb: {
    bookPut: (b: Book) => Promise<void>;
    bookDelete: (id: string) => Promise<void>;
    chapterPutMany: (chs: unknown[]) => Promise<void>;
    chapterAll: (id: string) => Promise<unknown[]>;
  };
  let svc: BookService;

  beforeEach(() => {
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
    svc = BookService.forTest(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fakeDb as any,
      registry,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      importViaSource as any,
    );
  });

  it('db 成功时应同时写 db 和镜像 _books', async () => {
    const book = makeBook({ id: 'b1', title: 'first' });
    await svc.addBook(book, []);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((svc as any)._books()).toEqual([book]);
  });

  it('db.bookPut 抛错时错误应传播且 _books 不被污染（R6-1 核心契约）', async () => {
    fakeDb.bookPut = async () => {
      throw new Error('db-write-failed');
    };
    const book = makeBook({ id: 'b1', title: 'first' });
    await expect(svc.addBook(book, [])).rejects.toThrow('db-write-failed');
    // 关键：await db.bookPut 抛错 → _books.update 不执行 → 镜像保持初始 []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((svc as any)._books()).toEqual([]);
  });

  it('db.bookDelete 抛错时 _books 不变', async () => {
    // 先写入
    await svc.addBook(makeBook({ id: 'b1' }), []);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((svc as any)._books()).toHaveLength(1);
    // 配置 delete 抛错
    fakeDb.bookDelete = async () => {
      throw new Error('db-delete-failed');
    };
    await expect(svc.deleteBook('b1')).rejects.toThrow('db-delete-failed');
    // _books 应保持原状（db-first → await 抛错 → 不执行镜像）
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((svc as any)._books()).toHaveLength(1);
  });

  it('空 chapters 数组不应触发 db.chapterPutMany', async () => {
    let chapterPutCalled = false;
    fakeDb.chapterPutMany = async () => {
      chapterPutCalled = true;
    };
    await svc.addBook(makeBook({ id: 'b1' }), []);
    expect(chapterPutCalled).toBe(false);
  });

  it('重复 persistBook 同 id 应替换（不重复添加）', async () => {
    await svc.addBook(makeBook({ id: 'b1', title: 'first' }), []);
    await svc.addBook(makeBook({ id: 'b1', title: 'updated' }), []);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((svc as any)._books()).toHaveLength(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((svc as any)._books()[0].title).toBe('updated');
  });
});