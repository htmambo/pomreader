import { Injectable, signal, computed, Signal, WritableSignal, inject } from '@angular/core';
import { Book } from '../models/book.model';
import { Chapter } from '../models/chapter.model';
import { BookSourceRegistry } from '../book-source/book-source.registry';
import { CatalogEntry } from '../book-source/book-source.adapter';

/** 在线导入预加载章节数 */
const PRELOAD_COUNT = 3;

/**
 * BookService — 加载 mock 书库与章节
 * v1.1 §10：mock 数据走静态 JSON
 * v1.1 §3：localStorage 不存章节正文（导入的章节仅在内存中）
 * v1.1 §15.1：导入的 chapters 走内存缓存
 * 在线导入：目录元数据入内存缓存，正文按需抓取（spec §5）
 */
@Injectable({ providedIn: 'root' })
export class BookService {
  private readonly _books = signal<Book[]>([]);
  private readonly _chaptersCache: WritableSignal<Map<string, Chapter[]>> = signal(new Map());
  private readonly sources = inject(BookSourceRegistry);

  readonly books: Signal<Book[]> = this._books.asReadonly();
  readonly count: Signal<number> = computed(() => this._books().length);
  /** 章节缓存版本号——reader effect 监听以刷新在线章节正文 */
  readonly chaptersVersion = signal(0);

  async load(): Promise<void> {
    // 相对路径：Electron file:// 下相对 index.html 解析；ng serve 下相对 baseURL /
    const res = await fetch('assets/data/books.json');
    const data = (await res.json()) as Book[];
    this._books.set(data);
  }

  getById(id: string): Book | undefined {
    return this._books().find((b) => b.id === id);
  }

  async getChapters(bookId: string): Promise<Chapter[]> {
    const cached = this._chaptersCache().get(bookId);
    if (cached) return cached;
    const res = await fetch(`assets/data/chapters/${bookId}.json`);
    if (!res.ok) return [];
    const data = (await res.json()) as Chapter[];
    return data.map((c, i) => ({ ...c, index: i, bookId }));
  }

  /** 同步获取内存缓存的章节（按需加载后刷新 reader signal 用） */
  getChaptersSync(bookId: string): Chapter[] | undefined {
    return this._chaptersCache().get(bookId);
  }

  addBook(book: Book, chapters: Chapter[]): void {
    this._books.update((list) => [...list, book]);
    this._chaptersCache.update((m) => {
      const next = new Map(m);
      next.set(book.id, chapters);
      return next;
    });
  }

  /** 在线导入：目录入库 + 预加载前 N 章（spec §5.3） */
  async importOnlineBook(book: Book, catalog: CatalogEntry[]): Promise<void> {
    const chapters: Chapter[] = catalog.map((e, i) => ({
      bookId: book.id,
      index: i,
      title: e.title,
      content: '',
      sourceUrl: e.url,
      loaded: false,
    }));
    this.addBook(book, chapters);
    // 预加载前 N 章（失败静默，阅读时重试）
    await Promise.allSettled(
      chapters.slice(0, PRELOAD_COUNT).map((c) => this.loadChapterContent(book.id, c.index))
    );
  }

  /** 按需加载某章正文（spec §5.3） */
  async loadChapterContent(bookId: string, index: number): Promise<void> {
    const chapters = this._chaptersCache().get(bookId);
    if (!chapters) return;
    const ch = chapters[index];
    if (!ch || ch.loaded || !ch.sourceUrl) return;
    try {
      const entry: CatalogEntry = { title: ch.title, url: ch.sourceUrl };
      const content = await this.sources.fetchChapter(entry);
      this.updateChapter(bookId, index, { content, loaded: true });
    } catch {
      // 失败保持 loaded=false，阅读时给重试
    }
  }

  /** 更新内存中某章字段 */
  updateChapter(bookId: string, index: number, patch: Partial<Chapter>): void {
    this._chaptersCache.update((m) => {
      const next = new Map(m);
      const list = next.get(bookId);
      if (list && list[index]) {
        list[index] = { ...list[index], ...patch };
        next.set(bookId, [...list]);
      }
      return next;
    });
    this.chaptersVersion.update((v) => v + 1);
  }
}
