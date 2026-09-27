import { Injectable, Signal, WritableSignal, computed, inject, signal } from '@angular/core';
import { Book } from '../models/book.model';
import { Chapter } from '../models/chapter.model';
import { DbService } from './db.service';

/**
 * BookRepository 公开契约（public surface, no `db`）。
 * 测试 stub 用此接口做编译期绑定（避免 `as unknown as` 双重强转）。
 */
export interface BookRepositoryPort {
  readonly books: Signal<Book[]>;
  readonly loadState: Signal<'idle' | 'loading' | 'ready' | 'error'>;
  readonly count: Signal<number>;
  getById(id: string): Book | undefined;
  load(): Promise<void>;
  persistBook(book: Book): Promise<void>;
  persistChapters(chapters: Chapter[]): Promise<void>;
  deleteBook(bookId: string): Promise<void>;
}

/**
 * BookRepository — Book/Chapter 持久化 + signal 同步层（EVO-1）
 *
 * 职责（单一数据源）：
 * - 启动时一次性从 PouchDB 加载所有 Book（`load()`）
 * - 持久化 Book / Chapter（含内存 signal 乐观更新）
 * - 删除 Book（级联清理章节 + 内存缓存）
 *
 * 持有 signal：
 * - `_books: WritableSignal<Book[]>` —— 全应用唯一 books 真相源
 *
 * 不持有：
 * - 章节内容按需加载（→ ChapterLoader，见后续 sprint）
 * - 换源 / 刷新元数据 / 进度（→ BookUpdater，见后续 sprint）
 *
 * 调用方约定：通过 `books()` signal 读取；通过 `persistBook / persistChapters / deleteBook`
 * 写入。**禁止**绕过 signal 直接调用 `DbService`（会破坏单源真相）。
 */
@Injectable({ providedIn: 'root' })
export class BookRepository implements BookRepositoryPort {
  private readonly db = inject(DbService);

  private readonly _books = signal<Book[]>([]);
  private readonly _loadState = signal<'idle' | 'loading' | 'ready' | 'error'>('idle');

  /** 全应用唯一 books 真相源（readonly signal） */
  readonly books: Signal<Book[]> = this._books.asReadonly();
  /** 加载状态（启动 / 失败 / 成功） */
  readonly loadState: Signal<'idle' | 'loading' | 'ready' | 'error'> = this._loadState.asReadonly();
  /** 便利派生：book 数量（auto-tracks _books） */
  readonly count: Signal<number> = computed(() => this._books().length);

  /**
   * 一次性加载所有书籍。APP_INITIALIZER 启动时调一次。
   * 后续调用直接返回（保护：loadState = 'ready' / 'loading' 时跳过）
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
      console.error('[BookRepository.load] failed', e);
      this._loadState.set('error');
      throw e;
    }
  }

  /** 同步按 ID 查询（从内存 signal 读，未命中返回 undefined） */
  getById(id: string): Book | undefined {
    return this._books().find((b) => b.id === id);
  }

  /** 持久化一本书（新增或更新）+ 同步内存 signal */
  async persistBook(book: Book): Promise<void> {
    await this.db.bookPut(book);
    this._books.update((list) => {
      const idx = list.findIndex((b) => b.id === book.id);
      if (idx >= 0) {
        const next = [...list];
        next[idx] = book;
        return next;
      }
      return [...list, book];
    });
  }

  /** 持久化多章（新增或替换；upsert by bookId+index） */
  async persistChapters(chapters: Chapter[]): Promise<void> {
    if (chapters.length === 0) return;
    await this.db.chapterPutMany(chapters);
  }

  /**
   * 删除一本书 + 级联删除其所有章节。
   * 同步：books signal 中移除；chapters 缓存由 caller（Loader）清理。
   */
  async deleteBook(bookId: string): Promise<void> {
    await this.db.bookDelete(bookId);
    this._books.update((list) => list.filter((b) => b.id !== bookId));
  }

  /**
   * 测试入口：手动注入依赖（绕开 Angular DI 上下文 NG0203）。
   * 复用 BookService.forTest 同模式。
   */
   
  static forTest(db: DbService): BookRepository {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const repo: any = Object.create(BookRepository.prototype);
    repo.db = db;
    repo._books = signal<Book[]>([]);
    repo._loadState = signal<'idle' | 'loading' | 'ready' | 'error'>('idle');
    // 手动绑定 readonly signal getter（class field initializer 不通过 Object.create 调用）
    repo.books = repo._books.asReadonly();
    repo.loadState = repo._loadState.asReadonly();
    repo.count = computed(() => repo._books().length);
    return repo as BookRepository;
  }
}
