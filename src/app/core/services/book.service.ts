import { Injectable, signal, computed, Signal, WritableSignal, inject } from '@angular/core';
import { Book } from '../models/book.model';
import { Chapter } from '../models/chapter.model';
import { BookSourceRegistry } from '../book-source/book-source.registry';
import { CatalogEntry } from '../book-source/book-source.adapter';
import { DbService } from './db.service';

/** 在线导入预加载章节数 */
const PRELOAD_COUNT = 3;

export type DbLoadState = 'idle' | 'loading' | 'ready' | 'error';

/**
 * BookService — 书架 + 章节管理（PouchDB 后端）
 *
 * 数据流：
 *   - 启动：`load()` → DbService.seedIfEmpty() → db.bookAll() 加载书架
 *   - 导入：`addBook` / `importOnlineBook` → 写 PouchDB + 同步更新内存 signal
 *   - 阅读：`getChapters` → PouchDB 拉 + 填充内存缓存 → 同步 `getChaptersSync` 给 reader effect
 *   - 进度：`updateProgress` → 嵌入 Book 文档的 `progress` 字段
 *
 * 内存缓存（`_chaptersCache`）保留 v1 的设计：reader.component 用 effect 监听 chaptersVersion
 * 同步读章节列表，避免每次响应式刷新都异步查 PouchDB。
 */
@Injectable({ providedIn: 'root' })
export class BookService {
  private readonly db = inject(DbService);
  private readonly sources = inject(BookSourceRegistry);

  private readonly _books = signal<Book[]>([]);
  private readonly _loadState = signal<DbLoadState>('idle');
  private readonly _chaptersCache: WritableSignal<Map<string, Chapter[]>> = signal(new Map());

  readonly books: Signal<Book[]> = this._books.asReadonly();
  readonly loadState: Signal<DbLoadState> = this._loadState.asReadonly();
  readonly count: Signal<number> = computed(() => this._books().length);
  /** 章节缓存版本号——reader effect 监听以刷新在线章节正文 */
  readonly chaptersVersion = signal(0);

  /**
   * 初始化：从 PouchDB 加载所有书籍；首次启动自动 seed mock books.json
   * 由 APP_INITIALIZER（app.config.ts）在 app 启动时调用一次
   */
  async load(): Promise<void> {
    if (this._loadState() === 'loading' || this._loadState() === 'ready') return;
    this._loadState.set('loading');
    try {
      await this.db.seedIfEmpty();
      const books = await this.db.bookAll();
      this._books.set(books);
      this._loadState.set('ready');
    } catch (e) {
      console.error('[BookService.load] failed', e);
      this._loadState.set('error');
      throw e;
    }
  }

  getById(id: string): Book | undefined {
    return this._books().find((b) => b.id === id);
  }

  /** 异步从 PouchDB 拉某书全部章节；首次成功后填充内存缓存 */
  async getChapters(bookId: string): Promise<Chapter[]> {
    const cached = this._chaptersCache().get(bookId);
    if (cached) return cached;
    const chapters = await this.db.chapterAll(bookId);
    if (chapters.length > 0) {
      this._chaptersCache.update((m) => {
        const next = new Map(m);
        next.set(bookId, chapters);
        return next;
      });
    }
    return chapters;
  }

  /** 同步读内存缓存（reader effect 监听 chaptersVersion 后用） */
  getChaptersSync(bookId: string): Chapter[] | undefined {
    return this._chaptersCache().get(bookId);
  }

  /** 新增/更新一本书 + 全部章节 */
  async addBook(book: Book, chapters: Chapter[]): Promise<void> {
    await this.db.bookPut(book);
    if (chapters.length > 0) {
      await this.db.chapterPutMany(chapters);
    }
    // 同步更新内存 signal（乐观更新）
    this._books.update((list) => {
      const idx = list.findIndex((b) => b.id === book.id);
      if (idx >= 0) {
        const next = [...list];
        next[idx] = book;
        return next;
      }
      return [...list, book];
    });
    if (chapters.length > 0) {
      this._chaptersCache.update((m) => {
        const next = new Map(m);
        next.set(book.id, chapters);
        return next;
      });
    }
  }

