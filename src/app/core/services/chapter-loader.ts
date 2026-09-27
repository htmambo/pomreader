import { Injectable, Signal, WritableSignal, signal, inject } from '@angular/core';
import { Chapter } from '../models/chapter.model';
import { BookSourceRegistry } from '../book-source/book-source.registry';
import { CatalogEntry } from '../book-source/book-source.adapter';
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
      // 缓存 miss 路径：直接把单章写进新数组（覆盖写）
      const next = new Map(m);
      const newList = list
        ? list.map((c) => (c.index === index ? updated : c))
        : [updated];
      next.set(bookId, newList);
      return next;
    });
    this.chaptersVersion.update((v) => v + 1);
  }

  /**
   * 删除某本书的所有章节缓存（BookService.deleteBook 内调用）
   * 与 deleteBook 同步级联清理，避免内存泄漏
   */
  evictCache(bookId: string): void {
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
    return loader as ChapterLoader;
  }
}