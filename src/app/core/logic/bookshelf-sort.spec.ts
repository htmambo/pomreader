import { describe, it, expect } from 'vitest';
import { sortBooks } from './bookshelf-sort';
import { Book } from '../models/book.model';

function book(partial: Partial<Book> & { id: string; title: string }): Book {
  return {
    author: 'a',
    coverColor: '#000',
    chapterCount: 1,
    totalChars: 1,
    importedAt: '2026-01-01T00:00:00.000Z',
    source: 'local-txt',
    ...partial,
  };
}

const BOOKS: Book[] = [
  book({ id: '1', title: '三体', importedAt: '2026-01-03T00:00:00.000Z', lastReadAt: '2026-02-01T00:00:00.000Z' }),
  book({ id: '2', title: '活着', importedAt: '2026-01-01T00:00:00.000Z' }),
  book({ id: '3', title: '百年孤独', importedAt: '2026-01-02T00:00:00.000Z', lastReadAt: '2026-02-03T00:00:00.000Z' }),
];

describe('sortBooks', () => {
  it('imported：按入库时间新→旧', () => {
    expect(sortBooks(BOOKS, 'imported').map((b) => b.id)).toEqual(['1', '3', '2']);
  });

  it('lastRead：按最后阅读新→旧，未读排最后', () => {
    expect(sortBooks(BOOKS, 'lastRead').map((b) => b.id)).toEqual(['3', '1', '2']);
  });

  it('title：按书名拼音升序', () => {
    // 百年孤独(b) < 活着(h) < 三体(s)
    expect(sortBooks(BOOKS, 'title').map((b) => b.id)).toEqual(['3', '2', '1']);
  });

  it('不改原数组（signal 不可变性）', () => {
    const before = BOOKS.map((b) => b.id);
    sortBooks(BOOKS, 'title');
    expect(BOOKS.map((b) => b.id)).toEqual(before);
  });
});