  /** 在线导入：目录入库 + 预加载前 N 章 */
  async importOnlineBook(book: Book, catalog: CatalogEntry[]): Promise<void> {
    const chapters: Chapter[] = catalog.map((e, i) => ({
      bookId: book.id,
      index: i,
      title: e.title,
      content: '',
      sourceUrl: e.url,
      loaded: false,
    }));
    await this.addBook(book, chapters);
    // 预加载前 N 章（失败静默，阅读时重试）
    await Promise.allSettled(
      chapters.slice(0, PRELOAD_COUNT).map((c) => this.loadChapterContent(book.id, c.index))
    );
  }

  /** 按需加载某章正文（fetch + 写 PouchDB + 刷新缓存） */
  async loadChapterContent(bookId: string, index: number): Promise<void> {
    // 优先从内存缓存取章节 metadata（包含 sourceUrl）
    const cached = this._chaptersCache().get(bookId);
    let ch = cached?.[index];
    if (!ch) {
      const fromDb = await this.db.chapterGet(bookId, index);
      if (fromDb) ch = fromDb;
    }
    if (!ch || ch.loaded || !ch.sourceUrl) return;
    try {
      const entry: CatalogEntry = { title: ch.title, url: ch.sourceUrl };
      const content = await this.sources.fetchChapter(entry);
      const updated: Chapter = { ...ch, content, loaded: true };
      await this.db.chapterPut(updated);
      // 同步更新内存缓存
      this._chaptersCache.update((m) => {
        const list = m.get(bookId);
        if (!list) return m;
        const next = new Map(m);
        next.set(bookId, list.map((c) => (c.index === index ? updated : c)));
        return next;
      });
      this.chaptersVersion.update((v) => v + 1);
    } catch {
      // 失败保持 loaded=false，阅读时给重试
    }
  }

  /** 更新某章字段（内部 / 旧 API 兼容） */
  async updateChapter(bookId: string, index: number, patch: Partial<Chapter>): Promise<void> {
    const cached = this._chaptersCache().get(bookId);
    let ch = cached?.[index];
    if (!ch) {
      const fromDb = await this.db.chapterGet(bookId, index);
      if (fromDb) ch = fromDb;
    }
    if (!ch) return;
    const updated: Chapter = { ...ch, ...patch };
    await this.db.chapterPut(updated);
    this._chaptersCache.update((m) => {
      const list = m.get(bookId);
      if (!list) return m;
      const next = new Map(m);
      next.set(bookId, list.map((c) => (c.index === index ? updated : c)));
      return next;
    });
    this.chaptersVersion.update((v) => v + 1);
  }

  /** 更新阅读进度（嵌入 Book 文档） */
  async updateProgress(bookId: string, chapterIndex: number, scrollOffset?: number): Promise<void> {
    try {
      await this.db.bookUpdateProgress(bookId, chapterIndex, scrollOffset);
      // 同步更新内存 signal（不阻塞调用方）
      const progress = { chapterIndex, scrollOffset, updatedAt: new Date().toISOString() };
      this._books.update((list) =>
        list.map((b) => (b.id === bookId ? { ...b, progress } : b)),
      );
    } catch (e) {
      // progress 写失败不影响主流程
      console.warn('[BookService.updateProgress] failed', e);
    }
  }

  /** 删除一本书 + 级联删除其所有章节 */
  async deleteBook(bookId: string): Promise<void> {
    await this.db.bookDelete(bookId);
    this._books.update((list) => list.filter((b) => b.id !== bookId));
    this._chaptersCache.update((m) => {
      const next = new Map(m);
      next.delete(bookId);
      return next;
    });
  }
}
