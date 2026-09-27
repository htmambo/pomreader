import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Book } from '../models/book.model';
/* eslint-disable @typescript-eslint/no-unused-vars -- type-only 引用 */
import { BookService } from './book.service';
import { ReaderService } from './reader.service';
/* eslint-enable @typescript-eslint/no-unused-vars */

/**
 * ReaderService facade spec（EVO-12 后续 hardening）
 *
 * 覆盖范围：
 *   - pure logic 已有 reader-state.spec.ts（44 tests）
 *   - 本 spec 锁定 facade ↔ BookService 联动契约：
 *     · openBook/nextChapter/prevChapter/goToChapter → saveProgress → books.updateProgress
 *     · saveProgress 在 currentBookId null 时静默
 *     · restoreProgress 从 books.getById 恢复
 *     · migrateLegacyProgress 处理 localStorage + corruption
 */

function makeBook(overrides: Partial<Book> = {}): Book {
  return {
    id: 'book-1',
    title: 'Test',
    author: 'Author',
    chapterCount: 5,
    totalChars: 1000,
    importedAt: '2026-01-01T00:00:00Z',
    source: 'online',
    sourceUrl: 'http://test/1',
    progress: undefined,
    ...overrides,
  };
}

describe('ReaderService facade（EVO-12）', () => {
  let svc: ReaderService;

  let booksMock: any;
  let updateProgressSpy: ReturnType<typeof vi.fn>;
  let getByIdSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.removeItem('pom.reader.progress');
    updateProgressSpy = vi.fn(async () => undefined);
    getByIdSpy = vi.fn((id: string) => makeBook({ id }));

    booksMock = {
      updateProgress: updateProgressSpy,
      getById: getByIdSpy,
    } as any;
    // Object.create 不跑 class field initializer；手动注入 books 依赖

    svc = Object.create(ReaderService.prototype) as any;

    (svc as any).books = booksMock;
    // state mock: currentBookId/currentChapterIndex/pageOffset 是 getter 函数（Signal 调用方式）
    // openBook/nextChapter/... 是 stub 方法（mock 行为）

    (svc as any).state = {
      openBook: vi.fn(),
      nextChapter: vi.fn(),
      prevChapter: vi.fn(),
      goToChapter: vi.fn(),
      setPageOffset: vi.fn(),
      setCurrentChapterIndex: vi.fn(),
      setPageOffsetRaw: vi.fn(),
      // signal getters
      currentBookId: () => null as string | null,
      currentChapterIndex: () => 0,
      pageOffset: () => 0,
    } as any;
  });

  describe('saveProgress 联动', () => {
    it('currentBookId 为 null 时应静默（不调 books.updateProgress）', () => {
      (svc as any).state.currentBookId = () => null;
      svc.saveProgress();
      expect(updateProgressSpy).not.toHaveBeenCalled();
    });

    it('currentBookId 存在时应调 books.updateProgress 带正确参数', () => {
      (svc as any).state.currentBookId = () => 'b1';

      (svc as any).state.currentChapterIndex = () => 3;

      (svc as any).state.pageOffset = () => 100;
      svc.saveProgress();
      expect(updateProgressSpy).toHaveBeenCalledWith('b1', 3, 100);
    });
  });

  describe('openBook / nextChapter / prevChapter / goToChapter', () => {
    beforeEach(() => {
      (svc as any).state.currentBookId = () => 'b1';

      (svc as any).state.currentChapterIndex = () => 0;

      (svc as any).state.pageOffset = () => 0;
    });

    it('openBook 应调 state.openBook + saveProgress', () => {
      svc.openBook('b1', 2);
      // state.openBook 是 mock，不修改 state → saveProgress 用初始 b1/0/0
      expect((svc as any).state.openBook).toHaveBeenCalledWith('b1', 2);
      expect(updateProgressSpy).toHaveBeenCalledWith('b1', 0, 0);
    });

    it('nextChapter 应调 state.nextChapter + saveProgress', () => {
      svc.nextChapter();
      expect((svc as any).state.nextChapter).toHaveBeenCalled();
      expect(updateProgressSpy).toHaveBeenCalled();
    });

    it('prevChapter 应调 state.prevChapter + saveProgress', () => {
      svc.prevChapter();
      expect((svc as any).state.prevChapter).toHaveBeenCalled();
      expect(updateProgressSpy).toHaveBeenCalled();
    });

    it('goToChapter 应调 state.goToChapter + saveProgress', () => {
      svc.goToChapter(5);
      expect((svc as any).state.goToChapter).toHaveBeenCalledWith(5);
      expect(updateProgressSpy).toHaveBeenCalled();
    });

    it('setPageOffset 应调 state.setPageOffset + saveProgress', () => {
      svc.setPageOffset(50);
      expect((svc as any).state.setPageOffset).toHaveBeenCalledWith(50);
      expect(updateProgressSpy).toHaveBeenCalled();
    });
  });

  describe('restoreProgress', () => {
    it('book 不存在时应返回 null', async () => {
      (svc as any).state.currentBookId = () => 'missing';
      getByIdSpy.mockReturnValue(undefined);
      const result = await svc.restoreProgress();
      expect(result).toBeNull();
    });

    it('book 存在 + 有 progress 时应返回完整状态', async () => {
      (svc as any).state.currentBookId = () => 'b1';
      getByIdSpy.mockReturnValue(
        makeBook({ id: 'b1', progress: { chapterIndex: 3, scrollOffset: 150, updatedAt: 'x' } }),
      );
      const result = await svc.restoreProgress();
      expect(result).toEqual({ bookId: 'b1', chapter: 3, page: 150 });
    });

    it('book.progress 缺 scrollOffset 时应 fallback 0', async () => {
      (svc as any).state.currentBookId = () => 'b1';
      getByIdSpy.mockReturnValue(
        makeBook({ id: 'b1', progress: { chapterIndex: 2, updatedAt: 'x' } }),
      );
      const result = await svc.restoreProgress();
      expect(result?.page).toBe(0);
    });
  });

  describe('migrateLegacyProgress', () => {
    it('localStorage 无记录时应静默', () => {
      svc.migrateLegacyProgress();
      expect(updateProgressSpy).not.toHaveBeenCalled();
    });

    it('localStorage 有合法记录时应迁移并删除', () => {
      localStorage.setItem('pom.reader.progress', JSON.stringify({ bookId: 'b1', chapter: 5 }));
      svc.migrateLegacyProgress();
      expect(updateProgressSpy).toHaveBeenCalledWith('b1', 5);
      expect(localStorage.getItem('pom.reader.progress')).toBeNull();
    });

    it('localStorage 损坏 JSON 应捕获并清理', () => {
      localStorage.setItem('pom.reader.progress', '{not json');
      expect(() => svc.migrateLegacyProgress()).not.toThrow();
      expect(localStorage.getItem('pom.reader.progress')).toBeNull();
      expect(updateProgressSpy).not.toHaveBeenCalled();
    });

    it('localStorage 缺 bookId / chapter 应不调 updateProgress', () => {
      localStorage.setItem('pom.reader.progress', JSON.stringify({}));
      svc.migrateLegacyProgress();
      expect(updateProgressSpy).not.toHaveBeenCalled();
    });
  });
});
