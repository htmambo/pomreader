import { Injectable } from '@angular/core';
import PouchDB from 'pouchdb-browser';
import { Book } from '../models/book.model';
import { Chapter } from '../models/chapter.model';

/** Book PouchDB 文档（含嵌入的阅读进度）
 *  `_rev` 不显式声明——PouchDB 类型系统区分 `NewDocument`/`ExistingDocument` 自动扩展 */
export interface BookDoc {
  _id: string;            // book:{uuid}
  type: 'book';
  id: string;
  title: string;
  author: string;
  coverColor: string;
  /** 封面图片 URL（可选）；为空时 book-card 用 SVG + 底色 fallback */
  coverImageUrl?: string;
  chapterCount: number;
  totalChars: number;
  importedAt: string;
  source: 'local-txt' | 'online' | 'mock';
  sourceUrl?: string;
  /** 阅读进度（嵌入，与 bookId 强耦合） */
  progress?: {
    chapterIndex: number;
    scrollOffset?: number;
    updatedAt: string;
  };
}

/** Chapter PouchDB 文档（含正文） */
export interface ChapterDoc {
  _id: string;            // chapter:{bookId}{idx} —— 见 CHAPTER_SEP 注释
  type: 'chapter';
  bookId: string;
  index: number;
  title: string;
  content: string;
  sourceUrl?: string;
  loaded?: boolean;
}

/** 已存文档：必有 _rev（PouchDB get/allDocs 返回类型） */
type StoredBookDoc = BookDoc & PouchDB.Core.RevisionIdMeta;
type StoredChapterDoc = ChapterDoc & PouchDB.Core.RevisionIdMeta;

const DB_NAME = 'pomreader';
const BOOK_PREFIX = 'book:';
const CHAPTER_PREFIX = 'chapter:';
/** bookId 与 chapter idx 之间的不可见分隔符。
 *  选 ASCII Unit Separator (0x1F)：不会出现在合法 bookId（UUID / 在线时间戳）中，
 *  避免类似 `bookA` / `bookA-extra` 在 `_id` 前缀上撞车。 */
const CHAPTER_SEP = '';
/** Unicode 私有区最大字符，用于 allDocs 范围查询的 endkey */
const HIGH_CHAR = '￰';

/**
 * DbService — PouchDB 单例封装
 * 单一数据库 `pomreader`，按 _id 前缀分表：
 *   book:{uuid}                    → BookDoc（含阅读进度）
 *   chapter:{bookId}{idx}   → ChapterDoc（含正文）
 *
 * 浏览器（ng serve）+ Electron 渲染进程都直连 IndexedDB，无需 IPC。
 */
@Injectable({ providedIn: 'root' })
export class DbService {
  private readonly db = new PouchDB<BookDoc | ChapterDoc>(DB_NAME);
  /** 启动时一次性迁移旧 chapter _id 的 Promise
   *  上层读操作通过 ensureMigrated() await 避免迁移窗口期返回重复章节（R3-2） */
  private readonly migrationPromise: Promise<void>;

  constructor() {
    this.migrationPromise = this.migrateLegacyChapterIds();
  }

  /** 上层读操作（chapterAll / chapterGet / bookDelete 等）调用，避免迁移窗口期返回重复 */
  private async ensureMigrated(): Promise<void> {
    await this.migrationPromise;
  }

  // ============ Book 操作 ============

  async bookAll(): Promise<Book[]> {
    const res = await this.db.allDocs<BookDoc>({
      include_docs: true,
      startkey: BOOK_PREFIX,
      endkey: BOOK_PREFIX + HIGH_CHAR,
    });
    return res.rows
      .map((r) => r.doc)
      .filter((d): d is StoredBookDoc => !!d && d.type === 'book')
      .map((d) => this.bookDocToBook(d));
  }

  async bookGet(id: string): Promise<Book | null> {
    try {
      const doc = await this.db.get<BookDoc>(BOOK_PREFIX + id);
      return this.bookDocToBook(doc);
    } catch (e: unknown) {
      if (this.isNotFound(e)) return null;
      throw e;
    }
  }

