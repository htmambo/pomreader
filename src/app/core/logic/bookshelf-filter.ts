import { type Book } from '../models/book.model';

/** 单本书的阅读状态（由 progress / chapterCount 推导，不落库） */
export type ReadStatus = 'unread' | 'reading' | 'finished';

/** 书架状态筛选值：all = 不限 */
export type ReadStatusFilter = 'all' | ReadStatus;

export interface StatusTab {
  id: ReadStatusFilter;
  label: string;
}

/** 第二行状态 tab（顺序即展示顺序，计数联动当前分类） */
export const STATUS_TABS: readonly StatusTab[] = [
  { id: 'all', label: '全部' },
  { id: 'unread', label: '未读' },
  { id: 'reading', label: '正在读' },
  { id: 'finished', label: '已读完' },
];

/**
 * 推导单本书的阅读状态：
 * - 无 progress（含历史数据无该字段）→ 未读
 * - 读到最后一章 → 已读完
 * - 其余（有进度但未到末章）→ 正在读
 *
 * chapterCount ≤ 0（目录未知 / 刚导入未拉取）时**不**判定为已读完：
 * 无从证明读完，保守记为正在读。
 */
export function readStatusOf(book: Book): ReadStatus {
  const p = book.progress;
  if (!p) return 'unread';
  if (book.chapterCount > 0 && p.chapterIndex >= book.chapterCount - 1) return 'finished';
  return 'reading';
}

/** 分类过滤：groupId 为 null 表示「全部书籍」（含未归类） */
export function booksInGroup(books: readonly Book[], groupId: string | null): Book[] {
  if (groupId === null) return [...books];
  return books.filter((b) => (b.groupIds ?? []).includes(groupId));
}

/** 阅读状态过滤 */
export function filterByStatus(books: readonly Book[], status: ReadStatusFilter): Book[] {
  if (status === 'all') return [...books];
  return books.filter((b) => readStatusOf(b) === status);
}

/** 书架最终展示列表 = 分类 ∩ 状态（入参不变，返回新数组） */
export function filterBooks(
  books: readonly Book[],
  groupId: string | null,
  status: ReadStatusFilter,
): Book[] {
  return filterByStatus(booksInGroup(books, groupId), status);
}

/**
 * 各状态计数（all = 入参总数）。
 * 入参 books 需为「当前分类筛选后」的列表 —— 两行筛选互为分面（facet）：
 * 换分类时状态角标跟着变，换状态时分类角标跟着变。
 */
export function countByStatus(books: readonly Book[]): Record<ReadStatusFilter, number> {
  const counts: Record<ReadStatusFilter, number> = {
    all: books.length,
    unread: 0,
    reading: 0,
    finished: 0,
  };
  for (const b of books) {
    counts[readStatusOf(b)]++;
  }
  return counts;
}

/**
 * 各分类计数：入参 books 需为「当前状态筛选后」的列表，
 * 这样分类角标与状态 tab 互相联动（与 legado 书架行为一致）。
 * 未在 groups 中出现的 id 不出现在结果里，调用方用 `?? 0` 兜底。
 */
export function countByGroup(
  books: readonly Book[],
  groupIds: readonly string[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const id of groupIds) counts[id] = 0;
  for (const b of books) {
    for (const id of b.groupIds ?? []) {
      if (id in counts) counts[id]++;
    }
  }
  return counts;
}
