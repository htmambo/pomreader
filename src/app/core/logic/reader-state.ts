import { signal, computed, type Signal, type WritableSignal } from '@angular/core';

/**
 * 阅读状态纯逻辑层（EVO-12）
 *
 * 抽离 ReaderService 中的 signal 状态管理到 core/logic/，
 * 便于脱离 DI 上下文单测（无 @Injectable、无副作用）。
 *
 * 持久化由 ReaderService 注入 BookService 实现；
 * 本模块只管 in-memory state 状态。
 */
export interface ReaderState {
  readonly currentBookId: Signal<string | null>;
  readonly currentChapterIndex: Signal<number>;
  readonly pageOffset: Signal<number>;
  /** 派生：当前进度快照 { bookId, chapter } */
  readonly progress: Signal<{ bookId: string; chapter: number } | null>;

  /** 打开一本书（重置章节与页码到初始） */
  openBook(bookId: string, chapter?: number): void;
  /** 下一章（页码归零） */
  nextChapter(): void;
  /** 上一章（页码设为 -1 哨兵值，待渲染测量后解析） */
  prevChapter(): void;
  /** 跳转到指定章 */
  goToChapter(index: number): void;
  /** 设置章内页码（翻页模式） */
  setPageOffset(page: number): void;

  // 内部 writable（用于 fromTest 注入 + restoreProgress 调用）
  setCurrentChapterIndex(index: number): void;
  setPageOffsetRaw(value: number): void;
}

/** ReaderState 工厂：返回独立实例，signals 隔离 */
export function createReaderState(): ReaderState {
  const _currentBookId: WritableSignal<string | null> = signal<string | null>(null);
  const _currentChapterIndex: WritableSignal<number> = signal<number>(0);
  const _pageOffset: WritableSignal<number> = signal<number>(0);

  const progress: Signal<{ bookId: string; chapter: number } | null> = computed(() => {
    const bookId = _currentBookId();
    if (!bookId) return null;
    return { bookId, chapter: _currentChapterIndex() };
  });

  return {
    currentBookId: _currentBookId.asReadonly(),
    currentChapterIndex: _currentChapterIndex.asReadonly(),
    pageOffset: _pageOffset.asReadonly(),
    progress,

    openBook(bookId: string, chapter = 0): void {
      _currentBookId.set(bookId);
      _currentChapterIndex.set(Math.max(0, chapter));
      _pageOffset.set(0);
    },
    nextChapter(): void {
      _currentChapterIndex.update((i) => i + 1);
      _pageOffset.set(0);
    },
    prevChapter(): void {
      _currentChapterIndex.update((i) => Math.max(0, i - 1));
      _pageOffset.set(-1);
    },
    goToChapter(index: number): void {
      _currentChapterIndex.set(Math.max(0, index));
      _pageOffset.set(0);
    },
    setPageOffset(page: number): void {
      _pageOffset.set(Math.max(0, page));
    },

    setCurrentChapterIndex(index: number): void {
      _currentChapterIndex.set(index);
    },
    setPageOffsetRaw(value: number): void {
      _pageOffset.set(value);
    },
  };
}