  async bookPut(book: Book): Promise<void> {
    // rest-sibling 解构：防御外部 book 对象含 _id/type 字段污染 PouchDB 文档（N4）
    const { id, ...rest } = book;
    const _id = BOOK_PREFIX + id;
    const baseDoc: BookDoc = { _id, type: 'book', id, ...rest };
    await this.bookPutWithRetry(baseDoc, book.progress);
  }

  /**
   * 更新一本书的阅读进度（嵌入 Book 文档）。
   * 进度变更与编辑书籍信息可能并发：冲突时重试一次（最新 _rev 胜出）。
   */
  async bookUpdateProgress(
    bookId: string,
    chapterIndex: number,
    scrollOffset?: number,
  ): Promise<void> {
    const _id = BOOK_PREFIX + bookId;
    const progress = {
      chapterIndex,
      scrollOffset,
      updatedAt: new Date().toISOString(),
    };
    await this.bookUpdateWithRetry(_id, (doc) => {
      doc.progress = progress;
      return doc;
    });
  }

  /** 删除一本书并级联删除其所有章节 */
  async bookDelete(bookId: string): Promise<void> {
    await this.ensureMigrated();
    const _id = BOOK_PREFIX + bookId;
    const bookDoc = (await this.db.get<BookDoc>(_id)) as StoredBookDoc;
    const chapters = await this.chapterAllRaw(bookId);
    // 改用 bulkDocs 一次原子删除，避免 Promise.all 首个 reject 导致孤儿文档（N2）
    const removeDocs: PouchDB.Core.RemoveDocument[] = [
      bookDoc as PouchDB.Core.RemoveDocument,
      ...chapters.map((c) => c as PouchDB.Core.RemoveDocument),
    ];
    const results = await this.db.bulkDocs(
      removeDocs as unknown as PouchDB.Core.PutDocument<BookDoc | ChapterDoc>[],
    );
    const failures = results.filter(
      (r): r is PouchDB.Core.Error => 'error' in r && r.status !== 409,
    );
    if (failures.length > 0) {
      throw new Error(
        `bookDelete partial failure: ${failures.length}/${removeDocs.length} docs failed: ` +
          failures.map((f) => `${f.id ?? '?'}[${f.status ?? '?'}]`).join(', '),
      );
    }
  }

  // ============ Chapter 操作 ============

  async chapterAll(bookId: string): Promise<Chapter[]> {
    await this.ensureMigrated();
    const chapters = await this.chapterAllRaw(bookId);
    return chapters.map((d) => this.chapterDocToChapter(d));
  }

  private async chapterAllRaw(bookId: string): Promise<StoredChapterDoc[]> {
    const start = CHAPTER_PREFIX + bookId + CHAPTER_SEP;
    const res = await this.db.allDocs<ChapterDoc>({
      include_docs: true,
      startkey: start,
      endkey: start + HIGH_CHAR,
    });
    return res.rows
      .map((r) => r.doc)
      .filter((d): d is StoredChapterDoc => !!d && d.type === 'chapter')
      .sort((a, b) => a.index - b.index);
  }

  async chapterGet(bookId: string, idx: number): Promise<Chapter | null> {
    await this.ensureMigrated();
    try {
      const doc = await this.db.get<ChapterDoc>(
        CHAPTER_PREFIX + bookId + CHAPTER_SEP + idx,
      );
      return this.chapterDocToChapter(doc);
    } catch (e: unknown) {
      if (this.isNotFound(e)) return null;
      throw e;
    }
  }

  async chapterPut(chapter: Chapter): Promise<void> {
    // rest-sibling 解构：防御外部 chapter 对象含 _id/type 字段污染 PouchDB 文档（N4）
    const { bookId, index, ...rest } = chapter;
    const _id = CHAPTER_PREFIX + bookId + CHAPTER_SEP + index;
    const baseDoc: ChapterDoc = { _id, type: 'chapter', bookId, index, ...rest };
    await this.chapterPutWithRetry(baseDoc);
  }

