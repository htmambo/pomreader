import { Injectable, type Signal, inject } from '@angular/core';
import { BookService } from './book.service';
import { createReaderState, type ReaderState } from '../logic/reader-state';

/** 旧版 localStorage key（v1 持久化方案）—— 一次性迁移用 */
const LEGACY_PROGRESS_KEY = 'pom.reader.progress';

/**
 * ReaderService — 阅读进度 facade（EVO-12）
 *
 * v2: 持久化到 PouchDB Book 文档的 progress 字段
 * v3 (EVO-12): signal 状态抽到 core/logic/reader-state.ts；本 service 留 facade + 持久化层
 *
 * 调用方 0 改动：signal 接口与原 service 1:1 对应
 */
@Injectable({ providedIn: 'root' })
export class ReaderService {
  private readonly books = inject(BookService);
  private readonly state: ReaderState = createReaderState();

  readonly currentBookId: Signal<string | null> = this.state.currentBookId;
  readonly currentChapterIndex: Signal<number> = this.state.currentChapterIndex;
  readonly pageOffset: Signal<number> = this.state.pageOffset;
  readonly progress: Signal<{ bookId: string; chapter: number } | null> = this.state.progress;

  openBook(bookId: string, chapter = 0): void {
    this.state.openBook(bookId, chapter);
    this.saveProgress();
  }

  nextChapter(): void {
    this.state.nextChapter();
    this.saveProgress();
  }

  prevChapter(): void {
    this.state.prevChapter();
    this.saveProgress();
  }

  goToChapter(index: number): void {
    this.state.goToChapter(index);
    this.saveProgress();
  }

  /** 翻页后由 reader 组件同步真实页码（并落盘） */
  setPageOffset(page: number): void {
    // 仅在页码**真的变了**时落盘。
    // reader 的 measure() 在切章 / 改字号 / 改主题 / 窗口缩放 / 字体加载完成时
    // 都会调用 setPageOffset，其中绝大多数情况页码没变 —— 原实现每次都触发
    // 一次「读 Book 文档 + 写 Book 文档」的两轮 IPC，是阅读过程中的主要写开销。
    const changed = this.state.pageOffset() !== page;
    this.state.setPageOffset(page);
    if (changed) this.saveProgress();
  }

  /** 保存进度到 PouchDB（嵌入 Book 文档；scrollOffset 字段复用为章内页码） */
  saveProgress(): void {
    const bookId = this.state.currentBookId();
    if (!bookId) return;
    void this.books.updateProgress(
      bookId,
      this.state.currentChapterIndex(),
      this.state.pageOffset(),
    );
  }

  /**
   * 从 PouchDB 恢复当前书的进度
   * 调用时机：reader 组件初始化时；恢复后调用方可用返回的 chapter/page 跳页
   */
  async restoreProgress(): Promise<{ bookId: string; chapter: number; page: number } | null> {
    const bookId = this.state.currentBookId();
    if (!bookId) return null;
    const book = this.books.getById(bookId);
    if (book?.progress) {
      this.state.setCurrentChapterIndex(book.progress.chapterIndex);
      const page = book.progress.scrollOffset ?? 0;
      this.state.setPageOffsetRaw(page);
      return { bookId, chapter: book.progress.chapterIndex, page };
    }
    return null;
  }

  /**
   * 一次性迁移：把 v1 localStorage 里的 progress 迁移到 PouchDB Book 文档
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
      try {
        localStorage.removeItem(LEGACY_PROGRESS_KEY);
      } catch {
        /* localStorage 不可用，忽略 */
      }
    }
  }
}
