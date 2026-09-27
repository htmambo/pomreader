import { describe, it, expect, beforeEach } from 'vitest';
import { Book } from '../models/book.model';
import { Chapter } from '../models/chapter.model';
import { BookService } from './book.service';
import { BookSourceRegistry } from '../book-source/book-source.registry';
import { BookSourceAdapter, PageFetcher, ResolvedBook } from '../book-source/book-source.adapter';
import { ImportViaSourceService } from '../book-source/import-via-source.service';

/**
 * Round 7 P0-2 mitigation: BookService.count ↔ BookRepository.count 双 signal 同步不变量
 *
 * 契约（review_code Round 7 P0-2）：
 *   - BookService.count 是独立 computed(_books().length)（facade mirror）
 *   - BookRepository.count 是独立 computed(_books().length)（底层真相源）
 *   - 两者必须在所有可观察时刻同步（fork-and-mirror 双写语义）
 *
 * 本 spec 通过 fakeDb 双写路径 + BookService.addBook 链路验证不变量。
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

describe('BookService.count ↔ BookRepository.count 不变量', () => {
  let fakeDb: {
    bookPut: (b: Book) => Promise<void>;
    bookDelete: (id: string) => Promise<void>;
    chapterPutMany: (chs: Chapter[]) => Promise<void>;
    chapterAll: (id: string) => Promise<Chapter[]>;
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

    svc = BookService.forTest(fakeDb as any, registry, importViaSource as any);
  });

  it('初始状态：两个 count 都应为 0', () => {
    expect(svc.count()).toBe(0);
    expect(svc.repo.count()).toBe(0);
    expect(svc.count()).toBe(svc.repo.count());
  });

  it('addBook 后两个 count 应同步增加', async () => {
    await svc.addBook(makeBook({ id: 'b1' }), []);
    expect(svc.count()).toBe(1);
    expect(svc.repo.count()).toBe(1);
    expect(svc.count()).toBe(svc.repo.count());

    await svc.addBook(makeBook({ id: 'b2' }), []);
    expect(svc.count()).toBe(2);
    expect(svc.repo.count()).toBe(2);
    expect(svc.count()).toBe(svc.repo.count());
  });

  it('deleteBook 后两个 count 应同步减少', async () => {
    await svc.addBook(makeBook({ id: 'b1' }), []);
    await svc.addBook(makeBook({ id: 'b2' }), []);
    expect(svc.count()).toBe(2);

    await svc.deleteBook('b1');
    expect(svc.count()).toBe(1);
    expect(svc.repo.count()).toBe(1);
    expect(svc.count()).toBe(svc.repo.count());
  });

  it('重复 addBook 同 id 应不增加 count', async () => {
    await svc.addBook(makeBook({ id: 'b1', title: 'first' }), []);
    await svc.addBook(makeBook({ id: 'b1', title: 'updated' }), []);
    expect(svc.count()).toBe(1);
    expect(svc.repo.count()).toBe(1);
    expect(svc.count()).toBe(svc.repo.count());
  });
});
