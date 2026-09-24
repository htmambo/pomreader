import { Injectable, signal, computed, Signal, inject } from '@angular/core';
import { BookService } from './book.service';

const PROGRESS_KEY = 'pom.reader.progress';

/**
 * ReaderService — 阅读进度管理
 * v1.1 §13 P3 + v1.1 §6 服务层
 */
@Injectable({ providedIn: 'root' })
export class ReaderService {
  private readonly books = inject(BookService);
  private readonly _currentBookId = signal<string | null>(null);
  private readonly _currentChapterIndex = signal<number>(0);

  readonly currentBookId: Signal<string | null> = this._currentBookId.asReadonly();
  readonly currentChapterIndex: Signal<number> = this._currentChapterIndex.asReadonly();

  readonly progress: Signal<{ bookId: string; chapter: number } | null> = computed(() => {
    const bookId = this._currentBookId();
    if (!bookId) return null;
    return { bookId, chapter: this._currentChapterIndex() };
  });

  openBook(bookId: string, chapter = 0): void {
    this._currentBookId.set(bookId);
    this._currentChapterIndex.set(Math.max(0, chapter));
    this.saveProgress();
  }

  nextChapter(): void {
    this._currentChapterIndex.update((i) => i + 1);
    this.saveProgress();
  }

  prevChapter(): void {
    this._currentChapterIndex.update((i) => Math.max(0, i - 1));
    this.saveProgress();
  }

  goToChapter(index: number): void {
    this._currentChapterIndex.set(Math.max(0, index));
    this.saveProgress();
  }

  saveProgress(): void {
    const bookId = this._currentBookId();
    if (!bookId) return;
    try {
      localStorage.setItem(
        PROGRESS_KEY,
        JSON.stringify({ bookId, chapter: this._currentChapterIndex() })
      );
    } catch {
      /* quota */
    }
  }

  restoreProgress(): { bookId: string; chapter: number } | null {
    try {
      const stored = localStorage.getItem(PROGRESS_KEY);
      if (!stored) return null;
      return JSON.parse(stored);
    } catch {
      return null;
    }
  }
}