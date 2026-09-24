import { Injectable, signal, computed, Signal, WritableSignal } from '@angular/core';
import { Book } from '../models/book.model';
import { Chapter } from '../models/chapter.model';

/**
 * BookService — 加载 mock 书库与章节
 * v1.1 §10：mock 数据走静态 JSON
 * v1.1 §3：localStorage 不存章节正文（导入的章节仅在内存中）
 * v1.1 §15.1：用户报告「导入后无法打开阅读，阅读页 1/0」—— 修：导入的 chapters 走内存缓存
 */
@Injectable({ providedIn: 'root' })
export class BookService {
  private readonly _books = signal<Book[]>([]);
  private readonly _chaptersCache: WritableSignal<Map<string, Chapter[]>> = signal(new Map());

  readonly books: Signal<Book[]> = this._books.asReadonly();
  readonly count: Signal<number> = computed(() => this._books().length);

  async load(): Promise<void> {
    const res = await fetch('/assets/data/books.json');
    const data = (await res.json()) as Book[];
    this._books.set(data);
  }

  getById(id: string): Book | undefined {
    return this._books().find((b) => b.id === id);
  }

  async getChapters(bookId: string): Promise<Chapter[]> {
    // 优先查内存缓存（导入的章节）
    const cached = this._chaptersCache().get(bookId);
    if (cached) return cached;
    // mock 数据走静态资源
    const res = await fetch(`/assets/data/chapters/${bookId}.json`);
    if (!res.ok) return [];
    const data = (await res.json()) as Chapter[];
    return data.map((c, i) => ({ ...c, index: i, bookId }));
  }

  addBook(book: Book, chapters: Chapter[]): void {
    this._books.update((list) => [...list, book]);
    // 章节进内存缓存（不持久化）
    this._chaptersCache.update((m) => {
      const next = new Map(m);
      next.set(book.id, chapters);
      return next;
    });
  }
}