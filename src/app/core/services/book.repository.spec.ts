import { describe, it, expect, beforeEach } from 'vitest';
import { BookRepository } from './book.repository';
import { Book } from '../models/book.model';
import { Chapter } from '../models/chapter.model';

function makeBook(overrides: Partial<Book> = {}): Book {
  return {
    id: 'book-1',
    title: 'Test Book',
    author: 'Author',
    chapterCount: 0,
    totalChars: 0,
    importedAt: '2026-01-01T00:00:00Z',
    source: 'local-txt',
    ...overrides,
  };
}

function makeDb(books: Book[] = [], chapters: Record<string, Chapter[]> = {}) {
  return {
    seedIfEmpty: async () => undefined,
    bookAll: async () => books,
    bookPut: async () => undefined,
    bookDelete: async () => undefined,
    chapterPutMany: async () => undefined,
    // 不需要 chapterAll / chapterGet
  };
}

describe('BookRepository', () => {
  let repo: BookRepository;
  let db: ReturnType<typeof makeDb>;

  beforeEach(() => {
    db = makeDb();
    repo = BookRepository.forTest(db as never);
  });

  describe('load', () => {
    it('应能从 db 加载并填充 books signal', async () => {
      const books = [makeBook({ id: 'b1' }), makeBook({ id: 'b2', title: 'Book 2' })];
      repo.db = { ...db, bookAll: async () => books };
      await repo.load();
      expect(repo.books()).toEqual(books);
      expect(repo.loadState()).toBe('ready');
      expect(repo.count()).toBe(2); // R3 fix: count 改 computed 追踪 _books()
    });

    it('load 完成后 loadState 应为 ready', async () => {
      const books = [makeBook({ id: 'b1' })];
      repo.db = { ...db, bookAll: async () => books };
      await repo.load();
      expect(repo.loadState()).toBe('ready');
    });

    it('重复 load 应直接返回（不重新加载）', async () => {
      const books1 = [makeBook({ id: 'first' })];
      repo.db = { ...db, bookAll: async () => books1 };
      await repo.load();
      // 第二次 load：替换 db 但应被忽略
      const books2 = [makeBook({ id: 'second' })];
      repo.db = { ...db, bookAll: async () => books2 };
      await repo.load();
      expect(repo.books()).toEqual(books1); // 第一次的
    });

    it('load 失败应进入 error 状态并抛错', async () => {
      repo.db = {
        ...db,
        seedIfEmpty: async () => {
          throw new Error('boom');
        },
      };
      await expect(repo.load()).rejects.toThrow('boom');
      expect(repo.loadState()).toBe('error');
    });
  });

  describe('getById', () => {
    it('应能从内存 signal 命中', async () => {
      const books = [makeBook({ id: 'b1', title: 'Book One' })];
      repo.db = { ...db, bookAll: async () => books };
      await repo.load();
      const found = repo.getById('b1');
      expect(found?.title).toBe('Book One');
    });

    it('未命中应返回 undefined', async () => {
      const books = [makeBook({ id: 'b1' })];
      repo.db = { ...db, bookAll: async () => books };
      await repo.load();
      expect(repo.getById('missing')).toBeUndefined();
    });

    it('空 signal 应返回 undefined', () => {
      expect(repo.getById('anything')).toBeUndefined();
    });
  });

  describe('persistBook', () => {
    it('应写 PouchDB 并更新内存 signal', async () => {
      const putCalls: Book[] = [];
      repo.db = {
        ...db,
        bookPut: async (b: Book) => {
          putCalls.push(b);
        },
      };
      const book = makeBook({ id: 'b1' });
      await repo.persistBook(book);
      expect(putCalls).toEqual([book]);
      expect(repo.books()).toEqual([book]);
    });

    it('重复 persistBook 同 id 应替换（不重复添加）', async () => {
      repo.db = { ...db };
      await repo.persistBook(makeBook({ id: 'b1', title: 'Original' }));
      await repo.persistBook(makeBook({ id: 'b1', title: 'Updated' }));
      expect(repo.books()).toHaveLength(1);
      expect(repo.books()[0].title).toBe('Updated');
      expect(repo.count()).toBe(1); // R3 fix: count 追踪 _books()
    });

    it('不同 id 应追加到末尾', async () => {
      repo.db = { ...db };
      await repo.persistBook(makeBook({ id: 'b1' }));
      await repo.persistBook(makeBook({ id: 'b2' }));
      expect(repo.books()).toHaveLength(2);
      expect(repo.books()[1].id).toBe('b2');
      expect(repo.count()).toBe(2); // R3 fix: count 追踪 _books()
    });
  });

  describe('persistChapters', () => {
    it('应写 PouchDB', async () => {
      const putCalls: Chapter[][] = [];
      repo.db = {
        ...db,
        chapterPutMany: async (chs: Chapter[]) => {
          putCalls.push(chs);
        },
      };
      const chs = [
        { bookId: 'b1', index: 0, title: 'c1', content: '', loaded: false } as Chapter,
        { bookId: 'b1', index: 1, title: 'c2', content: '', loaded: false } as Chapter,
      ];
      await repo.persistChapters(chs);
      expect(putCalls).toEqual([chs]);
    });

    it('空数组应直接返回（不调 db）', async () => {
      let called = false;
      repo.db = {
        ...db,
        chapterPutMany: async () => {
          called = true;
        },
      };
      await repo.persistChapters([]);
      expect(called).toBe(false);
    });
  });

  describe('deleteBook', () => {
    it('应写 PouchDB 并从内存 signal 移除', async () => {
      const books = [makeBook({ id: 'b1' }), makeBook({ id: 'b2' })];
      repo.db = { ...db, bookAll: async () => books };
      let deleteCalled = false;
      repo.db.bookDelete = async () => {
        deleteCalled = true;
      };
      await repo.load();
      await repo.deleteBook('b1');
      expect(deleteCalled).toBe(true);
      expect(repo.books().map((b) => b.id)).toEqual(['b2']);
      expect(repo.count()).toBe(1); // R3 fix: count 追踪 _books()
    });
  });
});
