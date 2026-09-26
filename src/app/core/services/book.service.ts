import { Injectable, signal, computed, Signal, WritableSignal, inject } from '@angular/core';
import { Book } from '../models/book.model';
import { Chapter } from '../models/chapter.model';
import { BookSourceRegistry } from '../book-source/book-source.registry';
import { CatalogEntry } from '../book-source/book-source.adapter';
import { ImportViaSourceService } from '../book-source/import-via-source.service';
import { FetchError } from '../book-source/fetch-error';
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
  private readonly importViaSource = inject(ImportViaSourceService);

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

  /**
   * 换源：把已 online 入库的书重新解析到一个新的书源/URL，替换其 metadata 与 chapters 表。
   * user-bound 字段保留：bookId / progress / importedAt / lastReadAt。
   *
   * 阅读进度处理：progress.chapterIndex clamp 到新章节表范围；
   * scrollOffset / updatedAt 保留；progress 整体透传 addBook（bookPutWithRetry 内部
   * 已处理"newProgress 存在时不覆盖"，与新增 progress 同语义）。
   *
   * 异常：仅 'online' 来源支持换源；其它 source 抛 FetchError('unsupported-source')。
   */
  async changeBookSource(bookId: string, newUrl: string, sourceName?: string): Promise<void> {
    const oldBook = this.getById(bookId);
    if (!oldBook) throw new FetchError('source-unavailable', `书不存在: ${bookId}`);
    if (oldBook.source !== 'online') {
      throw new FetchError(
        'unsupported-source',
        `仅 online 来源支持换源，当前 source: ${oldBook.source}`,
      );
    }

    const { book: resolved, bookSourceUuid } = await this.importViaSource.importByUrl(
      newUrl,
      sourceName,
    );
    if (resolved.chapters.length === 0) {
      throw new FetchError('parse-failed', '新源解析的章节列表为空');
    }

    const newChapters: Chapter[] = resolved.chapters.map((e, i) => ({
      bookId: oldBook.id,
      index: i,
      title: e.title,
      content: '',
      sourceUrl: e.url,
      loaded: false,
    }));

    // 合并 Book：保留 id / importedAt / lastReadAt / source('online')
    // source-bound 字段用新解析结果；kind / coverImageUrl 缺失时保留旧值
    const merged: Book = {
      ...oldBook,
      title: resolved.title || oldBook.title,
      author: resolved.author || oldBook.author,
      kind: resolved.kind ?? oldBook.kind,
      // ResolvedBook 当前不返回 coverImageUrl —— 换源时保留旧封面（避免立即丢失）
      // 后续可由用户手动 "刷新封面" 拉取新源封面
      coverImageUrl: oldBook.coverImageUrl,
      sourceUrl: newUrl,
      bookSourceUuid,
      chapterCount: newChapters.length,
      totalChars: newChapters.length * 2000, // 估算；读完时精算
      source: 'online',
    };

    // 阅读进度：clamp chapterIndex 到新表范围；scrollOffset / updatedAt 保留
    if (oldBook.progress) {
      const clampedIdx = Math.min(
        Math.max(oldBook.progress.chapterIndex, 0),
        newChapters.length - 1,
      );
      merged.progress = {
        ...oldBook.progress,
        chapterIndex: clampedIdx,
      };
    }

    // addBook 内 bookPutWithRetry 保留 progress；chapterPutMany 升级后会清理旧集合孤儿
    await this.addBook(merged, newChapters);

    // 预加载新源前 N 章（失败静默）；与 importOnlineBook 一致
    await Promise.allSettled(
      newChapters.slice(0, PRELOAD_COUNT).map((c) => this.loadChapterContent(bookId, c.index))
    );
  }

  /**
   * 更新最新章节（同源增量追加）
   *
   * 与 changeBookSource 的关键区别：
   * - 书源不变：仍走原 bookSourceUuid / sourceUrl
   * - 增量追加：旧章节全部保留（不删 / 不改），仅追加 URL 不在旧集合里的新章节
   * - 阅读进度不动：旧 chapter index 不变 → progress.chapterIndex 无需 clamp
   *
   * URL 去重：以 `Chapter.sourceUrl` 为唯一键（章节标题不稳定，源站常改名 / 加 VIP 标签）
   *
   * 返回 { added, skipped, total } 供 UI toast 汇报；不预取正文（用户阅读时按需加载）
   * 失败抛 FetchError（与 changeBookSource 错误语义一致）。
   */
  async refreshChapters(
    bookId: string,
  ): Promise<{ added: number; skipped: number; total: number }> {
    const oldBook = this.getById(bookId);
    if (!oldBook) throw new FetchError('source-unavailable', `书不存在: ${bookId}`);
    if (oldBook.source !== 'online') {
      throw new FetchError(
        'unsupported-source',
        `仅 online 来源支持更新章节，当前 source: ${oldBook.source}`,
      );
    }
    if (!oldBook.sourceUrl) {
      throw new FetchError(
        'parse-failed',
        '该书缺少 sourceUrl，无法重新拉取目录',
      );
    }

    // 解析 sourceName：bookSourceUuid → adapter.name；universal / 缺失 → undefined（自动 resolve）
    const sourceName = oldBook.bookSourceUuid
      ? this.sources.getByUuid(oldBook.bookSourceUuid)?.name
      : undefined;

    const { book: resolved } = await this.importViaSource.importByUrl(
      oldBook.sourceUrl,
      sourceName,
    );
    if (resolved.chapters.length === 0) {
      throw new FetchError('parse-failed', '源站解析的章节列表为空');
    }

    // URL 去重：取内存缓存（异步拉到 PouchDB 仅在缓存 miss 时）
    const cached = this._chaptersCache().get(bookId) ?? (await this.db.chapterAll(bookId));
    if (cached.length > 0) {
      this._chaptersCache.update((m) => {
        const next = new Map(m);
        next.set(bookId, cached);
        return next;
      });
    }
    const existingUrls = new Set(
      cached.map((c) => c.sourceUrl).filter((u): u is string => !!u),
    );

    // 追加：新 URL 才入索引 = 现有最大 + offset
    const startIndex = cached.length;
    const newChapters: Chapter[] = [];
    let offset = 0;
    for (const e of resolved.chapters) {
      if (existingUrls.has(e.url)) continue;
      newChapters.push({
        bookId,
        index: startIndex + offset,
        title: e.title,
        content: '',
        sourceUrl: e.url,
        loaded: false,
      });
      offset++;
    }
    const added = newChapters.length;
    const skipped = resolved.chapters.length - added;

    if (added === 0) {
      return { added: 0, skipped, total: cached.length };
    }

    // 合并 Book：chapterCount / totalChars 更新；其它字段不动（用户已绑定认知）
    const merged: Book = {
      ...oldBook,
      chapterCount: cached.length + added,
      totalChars: (cached.length + added) * 2000, // 估算；读完时精算
    };
    // 一次性写入全部章节（含旧章 + 新章）：chapterPutMany 升级后视 oldDocs ⊆ newIds 为无孤儿，
    // 不会触发意外删除；旧章批量写一次代价可接受（手动触发场景，频率低）
    await this.addBook(merged, [...cached, ...newChapters]);

    return { added, skipped, total: cached.length + added };
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

  /** 强制重新抓取某章正文（忽略 loaded 标记，用于已缓存内容异常时手动刷新） */
  async refreshChapter(bookId: string, index: number): Promise<boolean> {
    const cached = this._chaptersCache().get(bookId);
    let ch = cached?.[index];
    if (!ch) {
      const fromDb = await this.db.chapterGet(bookId, index);
      if (fromDb) ch = fromDb;
    }
    if (!ch || !ch.sourceUrl) return false;
    try {
      const entry: CatalogEntry = { title: ch.title, url: ch.sourceUrl };
      const content = await this.sources.fetchChapter(entry);
      const updated: Chapter = { ...ch, content, loaded: true };
      await this.db.chapterPut(updated);
      this._chaptersCache.update((m) => {
        const list = m.get(bookId);
        if (!list) return m;
        const next = new Map(m);
        next.set(bookId, list.map((c) => (c.index === index ? updated : c)));
        return next;
      });
      this.chaptersVersion.update((v) => v + 1);
      return true;
    } catch {
      return false;
    }
  }

  /** 清空全书章节正文缓存（标记为未加载，之后阅读时按需重新抓取） */
  async clearChapterContents(bookId: string): Promise<void> {
    const cached = this._chaptersCache().get(bookId) ?? (await this.db.chapterAll(bookId));
    if (!cached || cached.length === 0) return;
    const cleared: Chapter[] = cached.map((c) => ({ ...c, content: '', loaded: false }));
    await this.db.chapterPutMany(cleared);
    this._chaptersCache.update((m) => {
      const next = new Map(m);
      next.set(bookId, cleared);
      return next;
    });
    this.chaptersVersion.update((v) => v + 1);
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
      // 同步更新内存 signal（不阻塞调用方）；进度与最后阅读时间共用同一时间戳
      const now = new Date().toISOString();
      const progress = { chapterIndex, scrollOffset, updatedAt: now };
      this._books.update((list) =>
        list.map((b) => (b.id === bookId ? { ...b, progress, lastReadAt: now } : b)),
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

  /**
   * 测试入口：手动注入依赖（绕开 Angular DI 上下文 NG0203）。
   * 与 SandboxService.forTest / ImportViaSourceService.forTest 同模式：
   * 生产用 Angular inject()，测试用静态工厂。
   * 注意：测试中 _books / _chaptersCache 是空白 signal，调用前需手动
   * 设置 _books 状态以模拟 in-memory bookshelf。
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  static forTest(db: DbService, sources: BookSourceRegistry, importViaSource: ImportViaSourceService): BookService {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc: any = Object.create(BookService.prototype);
    svc.db = db;
    svc.sources = sources;
    svc.importViaSource = importViaSource;
    // 手动初始化 signals（绕开 class field 初始化；signal() 不依赖 DI）
    svc._books = signal<Book[]>([]);
    svc._loadState = signal<DbLoadState>('idle');
    svc._chaptersCache = signal(new Map());
    svc.chaptersVersion = signal(0);
    return svc as BookService;
  }
}
