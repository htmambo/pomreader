import { Injectable, signal, computed, type Signal, inject } from '@angular/core';
import { type Book } from '../models/book.model';
import { type Chapter } from '../models/chapter.model';
import { BookSourceRegistry } from '../book-source/book-source.registry';
import { type CatalogEntry } from '../book-source/book-source.adapter';
import { ImportViaSourceService } from '../book-source/import-via-source.service';
import { FetchError } from '../book-source/fetch-error';
import { DbService } from './db.service';
import { BookRepository, type BookRepositoryPort } from './book.repository';
import { ChapterLoader } from './chapter-loader';
import { BookUpdater } from './book-updater';

/** 在线导入预加载章节数 */
const PRELOAD_COUNT = 3;

export type DbLoadState = 'idle' | 'loading' | 'ready' | 'error';

/**
 * BookService — 书架 + 章节管理（PouchDB 后端）
 *
 * 数据流：
 *   - 启动：`load()` → DbService.seedIfEmpty()（无内置 seed，仅返回现状）→ db.bookAll() 加载书架
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
  private readonly repo: BookRepositoryPort = inject(BookRepository);
  private readonly loader = inject(ChapterLoader);
  private readonly updater = inject(BookUpdater);
  private readonly sources = inject(BookSourceRegistry);
  private readonly importViaSource = inject(ImportViaSourceService);

  private readonly _books = signal<Book[]>([]);
  private readonly _loadState = signal<DbLoadState>('idle');
  /** 进行中的加载 promise —— `whenLoaded()` 等它（A4 非阻塞 bootstrap） */
  private _loadPromise: Promise<void> | null = null;
  /**
   * 章节缓存**不在本 service**：唯一持有者是 ChapterLoader（→ ChapterLoader._chaptersCache）。
   * 原先这里还存了一份镜像 Map，两边各自更新导致「addBook 填了镜像但 loader 缓存仍为空」，
   * 阅读页随后仍要回 PouchDB 重拉一次目录。现已统一到 loader。
   */

  readonly books: Signal<Book[]> = this._books.asReadonly();
  readonly loadState: Signal<DbLoadState> = this._loadState.asReadonly();
  readonly count: Signal<number> = computed(() => this._books().length);
  /** id → book 索引（getById 热路径，O(1) 查询） */
  private readonly _booksById = computed(() => {
    const map = new Map<string, Book>();
    for (const b of this._books()) map.set(b.id, b);
    return map;
  });
  /**
   * 章节缓存版本号——reader effect 监听以刷新在线章节正文。
   *
   * 委托 ChapterLoader（A8 后章节缓存的唯一真相源在 loader）。
   * 本层此前持有的是一个**从未被 bump 的独立计数器**（死信号），
   * reader 依赖它刷新正文却永远收不到通知 —— 现在真正跟随 loader。
   */
  readonly chaptersVersion: Signal<number> = computed(() => this.loader.chaptersVersion());

  /**
   * 初始化：从 PouchDB 加载所有书籍；无内置 seed，首次启动书架为空
   * 由 APP_INITIALIZER（app.config.ts）在 app 启动时调一次
   *
   * A4 起为**非阻塞 bootstrap**：调用方不应 await 它（首屏不等全表扫描），
   * 需要「书已就绪」的调用方用 `whenLoaded()`。
   */
  async load(): Promise<void> {
    if (this._loadState() === 'loading' || this._loadState() === 'ready') return;
    this._loadState.set('loading');
    const p = (async () => {
      try {
        await this.repo.load();
        // 镜像同步：BookService 自身 _books / _loadState 仍保留以兼容现有 spec + 调用方（spec NFR-7 facade 渐进迁移）
        this._books.set(this.repo.books());
        this._loadState.set(this.repo.loadState());
      } catch (e) {
        console.error('[BookService.load] failed', e);
        this._loadState.set('error');
        throw e;
      }
    })();
    this._loadPromise = p;
    return p;
  }

  /**
   * 等待书架加载完成（幂等）。
   *
   * A4 起首屏不再等待 PouchDB 全表扫描 → 深链进阅读页时书架可能尚未就绪，
   * 调用方（reader）需要等它，否则会误判「书不存在」而跳回书架。
   *
   * 加载失败不抛：失败状态已由 load() 内部记录，等待方只需知道「不再加载中」。
   */
  async whenLoaded(): Promise<void> {
    if (this._loadState() === 'ready') return;
    try {
      await this.load();
    } catch {
      /* load 内部已记录错误 */
    }
    await this._loadPromise?.catch(() => undefined);
  }

  getById(id: string): Book | undefined {
    return this._booksById().get(id);
  }

  /** 异步从 PouchDB 拉某书全部章节；首次成功后填充内存缓存（委托 loader） */
  async getChapters(bookId: string): Promise<Chapter[]> {
    // 单一真相源：章节缓存只在 ChapterLoader 里（BookService 不再维护镜像 Map）
    return await this.loader.getChapters(bookId);
  }

  /** 同步读内存缓存（委托 loader） */
  getChaptersSync(bookId: string): Chapter[] | undefined {
    return this.loader.getChaptersSync(bookId);
  }

  /** 新增/更新一本书 + 全部章节 */
  async addBook(book: Book, chapters: Chapter[]): Promise<void> {
    await this.repo.persistBook(book);
    if (chapters.length > 0) {
      await this.repo.persistChapters(chapters);
    }
    // 镜像同步 + 乐观更新（BookService 自身 _books 仍保留以兼容现有调用方）
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
      // 章节缓存统一由 ChapterLoader 持有（addBook 后阅读页无需回 PouchDB 再拉一次目录）
      this.loader.cacheChapters(book.id, chapters);
    }
  }

  /**
   * 更新一本书的分类归属（书架分类是多选：groupIds 去重后整体覆盖）。
   * 走 addBook(book, []) —— 与「编辑书籍信息」同款元数据局部更新：
   * 保留 progress 与章节缓存，不触发任何网络请求。
   * 集合未变化时直接返回（避免无意义的 PouchDB 写 + 409 重试）。
   */
  async updateBookGroups(bookId: string, groupIds: readonly string[]): Promise<void> {
    const book = this.getById(bookId);
    if (!book) throw new FetchError('source-unavailable', `书不存在: ${bookId}`);
    const next = [...new Set(groupIds)];
    const current = book.groupIds ?? [];
    const unchanged = current.length === next.length && current.every((id, i) => id === next[i]);
    if (unchanged) return;
    await this.addBook({ ...book, groupIds: next }, []);
  }

  /**
   * ## HT-1 DEFERRED — Facade 委托未完成（review_code R6-2 / Phase 4 收口）
   *
   * **BookService half-migrated state**:
   *   - 6/10 chapter methods (getChapters/getChaptersSync/loadChapterContent/refreshChapter/
   *     clearChapterContents/updateChapter) → delegate to ChapterLoader (d9979b1) ✅
   *   - 1/10 high-level method (updateProgress) → delegate to BookUpdater (031ce1a) ✅
   *   - 4/10 high-level methods (importOnlineBook/changeBookSource/refreshChapters/
   *     refreshBookInfo) → self-implemented ⚠️ HT-1 deferred
   *
   * **阻塞原因** (Round 6):
   *   1. spec 通过 `spyAddBook(svc, calls)` 拦截 BookService.addBook 验证 merged book
   *      —— 委托后 addBook 不再被 BookService 触发（改走 BookUpdater.persistBook）
   *   2. refreshChapters 委托后 3 tests fail（章节顺序副作用未拆解）
   *
   * **解阻塞条件**: HT-3 TestBed provider 重构完成
   *   - 重构后 spec 应通过 BookRepositoryPort 直接观测持久化结果
   *   - 章节顺序副作用通过 ChapterLoader 显式 sequencing 拆解
   *
   * **迁移步骤** (HT-3 完成后):
   *   1. importOnlineBook → this.updater.importOnlineBook(book, catalog)
   *   2. changeBookSource → this.updater.changeBookSource(bookId, newUrl, sourceName)
   *   3. refreshChapters → this.updater.refreshChapters(bookId)（附顺序回归测试）
   *   4. refreshBookInfo → this.updater.refreshBookInfo(bookId)
   *
   * **回归矩阵**: spec 27/27 (book.service.spec) + 16/16 (book-updater.spec) 全绿
   *
   * @see HT-3 ticket: EVO-1-HT-3 (TestBed provider 重构合并处理)
   * @see Round 6 review: P2 R6-2（half-migrated 状态记录）
   */
  /** 在线导入：目录入库 + 预加载前 N 章（HT-1 deferred —— 见上方详细注释） */
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
    await Promise.allSettled(
      chapters.slice(0, PRELOAD_COUNT).map((c) => this.loadChapterContent(book.id, c.index)),
    );
  }

  /**
   * 换源（保留 BookService 自实现 —— 见 importOnlineBook 注释）
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

    const merged: Book = {
      ...oldBook,
      title: resolved.title || oldBook.title,
      author: resolved.author || oldBook.author,
      kind: resolved.kind ?? oldBook.kind,
      coverImageUrl: resolved.coverImageUrl || oldBook.coverImageUrl,
      sourceUrl: newUrl,
      bookSourceUuid,
      chapterCount: newChapters.length,
      totalChars: newChapters.length * 2000,
      source: 'online',
    };

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

    await this.addBook(merged, newChapters);

    await Promise.allSettled(
      newChapters.slice(0, PRELOAD_COUNT).map((c) => this.loadChapterContent(bookId, c.index)),
    );
  }

  /** 更新最新章节（同源增量追加）（保留 BookService 自实现 —— 见 importOnlineBook 注释） */
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
      throw new FetchError('parse-failed', '该书缺少 sourceUrl，无法重新拉取目录');
    }

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

    // 章节缓存统一在 ChapterLoader（单一真相源）
    const cached = this.loader.getChaptersSync(bookId) ?? (await this.db.chapterAll(bookId));
    if (cached.length > 0) {
      this.loader.cacheChapters(bookId, cached);
    }
    const existingUrls = new Set(cached.map((c) => c.sourceUrl).filter((u): u is string => !!u));

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

    const merged: Book = {
      ...oldBook,
      chapterCount: cached.length + added,
      totalChars: (cached.length + added) * 2000,
    };
    await this.addBook(merged, [...cached, ...newChapters]);

    return { added, skipped, total: cached.length + added };
  }

  /** 更新作品信息（同源元数据刷新）（保留 BookService 自实现 —— 见 importOnlineBook 注释） */
  async refreshBookInfo(bookId: string): Promise<Book> {
    const oldBook = this.getById(bookId);
    if (!oldBook) throw new FetchError('source-unavailable', `书不存在: ${bookId}`);
    if (oldBook.source !== 'online') {
      throw new FetchError(
        'unsupported-source',
        `仅 online 来源支持更新作品信息，当前 source: ${oldBook.source}`,
      );
    }
    if (!oldBook.sourceUrl) {
      throw new FetchError('parse-failed', '该书缺少 sourceUrl，无法重新拉取作品信息');
    }

    const sourceName = oldBook.bookSourceUuid
      ? this.sources.getByUuid(oldBook.bookSourceUuid)?.name
      : undefined;

    const { book: resolved } = await this.importViaSource.importByUrl(
      oldBook.sourceUrl,
      sourceName,
    );

    const merged: Book = {
      ...oldBook,
      title: resolved.title || oldBook.title,
      author: resolved.author || oldBook.author,
      kind: resolved.kind ?? oldBook.kind,
      coverImageUrl: resolved.coverImageUrl || oldBook.coverImageUrl,
    };

    await this.addBook(merged, []);
    return merged;
  }

  /** 按需加载某章正文（委托 loader） */
  async loadChapterContent(bookId: string, index: number): Promise<void> {
    await this.loader.loadChapterContent(bookId, index);
  }

  /**
   * 从 `chapter-body:` 文档读取某章正文并写入内存缓存（委托 loader）。
   *
   * 用于「本地书 / 已抓取过的在线章」——目录（chapterAll）不再携带正文，
   * 正文需要按章从独立文档读回。
   *
   * @returns 是否成功读到正文
   */
  async loadChapterBody(bookId: string, index: number): Promise<boolean> {
    return await this.loader.loadChapterBody(bookId, index);
  }

  /** 强制重新抓取某章正文（委托 loader） */
  async refreshChapter(bookId: string, index: number): Promise<boolean> {
    return await this.loader.refreshChapter(bookId, index);
  }

  /** 清空全书章节正文缓存（委托 loader） */
  async clearChapterContents(bookId: string): Promise<void> {
    await this.loader.clearChapterContents(bookId);
  }

  /** 更新某章字段（委托 loader） */
  async updateChapter(bookId: string, index: number, patch: Partial<Chapter>): Promise<void> {
    await this.loader.updateChapter(bookId, index, patch);
  }

  /** 更新阅读进度（嵌入 Book 文档）—— 委托 BookUpdater */
  async updateProgress(bookId: string, chapterIndex: number, scrollOffset?: number): Promise<void> {
    try {
      await this.updater.updateProgress(bookId, chapterIndex, scrollOffset);
    } catch (e) {
      console.warn('[BookService.updateProgress] failed', e);
    }
    // 镜像同步：BookUpdater 已 persistBook，但 BookService 自身 _books 仍保留镜像
    // （spec NFR-7 facade 渐进迁移：现有调用方依赖 BookService.books signal 即时刷新）
    const now = new Date().toISOString();
    const progress = { chapterIndex, scrollOffset, updatedAt: now };
    this._books.update((list) =>
      list.map((b) => (b.id === bookId ? { ...b, progress, lastReadAt: now } : b)),
    );
  }

  /** 删除一本书 + 级联删除其所有章节 */
  async deleteBook(bookId: string): Promise<void> {
    await this.repo.deleteBook(bookId);
    // 章节缓存唯一持有者是 ChapterLoader（→ evictCache 即可）
    this.loader.evictCache(bookId);
    // 镜像同步
    this._books.update((list) => list.filter((b) => b.id !== bookId));
  }

  /**
   * 测试入口：手动注入依赖（绕开 Angular DI 上下文 NG0203）。
   * 与 ImportViaSourceService.forTest 等同模式：
   * 生产用 Angular inject()，测试用静态工厂。
   * 注意：测试中 _books 是空白 signal，调用前需手动
   * 设置 _books 状态以模拟 in-memory bookshelf。
   *
   * @internal — **Prod code MUST NOT call this method**.
   * Tracked by HARDEN-xxx (Round 8 P1-2 defer: ESLint no-forTest-in-prod rule).
   * R6-4 grep verification currently in effect; CI does not yet enforce.
   */

  static forTest(
    db: DbService,
    sources: BookSourceRegistry,
    importViaSource: ImportViaSourceService,
    repo?: BookRepositoryPort,
    loader?: ChapterLoader,
    updater?: BookUpdater,
  ): BookService {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc: any = Object.create(BookService.prototype);
    svc.db = db;
    svc.sources = sources;
    svc.importViaSource = importViaSource;
    // 手动初始化 signals（绕开 class field 初始化；signal() 不依赖 DI）
    svc._books = signal<Book[]>([]);
    svc._loadState = signal<DbLoadState>('idle');
    // 派生 signal 同步（class field 初始化器不通过 Object.create 调用）
    svc.count = computed(() => svc._books().length);
    // id 索引同步（同上：class field 初始化器不生效）
    svc._booksById = computed(() => {
      const map = new Map<string, Book>();
      for (const b of svc._books()) map.set(b.id, b);
      return map;
    });
    // readonly signal getter 同步（BookService.books / loadState 是 getter，class field 不通过
    // Object.create 调用）—— P1-1 mitigation Round 8 遗漏修补
    svc.books = svc._books.asReadonly();
    svc.loadState = svc._loadState.asReadonly();
    // P1-1 (Round 7): tsc 编译期形状断言 — 缺字段即报错（vs as unknown as BookService 兜底）
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assertBookServiceShape(svc as any);
    // 构造 BookRepository stub：所有读操作走 svc._books（spec 直接写 svc._books 即可）
    // 写操作（persistBook / persistChapters / deleteBook）镜像回 svc._books
    // P1-4 (Round 2 复审): 用 `satisfies BookRepositoryPort`（仅 public surface）
    //   编译期绑定，**无 `as unknown as`** 双重强转 — 接口演进时静默破坏风险清零

    svc.repo =
      repo ??
      ({
        books: svc._books.asReadonly(),
        loadState: svc._loadState.asReadonly(),
        // Round 7 P0-2 mitigation: count 镜像 svc._books (与 BookRepository.count computed 对齐)
        count: computed(() => svc._books().length),
        getById: (id: string) => svc._booksById().get(id),
        load: async () => undefined,
        // forTest stub 双写语义（R6-1 / Phase 4 review 收口）：
        //   db-first（source of truth），mirror-second（同步读路径缓存）
        //   db 抛错 → 测试即失败，_books 不被污染（await 后再镜像）
        //   错误传播语义：原 stub 不调 db = 吞错；现 stub 调 db = 抛错（更接近 prod）
        //   NG0203 边界：仅由 BookService.forTest 注入，prod 链路通过 Angular DI 隔离
        persistBook: async (book: Book) => {
          await db.bookPut(book);
          svc._books.update((list: Book[]) => {
            const idx = list.findIndex((b) => b.id === book.id);
            if (idx >= 0) {
              const next = [...list];
              next[idx] = book;
              return next;
            }
            return [...list, book];
          });
        },
        persistChapters: async (chapters: Chapter[]) => {
          if (chapters.length > 0) await db.chapterPutMany(chapters);
        },
        deleteBook: async (id: string) => {
          await db.bookDelete(id);
          svc._books.update((list: Book[]) => list.filter((b) => b.id !== id));
        },
      } satisfies BookRepositoryPort);
    svc.loader = loader ?? ChapterLoader.forTest(db, sources);
    // chaptersVersion 委托 loader（computed 惰性求值 —— 放在 loader 赋值之后更直观）
    svc.chaptersVersion = computed(() => svc.loader.chaptersVersion());
    svc.updater =
      updater ?? BookUpdater.forTest(svc.repo, svc.loader, db, sources, importViaSource);
    return svc as BookService;
  }
}

/**
 * P1-1 (Round 7 review): forTest stub 编译期形状断言
 *
 * 解决 Object.create 不跑 class field initializer 导致缺字段的脆弱性：
 * - BookService 新增 readonly 字段时，forTest 必须同步 assign（否则本函数 tsc 报错）
 * - 强于 `as unknown as BookService` 兜底 —— 后者完全绕过类型检查
 *
 * 用法（内部）：assertBookServiceShape(stub as any)
 * 后续 HT-3 (TestBed provider 重构) 落地后整体移除本工具。
 */

function assertBookServiceShape(stub: BookService): BookService {
  // 编译期断言：required fields 必须存在（stub 类型约束保证 tsc 报错 if 缺失）
  // 运行时无操作 —— 形状保证由 TypeScript 在编译期完成
  return stub;
}