  async chapterPutMany(chapters: Chapter[]): Promise<void> {
    if (chapters.length === 0) return;
    // 等迁移完成，避免与 migrateLegacyChapterIds 写入新 _id 撞 409（N1）
    await this.ensureMigrated();
    // 一次性 bulk 写，避免千章规模下串行 N 次 IndexedDB 事务
    const docs: ChapterDoc[] = chapters.map((c) => ({
      _id: CHAPTER_PREFIX + c.bookId + CHAPTER_SEP + c.index,
      type: 'chapter',
      ...c,
    }));
    const res = await this.db.bulkDocs(docs);
    // 过滤 409（已有相同 _id 通常表示幂等写入）；其他失败 throw
    const failures = res.filter(
      (r): r is PouchDB.Core.Error => 'error' in r && r.status !== 409,
    );
    if (failures.length > 0) {
      const detail = failures
        .map((f) => `${f.id ?? '?'}[${f.name ?? f.status ?? '?'}]`)
        .join(', ');
      throw new Error(`chapter bulk write failed (${failures.length}/${docs.length}): ${detail}`);
    }
  }

  /**
   * 迁移旧 chapter _id（`chapter:{bookId}:{idx}` 冒号分隔）到新格式
   * （`chapter:{bookId}{idx}` Unit Separator 分隔）。
   * Round 2 review 指出：CHAPTER_SEP 改为 U+001F 是 breaking change。
   * 用 allDocs({include_docs: true}) 一次拉取（R3-1：消除 N+1）。
   * 检查 bulkDocs 返回结果过滤非 409 失败（R3-3）。
   * 上层读操作通过 ensureMigrated() await 避免迁移窗口期重复章节（R3-2）。
   */
  private async migrateLegacyChapterIds(): Promise<void> {
    try {
      const res = await this.db.allDocs<ChapterDoc>({
        startkey: CHAPTER_PREFIX,
        endkey: CHAPTER_PREFIX + HIGH_CHAR,
        include_docs: true,
      });
      const oldDocs = res.rows
        .map((r) => r.doc)
        .filter(
          (d): d is StoredChapterDoc =>
            !!d &&
            d.type === 'chapter' &&
            !d._id.includes(CHAPTER_SEP) &&
            !(d as { _deleted?: boolean })._deleted,
        );
      if (oldDocs.length === 0) return;

      const migrated = oldDocs
        .map((doc): (ChapterDoc & { _rev: string }) | null => {
          const m = doc._id.match(/^chapter:(.+):(\d+)$/);
          if (!m) return null;
          const [, bookId, idxStr] = m;
          const idx = parseInt(idxStr, 10);
          if (Number.isNaN(idx)) return null;
          return { ...doc, _id: CHAPTER_PREFIX + bookId + CHAPTER_SEP + idx };
        })
        .filter((d): d is ChapterDoc & { _rev: string } => !!d);

      // PouchDB 改 _id 等价于「删旧 + 建新」
      const tombstones = oldDocs.map((d) => ({
        _id: d._id,
        _rev: d._rev,
        _deleted: true as const,
      }));
      // 显式联合类型（N6：替代 as unknown as 双重断言）
      type MigrationBatch = (ChapterDoc & { _rev: string }) | PouchDB.Core.RemoveDocument;
      const batch: MigrationBatch[] = [...tombstones, ...migrated];
      const results = await this.db.bulkDocs(
        batch as PouchDB.Core.PutDocument<ChapterDoc>[],
      );

      // 仅记录非 409 失败（409 是并发冲突，下次启动会再尝试旧 _id → 幂等）
      const fatalFailures = results.filter(
        (r) => 'error' in r && r.status !== 409,
      );
      if (fatalFailures.length > 0) {
        console.warn(
          '[DbService] legacy chapter migration partial failure:',
          fatalFailures.map((f) => ('id' in f ? f.id : 'unknown')),
        );
      }
    } catch (e) {
      console.warn('[DbService] legacy chapter _id migration failed:', e);
    }
  }

  // ============ Seed + 诊断 ============

