import { Injectable, signal, inject, type WritableSignal } from '@angular/core';
import { type Chapter } from '../models/chapter.model';
import { BookSourceRegistry } from '../book-source/book-source.registry';
import { type CatalogEntry } from '../book-source/book-source.adapter';
import { DbService } from './db.service';

/**
 * ChapterLoader — 章节正文加载与缓存管理（EVO-1）
 *
 * 职责（章节层唯一真相源）：
 * - 内存 signal 缓存：`_chaptersCache: WritableSignal<Map<bookId, Chapter[]>>`
 * - 缓存版本号：`chaptersVersion`（reader effect 监听以触发章节正文刷新）
 * - 6 个公开动作：
 *   - getChapters / getChaptersSync（缓存 miss → PouchDB）
 *   - loadChapterContent / refreshChapter（按需抓正文）
 *   - clearChapterContents / updateChapter（清空 / 局部字段更新）
 *
 * 不持有：books signal（→ BookRepository）；换源 / 刷新元数据 / 进度（→ BookUpdater）
 */
@Injectable({ providedIn: 'root' })
export class ChapterLoader {
  private readonly db = inject(DbService);
  private readonly sources = inject(BookSourceRegistry);

  private readonly _chaptersCache: WritableSignal<Map<string, Chapter[]>> = signal(new Map());
  /** 章节缓存版本号——reader effect 监听以刷新在线章节正文 */
  readonly chaptersVersion = signal(0);
  /**
   * 已经从 `chapter-body:` 文档读过一次正文的章节（key = `bookId:index`）。
   *
   * 作用：幂等 + 防死循环。reader 的 effect 会在 `chapters` 变化时重跑，
   * 若某章正文为空（正文文档不存在 / 正文本身就是空串），每次重跑都会再读一次 db，
   * 读回来还是空 → `chapters` 被再次替换 → effect 再跑 → 无限循环。
   * 读过一次就不再重复读；正文后来由 `refreshChapter` / `loadChapterContent` 写入时，
   * 缓存里已有 content，`loadChapterBody` 直接返回 true。
   */
  private readonly _bodyFetched = new Set<string>();

  /** 异步拉某书全部章节；首次成功后填充内存缓存 */
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

  /**
   * 直接写入内存缓存（导入 / 换源 / 增量刷新等「已知全量章节」的场景）。
   *
   * 之前这些路径只填 BookService 自己的镜像缓存，ChapterLoader 的缓存仍为空
   * → 阅读页随后仍要回 PouchDB 拉一次目录。统一到这里后缓存只有一个真相源。
   *
   * @param chapters 空数组表示「本次没有章节信息」—— 不动缓存
   *   （如仅更新书籍元数据时调用 addBook(book, [])，不能把已有章节缓存清空）
   */
  cacheChapters(bookId: string, chapters: Chapter[]): void {
    if (chapters.length === 0) return;
    this._chaptersCache.update((m) => {
      const next = new Map(m);
      next.set(bookId, chapters);
      return next;
    });
  }

  /**
   * 从库中读取某章正文并写入内存缓存。
   *
   * 正文存放在独立的 `chapter-body:` 文档里，目录（chapterAll）**不返回正文**
   * —— 本地书 / 重启后重开的在线书首次阅读时需要按章补齐。
   *
   * 幂等：同一章只读一次 db（`_bodyFetched` 记账），避免 reader effect 重跑时
   * 反复读库并因「读到空正文 → 替换 chapters → effect 再跑」形成死循环。
   *
   * @returns 是否成功读到正文
   */
  async loadChapterBody(bookId: string, index: number): Promise<boolean> {
    const list = this._chaptersCache().get(bookId);
    const ch = list?.find((c) => c.index === index);
    if (!ch) return false;
    if (ch.content) return true; // 内存里已有正文
    const key = `${bookId}:${index}`;
    if (this._bodyFetched.has(key)) return false; // 已读过一次，不再重复读
    this._bodyFetched.add(key);
    const content = await this.db.chapterContent(bookId, index);
    if (content === null) return false;
    this.patchCache(bookId, index, { content });
    this.chaptersVersion.update((v) => v + 1);
    return true;
  }

  /**
   * 局部更新内存缓存中的某章（避免整表 map 闭包拷贝）。
   */
  private patchCache(bookId: string, index: number, patch: Partial<Chapter>): void {
    this._chaptersCache.update((m) => {
      const list = m.get(bookId);
      if (!list) return m;
      const next = new Map(m);
      const nextList = list.slice();
      const pos = nextList.findIndex((c) => c.index === index);
      if (pos >= 0) nextList[pos] = { ...nextList[pos], ...patch };
      next.set(bookId, nextList);
      return next;
    });
  }

  /** 按需加载某章正文（fetch + 写 PouchDB + 刷新缓存） */
  async loadChapterContent(bookId: string, index: number): Promise<void> {
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
      this.patchCache(bookId, index, { content, loaded: true });
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
      this.patchCache(bookId, index, { content, loaded: true });
      this.chaptersVersion.update((v) => v + 1);
      return true;
    } catch {
      return false;
    }
  }

  /** 清空全书章节正文缓存（删除正文文档 + 复位 loaded；章节元数据/目录保留） */
  async clearChapterContents(bookId: string): Promise<void> {
    const cached = this._chaptersCache().get(bookId) ?? (await this.db.chapterAll(bookId));
    if (!cached || cached.length === 0) return;
    // 删除全部 chapter-body 文档并把元数据的 loaded 复位
    await this.db.chapterBodiesClear(bookId);
    this._bodyFetched.clear();
    this._chaptersCache.update((m) => {
      const next = new Map(m);
      next.set(
        bookId,
        cached.map((c) => ({ ...c, content: '', loaded: false })),
      );
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
      // 缓存未加载时不写入：单章数组会被 getChapters/getChaptersSync 当成完整目录
      // （缓存命中即跳过 db）。db 已在上面 chapterPut，下次读取懒加载全量列表
      if (!list) return m;
      const next = new Map(m);
      next.set(
        bookId,
        list.map((c) => (c.index === index ? updated : c)),
      );
      return next;
    });
    this.chaptersVersion.update((v) => v + 1);
  }

  /**
   * 删除某本书的所有章节缓存（BookService.deleteBook 内调用）
   * 与 deleteBook 同步级联清理，避免内存泄漏
   */
  evictCache(bookId: string): void {
    this._bodyFetched.clear();
    this._chaptersCache.update((m) => {
      const next = new Map(m);
      next.delete(bookId);
      return next;
    });
  }

  /**
   * 测试入口：手动注入依赖（绕开 Angular DI 上下文 NG0203）。
   */

  static forTest(db: DbService, sources: BookSourceRegistry): ChapterLoader {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const loader: any = Object.create(ChapterLoader.prototype);
    loader.db = db;
    loader.sources = sources;
    loader._chaptersCache = signal(new Map());
    loader.chaptersVersion = signal(0);
    loader._bodyFetched = new Set<string>();
    return loader as ChapterLoader;
  }
}
