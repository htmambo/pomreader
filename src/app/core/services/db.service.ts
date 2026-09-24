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
  _id: string;            // chapter:{bookId}:{idx}
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
/** Unicode 私有区最大字符，用于 allDocs 范围查询的 endkey */
const HIGH_CHAR = '￰';

/**
 * DbService — PouchDB 单例封装
 * 单一数据库 `pomreader`，按 _id 前缀分表：
 *   book:{uuid}             → BookDoc（含阅读进度）
 *   chapter:{bookId}:{idx}  → ChapterDoc（含正文）
 *
 * 浏览器（ng serve）+ Electron 渲染进程都直连 IndexedDB，无需 IPC。
 */
@Injectable({ providedIn: 'root' })
export class DbService {
  private readonly db = new PouchDB<BookDoc | ChapterDoc>(DB_NAME);

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
    const _id = BOOK_PREFIX + book.id;
    const doc: BookDoc = {
      _id,
      type: 'book',
      ...book,
    };
    try {
      const existing = await this.db.get<BookDoc>(_id);
      // 用 _rev（来自 ExistingDocument）+ 保留已有 progress
      (doc as StoredBookDoc)._rev = existing._rev;
      if (!book.progress && existing.progress) doc.progress = existing.progress;
    } catch (e: unknown) {
      if (!this.isNotFound(e)) throw e;
    }
    await this.db.put(doc);
  }

  /**
   * 更新一本书的阅读进度（嵌入 Book 文档）
   */
  async bookUpdateProgress(
    bookId: string,
    chapterIndex: number,
    scrollOffset?: number,
  ): Promise<void> {
    const _id = BOOK_PREFIX + bookId;
    const doc = (await this.db.get<BookDoc>(_id)) as StoredBookDoc;
    doc.progress = {
      chapterIndex,
      scrollOffset,
      updatedAt: new Date().toISOString(),
    };
    await this.db.put(doc);
  }

  /** 删除一本书并级联删除其所有章节 */
  async bookDelete(bookId: string): Promise<void> {
    const _id = BOOK_PREFIX + bookId;
    const bookDoc = (await this.db.get<BookDoc>(_id)) as StoredBookDoc;
    const chapters = await this.chapterAllRaw(bookId);
    await Promise.all([
      this.db.remove(bookDoc as PouchDB.Core.RemoveDocument),
      ...chapters.map((c) => this.db.remove(c as PouchDB.Core.RemoveDocument)),
    ]);
  }

  // ============ Chapter 操作 ============

  async chapterAll(bookId: string): Promise<Chapter[]> {
    const chapters = await this.chapterAllRaw(bookId);
    return chapters.map((d) => this.chapterDocToChapter(d));
  }

  private async chapterAllRaw(bookId: string): Promise<StoredChapterDoc[]> {
    const start = CHAPTER_PREFIX + bookId + ':';
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
    try {
      const doc = await this.db.get<ChapterDoc>(
        CHAPTER_PREFIX + bookId + ':' + idx,
      );
      return this.chapterDocToChapter(doc);
    } catch (e: unknown) {
      if (this.isNotFound(e)) return null;
      throw e;
    }
  }

  async chapterPut(chapter: Chapter): Promise<void> {
    const _id = CHAPTER_PREFIX + chapter.bookId + ':' + chapter.index;
    const doc: ChapterDoc = {
      _id,
      type: 'chapter',
      ...chapter,
    };
    try {
      const existing = await this.db.get<ChapterDoc>(_id);
      (doc as StoredChapterDoc)._rev = existing._rev;
    } catch (e: unknown) {
      if (!this.isNotFound(e)) throw e;
    }
    await this.db.put(doc);
  }

  async chapterPutMany(chapters: Chapter[]): Promise<void> {
    // 串行写：避免并发 _rev 冲突
    for (const c of chapters) {
      await this.chapterPut(c);
    }
  }

  // ============ Seed + 诊断 ============

  /**
   * 首次启动 seed：PouchDB 空时从 books.json 灌入 mock Book metadata
   * （chapter 内容留空，按需抓取或本地导入时填充）
   */
  async seedIfEmpty(): Promise<{ seeded: boolean; bookCount: number }> {
    const info = await this.db.info();
    const docCount = (info as { doc_count?: number }).doc_count ?? 0;
    if (docCount > 0) {
      const books = await this.bookAll();
      return { seeded: false, bookCount: books.length };
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

  private bookDocToBook(doc: StoredBookDoc): Book {
    const { _id: _i, _rev: _r, type: _t, ...rest } = doc;
    void _i;
    void _r;
    void _t;
    return rest as Book;
  }

  private chapterDocToChapter(doc: StoredChapterDoc): Chapter {
    const { _id: _i, _rev: _r, type: _t, ...rest } = doc;
    void _i;
    void _r;
    void _t;
    return rest as Chapter;
  }
}
