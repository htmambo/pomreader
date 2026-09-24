import { Injectable, signal, computed, Signal, inject } from '@angular/core';
import { BookService } from './book.service';

/** 旧版 localStorage key（v1 持久化方案）—— 一次性迁移用 */
const LEGACY_PROGRESS_KEY = 'pom.reader.progress';

/**
 * ReaderService — 阅读进度管理（v2：持久化到 PouchDB Book 文档）
 *
 * v1: localStorage 存 { bookId, chapter }
 * v2: 嵌入 Book 文档的 progress 字段（与 bookId 强耦合，删除书自动级联）
 *
 * 首次启动时调用 `migrateLegacyProgress()` 把 v1 localStorage 数据迁移到 PouchDB
 */
@Injectable({ providedIn: 'root' })
export class ReaderService {
  private readonly books = inject(BookService);
  private readonly _currentBookId = signal<string | null>(null);
  private readonly _currentChapterIndex = signal<number>(0);
  /**
   * 章内页码（翻页模式用，持久化到 BookProgress.scrollOffset 字段）。
   * 哨兵值 -1：表示「目标章的最后一页」，由 reader 组件渲染测量后解析成真实页码。
   */
  private readonly _pageOffset = signal<number>(0);

  readonly currentBookId: Signal<string | null> = this._currentBookId.asReadonly();
  readonly currentChapterIndex: Signal<number> = this._currentChapterIndex.asReadonly();
  readonly pageOffset: Signal<number> = this._pageOffset.asReadonly();

  readonly progress: Signal<{ bookId: string; chapter: number } | null> = computed(() => {
    const bookId = this._currentBookId();
    if (!bookId) return null;
    return { bookId, chapter: this._currentChapterIndex() };
  });

  openBook(bookId: string, chapter = 0): void {
    this._currentBookId.set(bookId);
    this._currentChapterIndex.set(Math.max(0, chapter));
    this._pageOffset.set(0);
    this.saveProgress();
  }

  nextChapter(): void {
    this._currentChapterIndex.update((i) => i + 1);
    this._pageOffset.set(0);
    this.saveProgress();
  }

  prevChapter(): void {
    this._currentChapterIndex.update((i) => Math.max(0, i - 1));
    this._pageOffset.set(-1);
    this.saveProgress();
  }

  goToChapter(index: number): void {
    this._currentChapterIndex.set(Math.max(0, index));
    this._pageOffset.set(0);
    this.saveProgress();
  }

  /** 翻页后由 reader 组件同步真实页码（并落盘） */
  setPageOffset(page: number): void {
    this._pageOffset.set(Math.max(0, page));
    this.saveProgress();
  }

  /** 保存进度到 PouchDB（嵌入 Book 文档；scrollOffset 字段复用为章内页码） */
  saveProgress(): void {
    const bookId = this._currentBookId();
    if (!bookId) return;
    void this.books.updateProgress(bookId, this._currentChapterIndex(), this._pageOffset());
  }

  /**
   * 从 PouchDB 恢复当前书的进度
   * 调用时机：reader 组件初始化时；恢复后调用方可用返回的 chapter/page 跳页
   * page 为 -1 时表示「最后一页」（待渲染测量后解析）
   */
  async restoreProgress(): Promise<{ bookId: string; chapter: number; page: number } | null> {
    const bookId = this._currentBookId();
    if (!bookId) return null;
    const book = this.books.getById(bookId);
    if (book?.progress) {
      this._currentChapterIndex.set(book.progress.chapterIndex);
      const page = book.progress.scrollOffset ?? 0;
      this._pageOffset.set(page);
      return { bookId, chapter: book.progress.chapterIndex, page };
    }
    return null;
  }

  /**
   * 一次性迁移：把 v1 localStorage 里的 progress 迁移到 PouchDB Book 文档
   * 调用时机：BookService.load() 完成后
   */
  migrateLegacyProgress(): void {
    try {
      const stored = localStorage.getItem(LEGACY_PROGRESS_KEY);
      if (!stored) return;
      const parsed = JSON.parse(stored) as { bookId?: string; chapter?: number };
      if (parsed.bookId && typeof parsed.chapter === 'number') {
        void this.books.updateProgress(parsed.bookId, parsed.chapter);
      }
      localStorage.removeItem(LEGACY_PROGRESS_KEY);
    } catch {
      // corrupt data, just drop
      try {
        localStorage.removeItem(LEGACY_PROGRESS_KEY);
      } catch {
        /* localStorage 不可用，忽略 */
      }
    }
  }
}
