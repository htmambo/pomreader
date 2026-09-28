import { Injectable, inject } from '@angular/core';
import { type Book } from '../models/book.model';
import { type Chapter } from '../models/chapter.model';
import { BookSourceRegistry } from '../book-source/book-source.registry';
import { type CatalogEntry } from '../book-source/book-source.adapter';
import { ImportViaSourceService } from '../book-source/import-via-source.service';
import { FetchError } from '../book-source/fetch-error';
import { BookRepository, type BookRepositoryPort } from './book.repository';
import { ChapterLoader } from './chapter-loader';
import { DbService } from './db.service';

/** 在线导入预加载章节数 */
const PRELOAD_COUNT = 3;

/**
 * BookUpdater — 高层动作（在线导入 / 换源 / 刷新元数据 / 进度更新）（EVO-1）
 *
 * 职责（编排层）：
 * - importOnlineBook：目录入库 + 预加载前 N 章
 * - changeBookSource：换源（拆旧书重灌；保留用户绑定字段）
 * - refreshChapters：增量追加新章节
 * - refreshBookInfo：仅刷新元数据（不动章节 / 进度）
 * - updateProgress：写 Book.progress 字段
 *
 * 不持有：_books / _chaptersCache（→ Repository / Loader）；DbService 直接调用（→ Repository / Loader）
 */
@Injectable({ providedIn: 'root' })
export class BookUpdater {
  // architect #4 / Phase 4 收口：字段类型改为 BookRepositoryPort 与 BookService 对齐
  private readonly repo: BookRepositoryPort = inject(BookRepository);
  private readonly loader = inject(ChapterLoader);
  private readonly db = inject(DbService);
  private readonly sources = inject(BookSourceRegistry);
  private readonly importViaSource = inject(ImportViaSourceService);

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
    await this.repo.persistBook(book);
    await this.repo.persistChapters(chapters);
    // 预加载前 N 章（失败静默，阅读时重试）
    await Promise.allSettled(
      chapters.slice(0, PRELOAD_COUNT).map((c) => this.loader.loadChapterContent(book.id, c.index)),
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
    const oldBook = this.repo.getById(bookId);
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
      coverImageUrl: resolved.coverImageUrl || oldBook.coverImageUrl,
      sourceUrl: newUrl,
      bookSourceUuid,
      chapterCount: newChapters.length,
      totalChars: newChapters.length * 2000,
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

    await this.repo.persistBook(merged);
    await this.repo.persistChapters(newChapters);

    // 预加载新源前 N 章（失败静默）
    await Promise.allSettled(
      newChapters
        .slice(0, PRELOAD_COUNT)
        .map((c) => this.loader.loadChapterContent(bookId, c.index)),
    );
  }

  /**
   * 更新最新章节（同源增量追加）
   */
  async refreshChapters(
    bookId: string,
  ): Promise<{ added: number; skipped: number; total: number }> {
    const oldBook = this.repo.getById(bookId);
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

    // URL 去重：取内存缓存（异步拉到 PouchDB 仅在缓存 miss 时）
    let chapters = this.loader.getChaptersSync(bookId);
    if (!chapters) {
      chapters = await this.db.chapterAll(bookId);
    }
    const existingUrls = new Set(chapters.map((c) => c.sourceUrl).filter((u): u is string => !!u));

    const startIndex = chapters.length;
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
      return { added: 0, skipped, total: chapters.length };
    }

    const merged: Book = {
      ...oldBook,
      chapterCount: chapters.length + added,
      totalChars: (chapters.length + added) * 2000,
    };
    await this.repo.persistBook(merged);
    await this.repo.persistChapters([...chapters, ...newChapters]);

    return { added, skipped, total: chapters.length + added };
  }

  /**
   * 更新作品信息（同源元数据刷新）
   */
  async refreshBookInfo(bookId: string): Promise<Book> {
    const oldBook = this.repo.getById(bookId);
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

    await this.repo.persistBook(merged);
    return merged;
  }

  /**
   * 更新阅读进度（嵌入 Book 文档）
   */
  async updateProgress(bookId: string, chapterIndex: number, scrollOffset?: number): Promise<void> {
    try {
      const oldBook = this.repo.getById(bookId);
      if (!oldBook) return;
      const now = new Date().toISOString();
      const progress = { chapterIndex, scrollOffset, updatedAt: now };
      await this.repo.persistBook({
        ...oldBook,
        progress,
        lastReadAt: now,
      });
    } catch (e) {
      console.warn('[BookUpdater.updateProgress] failed', e);
    }
  }

  /**
   * 测试入口：手动注入依赖（绕开 Angular DI 上下文 NG0203）。
   */

  static forTest(
    repo: BookRepositoryPort,
    loader: ChapterLoader,
    db: DbService,
    sources: BookSourceRegistry,
    importViaSource: ImportViaSourceService,
  ): BookUpdater {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const u: any = Object.create(BookUpdater.prototype);
    u.repo = repo;
    u.loader = loader;
    u.db = db;
    u.sources = sources;
    u.importViaSource = importViaSource;
    return u as BookUpdater;
  }
}
