import { describe, it, expect } from 'vitest';
import {
  STATUS_TABS,
  booksInGroup,
  countByGroup,
  countByStatus,
  filterBooks,
  filterByStatus,
  readStatusOf,
} from './bookshelf-filter';
import { type Book } from '../models/book.model';

function book(partial: Partial<Book> & { id: string }): Book {
  return {
    title: partial.id,
    author: 'a',
    chapterCount: 1,
    totalChars: 1,
    importedAt: '2026-01-01T00:00:00.000Z',
    source: 'local-txt',
    ...partial,
  };
}

/** 未读：无 progress */
const UNREAD = book({ id: 'unread' });
/** 正在读：10 章读到第 2 章 */
const READING = book({
  id: 'reading',
  chapterCount: 10,
  progress: { chapterIndex: 2, updatedAt: '2026-02-01T00:00:00.000Z' },
});
/** 已读完：10 章读到第 9 章（末章） */
const FINISHED = book({
  id: 'finished',
  chapterCount: 10,
  progress: { chapterIndex: 9, updatedAt: '2026-02-02T00:00:00.000Z' },
});

describe('readStatusOf', () => {
  it('无 progress → 未读', () => {
    expect(readStatusOf(UNREAD)).toBe('unread');
  });

  it('有进度且未到末章 → 正在读', () => {
    expect(readStatusOf(READING)).toBe('reading');
  });

  it('chapterIndex === chapterCount - 1 → 已读完', () => {
    expect(readStatusOf(FINISHED)).toBe('finished');
  });

  it('单本书读到唯一一章 → 已读完', () => {
    const single = book({
      id: 'single',
      chapterCount: 1,
      progress: { chapterIndex: 0, updatedAt: '2026-02-01T00:00:00.000Z' },
    });
    expect(readStatusOf(single)).toBe('finished');
  });

  it('chapterCount 未知（0）→ 保守记正在读，不误判已读完', () => {
    const unknown = book({
      id: 'unknown',
      chapterCount: 0,
      progress: { chapterIndex: 99, updatedAt: '2026-02-01T00:00:00.000Z' },
    });
    expect(readStatusOf(unknown)).toBe('reading');
  });

  it('进度越界（index 超出末章）→ 已读完', () => {
    const beyond = book({
      id: 'beyond',
      chapterCount: 3,
      progress: { chapterIndex: 7, updatedAt: '2026-02-01T00:00:00.000Z' },
    });
    expect(readStatusOf(beyond)).toBe('finished');
  });
});

describe('filterByStatus', () => {
  const books = [UNREAD, READING, FINISHED];

  it('all → 原样返回副本', () => {
    const out = filterByStatus(books, 'all');
    expect(out).toHaveLength(3);
    expect(out).not.toBe(books);
  });

  it('各状态分别命中', () => {
    expect(filterByStatus(books, 'unread').map((b) => b.id)).toEqual(['unread']);
    expect(filterByStatus(books, 'reading').map((b) => b.id)).toEqual(['reading']);
    expect(filterByStatus(books, 'finished').map((b) => b.id)).toEqual(['finished']);
  });
});

describe('booksInGroup', () => {
  const books = [
    book({ id: 'a', groupIds: ['g1', 'g2'] }),
    book({ id: 'b', groupIds: ['g2'] }),
    book({ id: 'c' }), // 未归类（历史数据无字段）
  ];

  it('null → 全部书', () => {
    expect(booksInGroup(books, null).map((b) => b.id)).toEqual(['a', 'b', 'c']);
  });

  it('指定分类 → 命中该分类下所有书', () => {
    expect(booksInGroup(books, 'g2').map((b) => b.id)).toEqual(['a', 'b']);
  });

  it('不存在的分类 → 空', () => {
    expect(booksInGroup(books, 'nope')).toEqual([]);
  });
});

describe('filterBooks（分类 ∩ 状态）', () => {
  const books = [
    book({
      id: 'a',
      groupIds: ['g1'],
      progress: { chapterIndex: 0, updatedAt: 'x' },
      chapterCount: 5,
    }),
    book({ id: 'b', groupIds: ['g1'] }),
    book({ id: 'c', groupIds: ['g2'] }),
  ];

  it('分类 + 状态同时生效', () => {
    expect(filterBooks(books, 'g1', 'reading').map((b) => b.id)).toEqual(['a']);
    expect(filterBooks(books, 'g1', 'unread').map((b) => b.id)).toEqual(['b']);
    expect(filterBooks(books, null, 'unread').map((b) => b.id)).toEqual(['b', 'c']);
  });

  it('不改动入参', () => {
    const input = [UNREAD];
    filterBooks(input, null, 'finished');
    expect(input).toEqual([UNREAD]);
  });
});

describe('countByStatus / countByGroup（分面计数）', () => {
  const books = [
    book({ id: 'a', groupIds: ['g1'] }),
    book({ id: 'b', groupIds: ['g1', 'g2'], progress: { chapterIndex: 4, updatedAt: 'x' } }),
    book({ id: 'c', chapterCount: 5 }),
  ];

  it('countByStatus 统计各状态 + all 总数', () => {
    expect(countByStatus(books)).toEqual({ all: 3, unread: 2, reading: 0, finished: 1 });
  });

  it('countByStatus 空列表全 0', () => {
    expect(countByStatus([])).toEqual({ all: 0, unread: 0, reading: 0, finished: 0 });
  });

  it('countByGroup 按传入 id 列表初始化，未归类的书不计入任何分类', () => {
    expect(countByGroup(books, ['g1', 'g2', 'g3'])).toEqual({ g1: 2, g2: 1, g3: 0 });
  });

  it('countByGroup 忽略 groupIds 里的未知分类 id', () => {
    const dirty = [book({ id: 'x', groupIds: ['ghost'] })];
    expect(countByGroup(dirty, ['g1'])).toEqual({ g1: 0 });
  });
});

describe('STATUS_TABS', () => {
  it('顺序为 全部 → 未读 → 正在读 → 已读完', () => {
    expect(STATUS_TABS.map((t) => t.id)).toEqual(['all', 'unread', 'reading', 'finished']);
  });
});
