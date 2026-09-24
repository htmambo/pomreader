import { Injectable, signal, computed, Signal } from '@angular/core';
import { Book } from '../models/book.model';
import { Chapter } from '../models/chapter.model';

/**
 * BookService — 加载 mock 书库与章节
 * v1.1 §10：mock 数据走静态 JSON
 */
@Injectable({ providedIn: 'root' })
export class BookService {
  private readonly _books = signal<Book[]>([]);
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
    const res = await fetch(`/assets/data/chapters/${bookId}.json`);
    if (!res.ok) return [];
    const data = (await res.json()) as Chapter[];
    return data.map((c, i) => ({ ...c, index: i, bookId }));
  }

  addBook(book: Book, chapters: Chapter[]): void {
    this._books.update((list) => [...list, book]);
    // 章节不持久化（v1.1 §3：localStorage 不存章节正文）
    // 真实导入时走 Service 局部变量或内存缓存
    console.log(`[BookService] added book ${book.id} with ${chapters.length} chapters (in-memory only)`);
  }
}