  /**
   * 首次启动 seed：books 集合为空时从 books.json 灌入 mock Book metadata
   * （chapter 内容留空，按需抓取或本地导入时填充）
   * 判空基于 bookAll() 而非 info.doc_count：后者含 design docs，未来引入 views 会误判。
   */
  async seedIfEmpty(): Promise<{ seeded: boolean; bookCount: number }> {
    const existing = await this.bookAll();
    if (existing.length > 0) {
      return { seeded: false, bookCount: existing.length };
    }
    const res = await fetch('assets/data/books.json');
    if (!res.ok) {
      // 资源不可用（某些 Electron 模式或 SSR 阶段），跳过 seed
      return { seeded: false, bookCount: 0 };
    }
    const seedBooks = (await res.json()) as Book[];
    for (const b of seedBooks) {
      await this.bookPut(b);
    }
    return { seeded: true, bookCount: seedBooks.length };
  }

  /** 清空整个数据库（仅用于调试 / 重置） */
  async destroy(): Promise<void> {
    await this.db.destroy();
  }

  // ============ 私有工具 ============

  private isNotFound(e: unknown): boolean {
    return (
      typeof e === 'object' &&
      e !== null &&
      'status' in e &&
      (e as { status?: number }).status === 404
    );
  }

  /** 状态码：PouchDB 文档写入冲突（_rev 不匹配） */
  private isConflict(e: unknown): boolean {
    return (
      typeof e === 'object' &&
      e !== null &&
      'status' in e &&
      (e as { status?: number }).status === 409
    );
  }

  /**
   * Book 写入（含 progress 保留），遇 409 冲突重试一次。
   * newProgress 来自外部 book 对象；已有 progress 时优先保留（避免编辑覆盖自动保存的阅读进度）。
   */
  private async bookPutWithRetry(baseDoc: BookDoc, newProgress?: BookDoc['progress']): Promise<void> {
    const tryWrite = async (): Promise<void> => {
      const doc: BookDoc & { _rev?: string } = { ...baseDoc };
      try {
        const existing = (await this.db.get<BookDoc>(baseDoc._id)) as StoredBookDoc;
        doc._rev = existing._rev;
        if (!newProgress && existing.progress) doc.progress = existing.progress;
      } catch (e: unknown) {
        if (!this.isNotFound(e)) throw e;
      }
      await this.db.put(doc as PouchDB.Core.PutDocument<BookDoc>);
    };
    try {
      await tryWrite();
    } catch (e: unknown) {
      if (!this.isConflict(e)) throw e;
      await tryWrite(); // 冲突：重试一次拿最新 _rev
    }
  }

  /** Book 局部字段更新，遇 409 冲突重试一次（mutate 修改并写回） */
  private async bookUpdateWithRetry(
    _id: string,
    mutate: (doc: StoredBookDoc) => StoredBookDoc,
  ): Promise<void> {
    const tryWrite = async (): Promise<void> => {
      const doc = (await this.db.get<BookDoc>(_id)) as StoredBookDoc;
      await this.db.put(mutate(doc));
    };
    try {
      await tryWrite();
    } catch (e: unknown) {
      if (!this.isConflict(e)) throw e;
      await tryWrite();
    }
  }

  /** Chapter 写入，遇 409 冲突重试一次 */
  private async chapterPutWithRetry(baseDoc: ChapterDoc): Promise<void> {
    const tryWrite = async (): Promise<void> => {
      const doc: ChapterDoc & { _rev?: string } = { ...baseDoc };
      try {
        const existing = (await this.db.get<ChapterDoc>(baseDoc._id)) as StoredChapterDoc;
        doc._rev = existing._rev;
      } catch (e: unknown) {
        if (!this.isNotFound(e)) throw e;
      }
      await this.db.put(doc as PouchDB.Core.PutDocument<ChapterDoc>);
    };
    try {
      await tryWrite();
    } catch (e: unknown) {
      if (!this.isConflict(e)) throw e;
      await tryWrite();
    }
  }

  private bookDocToBook(doc: StoredBookDoc): Book {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { _id, _rev, type, ...rest } = doc;
    return rest as Book;
  }

  private chapterDocToChapter(doc: StoredChapterDoc): Chapter {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { _id, _rev, type, ...rest } = doc;
    return rest as Chapter;
  }
}