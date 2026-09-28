import { describe, it, expect, beforeEach } from 'vitest';
import { createReaderState, ReaderState } from './reader-state';

describe('ReaderState', () => {
  let state: ReaderState;

  beforeEach(() => {
    state = createReaderState();
  });

  describe('初始状态', () => {
    it('currentBookId 初始为 null', () => {
      expect(state.currentBookId()).toBeNull();
    });

    it('currentChapterIndex 初始为 0', () => {
      expect(state.currentChapterIndex()).toBe(0);
    });

    it('pageOffset 初始为 0', () => {
      expect(state.pageOffset()).toBe(0);
    });

    it('progress 初始为 null（无 bookId）', () => {
      expect(state.progress()).toBeNull();
    });
  });

  describe('openBook', () => {
    it('应能设置 bookId + chapter + 重置 pageOffset', () => {
      state.openBook('book-1', 5);
      expect(state.currentBookId()).toBe('book-1');
      expect(state.currentChapterIndex()).toBe(5);
      expect(state.pageOffset()).toBe(0);
    });

    it('chapter 为负应夹到 0', () => {
      state.openBook('book-1', -3);
      expect(state.currentChapterIndex()).toBe(0);
    });

    it('默认 chapter 为 0', () => {
      state.openBook('book-1');
      expect(state.currentChapterIndex()).toBe(0);
    });
  });

  describe('nextChapter / prevChapter / goToChapter', () => {
    it('nextChapter 应 +1 并重置 pageOffset', () => {
      state.openBook('book-1', 5);
      state.setPageOffset(10);
      state.nextChapter();
      expect(state.currentChapterIndex()).toBe(6);
      expect(state.pageOffset()).toBe(0);
    });

    it('prevChapter 应 -1（最小 0）+ 设 pageOffset = -1 哨兵', () => {
      state.openBook('book-1', 5);
      state.setPageOffset(10);
      state.prevChapter();
      expect(state.currentChapterIndex()).toBe(4);
      expect(state.pageOffset()).toBe(-1);
    });

    it('prevChapter 在第 0 章应保持 0', () => {
      state.openBook('book-1', 0);
      state.prevChapter();
      expect(state.currentChapterIndex()).toBe(0);
    });

    it('goToChapter 应设章节 + 重置 pageOffset', () => {
      state.openBook('book-1', 0);
      state.setPageOffset(10);
      state.goToChapter(7);
      expect(state.currentChapterIndex()).toBe(7);
      expect(state.pageOffset()).toBe(0);
    });

    it('goToChapter 负数应夹到 0', () => {
      state.openBook('book-1', 5);
      state.goToChapter(-1);
      expect(state.currentChapterIndex()).toBe(0);
    });
  });

  describe('setPageOffset', () => {
    it('应能设置新值', () => {
      state.setPageOffset(5);
      expect(state.pageOffset()).toBe(5);
    });

    it('负数应夹到 0', () => {
      state.setPageOffset(-3);
      expect(state.pageOffset()).toBe(0);
    });
  });

  describe('progress computed', () => {
    it('openBook 后应返回 { bookId, chapter }', () => {
      state.openBook('book-1', 3);
      expect(state.progress()).toEqual({ bookId: 'book-1', chapter: 3 });
    });

    it('nextChapter 后 progress 应更新', () => {
      state.openBook('book-1', 3);
      state.nextChapter();
      expect(state.progress()).toEqual({ bookId: 'book-1', chapter: 4 });
    });
  });

  describe('restoreProgress 用 raw setter', () => {
    it('setCurrentChapterIndex + setPageOffsetRaw 应生效', () => {
      state.openBook('book-1', 0);
      state.setCurrentChapterIndex(5);
      state.setPageOffsetRaw(-1);
      expect(state.currentChapterIndex()).toBe(5);
      expect(state.pageOffset()).toBe(-1);
    });
  });
});
