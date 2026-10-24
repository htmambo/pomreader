import { Injectable } from '@angular/core';
import { type Book } from '../models/book.model';
import { type Chapter } from '../models/chapter.model';
import { type BookshelfGroup } from '../models/bookshelf-group.model';
import { classifyBulkResults, formatBulkFatalMessage } from '../db/bulk-result';

/** Book PouchDB 文档（含嵌入的阅读进度）
 *  `_rev` 不显式声明——PouchDB 类型系统区分 `NewDocument`/`ExistingDocument` 自动扩展 */
export interface BookDoc {
  _id: string; // book:{uuid}
  type: 'book';
  id: string;
  title: string;
  author: string;
  /** 题材/类型（可选；用于封面生成器的 kind 文案） */
  kind?: string;
  /** 封面图片 URL（可选）；为空时 book-card 显示「暂无封面」占位 */
  coverImageUrl?: string;
  chapterCount: number;
  totalChars: number;
  importedAt: string;
  /** 最后阅读时间（ISO 字符串）；随进度更新一同刷新 */
  lastReadAt?: string;
  source: 'local-txt' | 'online' | 'mock' | 'auto-import';
  sourceUrl?: string;
  /** 锚定具体书源（legado meta.uuid 全局唯一）；详见 Book.bookSourceUuid */
  bookSourceUuid?: string;
  /** 所属书架分类 id 列表（多分类）；历史文档无此字段，读侧兜底为 [] */
  groupIds?: string[];
  /** 阅读进度（嵌入，与 bookId 强耦合） */
  progress?: {
    chapterIndex: number;
    scrollOffset?: number;
    updatedAt: string;
  };
}

/** BookshelfGroup PouchDB 文档（书架分类，独立于 Book 文档） */
export interface GroupDoc {
  _id: string; // group:{uuid}
  type: 'group';
  id: string;
  name: string;
  createdAt: string;
}

/** Chapter PouchDB 文档（含正文） */
export interface ChapterDoc {
  _id: string; // chapter:{bookId}{idx} —— 见 CHAPTER_SEP 注释
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
type StoredGroupDoc = GroupDoc & PouchDB.Core.RevisionIdMeta;

/** pouchdb-browser 的构造器签名。
 *  该包是 CommonJS `export =`，运行时经打包器互操作后以 default 暴露构造器；
 *  只声明所需的最小构造契约（`new (name)` → 实例），不引入包的静态 API。 */
type PouchDbConstructor = new (name: string) => PouchDB.Database<BookDoc | ChapterDoc>;

const DB_NAME = 'pomreader';
const BOOK_PREFIX = 'book:';
const CHAPTER_PREFIX = 'chapter:';
const GROUP_PREFIX = 'group:';
/** bookId 与 chapter idx 之间的不可见分隔符。
 *  选 ASCII Unit Separator (0x1F)：不会出现在合法 bookId（UUID / 在线时间戳）中，
 *  避免类似 `bookA` / `bookA-extra` 在 `_id` 前缀上撞车。 */
const CHAPTER_SEP = '';
/** allDocs 范围查询的 endkey 上界：取 U+FFF0（远高于任何合法 bookId 的码位） */
const HIGH_CHAR = '￰';

/**
 * keys 模式的返回行有两类：命中行（带 doc）与「id 查无此文档」的 error 行（无 doc）。
 * 统一取出正文：error 行 → undefined（调用方按“查不到”处理）。
 */
function rowDoc<Content extends object>(
  row: PouchDB.Core.AllDocsWithKeysResponse<Content>['rows'][number],
): unknown {
  return 'doc' in row ? row.doc : undefined;
}

/**
 * PouchDB 最小操作面——DbService 实际用到的 5 个方法。
 * 显式定义（而非 Pick PouchDB 重载签名）以便 IPC 代理实现。
 */
interface PouchBackend {
  allDocs<Content extends object>(
    options: PouchDB.Core.AllDocsWithinRangeOptions,
  ): Promise<PouchDB.Core.AllDocsResponse<Content>>;
  /**
   * 按 id 批量取文档（含正文）：PouchDB 的 allDocs({keys, include_docs}) 在一次事务里
   * 返回全部命中文档——缺失 id 返回无 doc 的 error 行，已删文档返回 doc=null。
   * 用于「先元数据扫描定位候选、再一次性取正文」，把 N 次 get 往返压成 1 次。
   */
  allDocsByKeys<Content extends object>(
    keys: string[],
  ): Promise<PouchDB.Core.AllDocsWithKeysResponse<Content>>;
  get<Content extends object>(
    docId: string,
  ): Promise<PouchDB.Core.Document<Content> & PouchDB.Core.GetMeta>;
  put<Content extends object>(
    doc: PouchDB.Core.PutDocument<Content>,
  ): Promise<PouchDB.Core.Response>;
  bulkDocs<Content extends object>(
    docs: PouchDB.Core.PutDocument<Content>[],
  ): Promise<Array<PouchDB.Core.Response | PouchDB.Core.Error>>;
  destroy(): Promise<void>;
}

/** preload 暴露的 DB 桥（electron/preload.ts dbRequest） */
interface DbBridgeResponse {
  ok: boolean;
  result?: unknown;
  error?: { status?: number; name?: string; message?: string };
}
type DbBridgeRequest = (op: string, args: unknown[]) => Promise<DbBridgeResponse>;

/**
 * IPC 后端：把 PouchDB 调用转发给隐藏 DB 窗口（file:// origin 的 IndexedDB）。
 * 错误包络 {status, name, message} 原样抛出，保持 404 / 409 判定语义不变。
 */
class IpcPouchBackend implements PouchBackend {
  constructor(private readonly request: DbBridgeRequest) {}

  private async call<T>(op: string, args: unknown[]): Promise<T> {
    const res = await this.request(op, args);
    if (!res.ok) {
      throw res.error ?? new Error(`db ${op} failed`);
    }
    return res.result as T;
  }

  allDocs<Content extends object>(
    options: PouchDB.Core.AllDocsWithinRangeOptions,
  ): Promise<PouchDB.Core.AllDocsResponse<Content>> {
    return this.call('allDocs', [options]);
  }

  allDocsByKeys<Content extends object>(
    keys: string[],
  ): Promise<PouchDB.Core.AllDocsWithKeysResponse<Content>> {
    return this.call('allDocs', [{ keys, include_docs: true }]);
  }

  get<Content extends object>(
    docId: string,
  ): Promise<PouchDB.Core.Document<Content> & PouchDB.Core.GetMeta> {
    return this.call('get', [docId]);
  }

  put<Content extends object>(
    doc: PouchDB.Core.PutDocument<Content>,
  ): Promise<PouchDB.Core.Response> {
    return this.call('put', [doc]);
  }

  bulkDocs<Content extends object>(
    docs: PouchDB.Core.PutDocument<Content>[],
  ): Promise<Array<PouchDB.Core.Response | PouchDB.Core.Error>> {
    return this.call('bulkDocs', [docs]);
  }

  async destroy(): Promise<void> {
    await this.call('destroy', []);
  }
}

/**
 * 浏览器后端：按需动态加载 pouchdb-browser。
 * PouchDB 体积较大，静态导入会整体进入主 chunk；动态 import 使其落入独立 lazy chunk，
 * 仅纯浏览器环境（ng serve / 打包后的 browser 目录）需要加载。
 * 打开数据库的 Promise 缓存在实例上：并发首次调用共享一次模块加载与一次实例化；
 * 加载失败时清空被拒绝的 Promise，避免它毒化整个会话。
 * 注意：清缓存只重置「本后端的加载尝试」；若失败发生在动态 import 的模块求值阶段，
 * 模块系统可能已缓存该失败结果，后续重试仍会得到同一加载错误。
 */
class BrowserPouchBackend implements PouchBackend {
  private instance: Promise<PouchDB.Database<BookDoc | ChapterDoc>> | null = null;

  constructor(private readonly loader: () => Promise<PouchDB.Database<BookDoc | ChapterDoc>>) {}

  private db(): Promise<PouchDB.Database<BookDoc | ChapterDoc>> {
    if (!this.instance) {
      this.instance = this.loader().catch((e: unknown) => {
        this.instance = null; // 失败后清掉被拒绝的 Promise，允许下次调用重新尝试加载
        throw e;
      });
    }
    return this.instance;
  }

  async allDocs<Content extends object>(
    options: PouchDB.Core.AllDocsWithinRangeOptions,
  ): Promise<PouchDB.Core.AllDocsResponse<Content>> {
    const db = await this.db();
    // 真实实例的 Content 固定为 BookDoc | ChapterDoc，与接口的独立 Content 参数不同源
    return (await db.allDocs<Content>(options)) as unknown as PouchDB.Core.AllDocsResponse<Content>;
  }

  async get<Content extends object>(
    docId: string,
  ): Promise<PouchDB.Core.Document<Content> & PouchDB.Core.GetMeta> {
    const db = await this.db();
    return (await db.get<Content>(docId)) as unknown as PouchDB.Core.Document<Content> &
      PouchDB.Core.GetMeta;
  }

  async allDocsByKeys<Content extends object>(
    keys: string[],
  ): Promise<PouchDB.Core.AllDocsWithKeysResponse<Content>> {
    const db = await this.db();
    const options: PouchDB.Core.AllDocsWithKeysOptions = { keys, include_docs: true };
    const res = await db.allDocs<Content>(options);
    return res as unknown as PouchDB.Core.AllDocsWithKeysResponse<Content>;
  }

  async put<Content extends object>(
    doc: PouchDB.Core.PutDocument<Content>,
  ): Promise<PouchDB.Core.Response> {
    const db = await this.db();
    const res = await db.put(doc as unknown as PouchDB.Core.PutDocument<BookDoc | ChapterDoc>);
    return res as PouchDB.Core.Response;
  }

  async bulkDocs<Content extends object>(
    docs: PouchDB.Core.PutDocument<Content>[],
  ): Promise<Array<PouchDB.Core.Response | PouchDB.Core.Error>> {
    const db = await this.db();
    const res = await db.bulkDocs(
      docs as unknown as PouchDB.Core.PutDocument<BookDoc | ChapterDoc>[],
    );
    return res as Array<PouchDB.Core.Response | PouchDB.Core.Error>;
  }

  async destroy(): Promise<void> {
    const db = await this.db();
    await db.destroy();
    // 销毁后的实例不可再用：清空缓存，下次调用重新打开一个同名空库
    this.instance = null;
  }
}

/** 打开浏览器端数据库：动态 import 使 pouchdb-browser 落在独立 lazy chunk */
function openBrowserDatabase(): Promise<PouchDB.Database<BookDoc | ChapterDoc>> {
  return import('pouchdb-browser').then((module) => {
    // CommonJS `export =` 包经 esbuild/Vite 互操作后以 default 暴露构造器
    const ctor = (module as unknown as { default?: PouchDbConstructor }).default;
    if (!ctor) {
      throw new Error('pouchdb-browser default export is unavailable');
    }
    return new ctor(DB_NAME);
  });
}

/** 后端选择：Electron（pomAPI.dbRequest 存在）走 IPC；纯浏览器回落本地 IndexedDB */
function createBackend(): PouchBackend {
  const api =
    typeof window !== 'undefined'
      ? (window as unknown as { pomAPI?: { dbRequest?: DbBridgeRequest } }).pomAPI
      : undefined;
  if (api?.dbRequest) {
    return new IpcPouchBackend(api.dbRequest.bind(api));
  }
  return new BrowserPouchBackend(() => openBrowserDatabase());
}

/**
 * DbService — PouchDB 单例封装
 * 单一数据库 `pomreader`，按 _id 前缀分表：
 *   book:{uuid}                    → BookDoc（含阅读进度 + 分类归属 groupIds）
 *   chapter:{bookId}{idx}   → ChapterDoc（含正文）
 *   group:{uuid}                    → GroupDoc（书架分类）
 *
 * 后端双实现（见 PouchBackend）：
 * - Electron：经 pomAPI.dbRequest 委托给隐藏 DB 窗口（file:// origin 的 IndexedDB），
 *   HMR / dev:file / 打包三种运行方式共享同一份书库
 * - 纯浏览器（ng serve / vitest）：本地直连 IndexedDB，pouchdb-browser 动态加载
 */
@Injectable({ providedIn: 'root' })
export class DbService {
  private readonly db: PouchBackend = createBackend();
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
    // rest-sibling + spread 在前（N4 防御 + Round 5 顺序建议）
    // 主动 strip coverColor：老 PouchDB 数据若残留此字段，...rest 会带进新文档
    const { id, coverColor: _cc, ...rest } = book as Book & { coverColor?: string };
    const _id = BOOK_PREFIX + id;
    const baseDoc: BookDoc = { ...rest, _id, type: 'book', id };
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
    const now = new Date().toISOString();
    const progress = {
      chapterIndex,
      scrollOffset,
      updatedAt: now,
    };
    await this.bookUpdateWithRetry(_id, (doc) => {
      doc.progress = progress;
      doc.lastReadAt = now;
      return doc;
    });
  }

  /** 删除一本书并级联删除其所有章节 */
  async bookDelete(bookId: string): Promise<void> {
    await this.ensureMigrated();
    const _id = BOOK_PREFIX + bookId;
    const bookDoc = (await this.db.get<BookDoc>(_id)) as StoredBookDoc;
    const chapters = await this.chapterAllRaw(bookId);
    // bulkDocs 一次原子删除。必须显式构造 {_id, _rev, _deleted: true}：
    // PouchDB.Core.RemoveDocument 要求 _deleted: true，否则 bulkDocs 把文档当作更新（P1）
    // PouchDB 类型上 RemoveDocument 不显式包含 _deleted 字段，但运行时必须设置 true
    type RemoveDoc = { _id: string; _rev: string; _deleted: true };
    const removeDocs: RemoveDoc[] = [
      { _id: bookDoc._id, _rev: bookDoc._rev, _deleted: true },
      ...chapters.map((c) => ({
        _id: c._id,
        _rev: c._rev,
        _deleted: true as const,
      })),
    ];
    const results = await this.db.bulkDocs(
      removeDocs as unknown as PouchDB.Core.PutDocument<BookDoc | ChapterDoc>[],
    );
    // 删除操作：409 = _rev 过期 = 文档未被删除——必须暴露，不能静默（Round 5）
    // 与 chapterPutMany（创建操作，409=幂等成功）语义不同；用 conflictAsConflict=true 保留 409，
    // 并把 conflicts 并入待抛集合（仅查 fatal 会让 409 被静默吞掉，与上行注释矛盾）
    const classified = classifyBulkResults(results, { conflictAsConflict: true });
    const merged = { ...classified, fatal: [...classified.fatal, ...classified.conflicts] };
    if (merged.fatal.length > 0) {
      throw new Error(
        `bookDelete partial failure: ${formatBulkFatalMessage('bookDelete', merged)}`,
      );
    }
  }

  // ============ Group 操作（书架分类）============

  /** 全部分类，按创建时间升序（新建排末尾；同刻创建用 name 兜底保证稳定） */
  async groupAll(): Promise<BookshelfGroup[]> {
    const res = await this.db.allDocs<GroupDoc>({
      include_docs: true,
      startkey: GROUP_PREFIX,
      endkey: GROUP_PREFIX + HIGH_CHAR,
    });
    return res.rows
      .map((r) => r.doc)
      .filter((d): d is StoredGroupDoc => !!d && d.type === 'group')
      .map((d) => this.groupDocToGroup(d))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.name.localeCompare(b.name));
  }

  /** 新建 / 覆盖分类（id 相同即更新），遇 409 冲突重试一次 */
  async groupPut(group: BookshelfGroup): Promise<void> {
    const baseDoc: GroupDoc = {
      _id: GROUP_PREFIX + group.id,
      type: 'group',
      id: group.id,
      name: group.name,
      createdAt: group.createdAt,
    };
    await this.groupPutWithRetry(baseDoc);
  }

  /** 删除分类文档；不存在视为已删除（幂等） */
  async groupDelete(id: string): Promise<void> {
    const _id = GROUP_PREFIX + id;
    try {
      const doc = (await this.db.get<GroupDoc>(_id)) as StoredGroupDoc;
      // PouchDB 类型系统无法表达删除文档，需显式 _deleted: true（见 bookDelete 同款注释）
      await this.db.put({
        _id,
        _rev: doc._rev,
        _deleted: true,
      } as unknown as PouchDB.Core.PutDocument<GroupDoc>);
    } catch (e: unknown) {
      if (!this.isNotFound(e)) throw e;
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
      const doc = await this.db.get<ChapterDoc>(CHAPTER_PREFIX + bookId + CHAPTER_SEP + idx);
      return this.chapterDocToChapter(doc);
    } catch (e: unknown) {
      if (this.isNotFound(e)) return null;
      throw e;
    }
  }

  async chapterPut(chapter: Chapter): Promise<void> {
    // 与 chapterGet/chapterAll/chapterPutMany/bookDelete 一致：等迁移完成（N1 同源）。
    // 迁移窗口因逐候选 get 而拉长；未门控写入会造成「tombstone 成功 + create 409」：
    // 旧正文被删且 409 被归为良性——无告警、旧 id 已消失、无重试机会。
    await this.ensureMigrated();
    // rest-sibling + spread 在前（N4 防御 + Round 5 顺序建议）
    const { bookId, index, ...rest } = chapter;
    const _id = CHAPTER_PREFIX + bookId + CHAPTER_SEP + index;
    const baseDoc: ChapterDoc = { ...rest, _id, type: 'chapter', bookId, index };
    await this.chapterPutWithRetry(baseDoc);
  }

  async chapterPutMany(chapters: Chapter[]): Promise<void> {
    if (chapters.length === 0) return;
    // 等迁移完成，避免与 migrateLegacyChapterIds 写入新 _id 撞 409（N1）
    await this.ensureMigrated();
    // 一次性 bulk 写 + rest-sibling + spread 在前（N4 一致性）
    const newDocs: ChapterDoc[] = chapters.map((c) => {
      const { bookId, index, ...rest } = c;
      return {
        ...rest,
        _id: CHAPTER_PREFIX + bookId + CHAPTER_SEP + index,
        type: 'chapter',
        bookId,
        index,
      };
    });
    const newIds = new Set(newDocs.map((d) => d._id));

    // 换源场景：新章节集合 < 旧集合时，剩余的旧章节文档需标记 _deleted
    // （否则 PouchDB 里残留孤儿 chapter 文档，长期占用空间）。
    // 两步走：先按范围扫描元数据（只传 id），再一次性按 id 批量取候选正文，
    // 用于校验类型并取得最新 _rev——请求数固定为 2，不随候选数增长。
    // 单次 bulkDocs 同时打 newDocs + orphans，原子性按文档级保证
    const bookIds = Array.from(new Set(chapters.map((c) => c.bookId)));
    type RemoveDoc = { _id: string; _rev: string; _deleted: true };
    const orphans: RemoveDoc[] = [];
    const orphanIds: string[] = [];
    for (const bid of bookIds) {
      const start = CHAPTER_PREFIX + bid + CHAPTER_SEP;
      const res = await this.db.allDocs<ChapterDoc>({
        include_docs: false,
        startkey: start,
        endkey: start + HIGH_CHAR,
      });
      for (const row of res.rows) {
        if (!newIds.has(row.id)) orphanIds.push(row.id);
      }
    }
    if (orphanIds.length > 0) {
      const candRes = await this.db.allDocsByKeys<ChapterDoc>(orphanIds);
      for (const row of candRes.rows) {
        const oldDoc = rowDoc(row) as StoredChapterDoc | null | undefined;
        // 已删文档在 PouchDB 里返回 doc=null；扫描后被删的 id 查不到正文，同样跳过
        if (!oldDoc || oldDoc.type !== 'chapter') continue;
        if ((oldDoc as { _deleted?: boolean })._deleted) continue;
        orphans.push({ _id: oldDoc._id, _rev: oldDoc._rev, _deleted: true });
      }
    }
    // 显式联合类型：替代双重 as unknown as 断言（与 migrateLegacyChapterIds 同模式）
    type BatchItem = ChapterDoc | RemoveDoc;
    const batch: BatchItem[] = [...newDocs, ...orphans];
    const res = await this.db.bulkDocs(batch as unknown as PouchDB.Core.PutDocument<ChapterDoc>[]);
    // 错误语义：
    // - 创建 409 = 文档已存在 = 幂等成功（首次导入场景适用）
    // - 删除 409 = _rev 过期 = 实际未删除；仅记录警告，下次 chapterPutMany 会自然清理
    //   （不在此重试：换源调用方已拿到成功语义，不阻塞主流程）
    // - 其它错误 = 真失败
    const classified = classifyBulkResults(res);
    if (classified.fatal.length > 0) {
      throw new Error(formatBulkFatalMessage('chapter bulk write', classified));
    }
    if (orphans.length > 0) {
      // orphan 删除阶段的 409 单独统计（默认 classifyBulkResults 已将其归入幂等成功）
      // 这里用 conflictAsConflict=true 单独过滤查看真实冲突
      const deleteClassified = classifyBulkResults(res.slice(newDocs.length), {
        conflictAsConflict: true,
      });
      if (deleteClassified.conflicts.length > 0) {
        console.warn(
          `[chapterPutMany] ${deleteClassified.conflicts.length}/${orphans.length} orphan deletes lost _rev race; will retry on next put`,
        );
      }
    }
  }

  /**
   * 迁移旧 chapter _id（`chapter:{bookId}:{idx}` 冒号分隔）到新格式
   * （`chapter:{bookId}{idx}` Unit Separator 分隔）。
   * Round 2 review 指出：CHAPTER_SEP 改为 U+001F 是 breaking change。
   * 新库启动只传 ID/revision 元数据；旧格式候选一次性按 id 批量取正文，避免拉取全部章节正文。
   * 检查 bulkDocs 返回结果过滤非 409 失败（R3-3）。
   * 上层读操作通过 ensureMigrated() await 避免迁移窗口期重复章节（R3-2）。
   */
  private async migrateLegacyChapterIds(): Promise<void> {
    try {
      const res = await this.db.allDocs<ChapterDoc>({
        startkey: CHAPTER_PREFIX,
        endkey: CHAPTER_PREFIX + HIGH_CHAR,
        include_docs: false,
      });
      // 旧格式候选（_id 不含 Unit Separator）：先定位 id，再一次性批量取正文，
      // 请求数固定为 2，不随候选数增长（旧实现是逐个 get 往返）。
      const legacyIds = res.rows
        .filter((row) => !row.id.includes(CHAPTER_SEP))
        .map((row) => row.id);
      if (legacyIds.length === 0) return;
      const candRes = await this.db.allDocsByKeys<ChapterDoc>(legacyIds);
      const oldDocs = candRes.rows
        .map((row) => rowDoc(row) as StoredChapterDoc | null | undefined)
        .filter(
          (d): d is StoredChapterDoc =>
            !!d && d.type === 'chapter' && !(d as { _deleted?: boolean })._deleted,
        );
      if (oldDocs.length === 0) return;

      const migrated = oldDocs
        .map((doc): (ChapterDoc & { _rev?: string }) | null => {
          const m = doc._id.match(/^chapter:(.+):(\d+)$/);
          if (!m) return null;
          const [, bookId, idxStr] = m;
          // 正则 (\d+) 已保证纯数字，parseInt 不可能 NaN（原 Number.isNaN 检查为不可达死分支）
          const idx = parseInt(idxStr, 10);
          // 剥离旧 _rev：新 _id 文档不应携带旧 _rev，否则 PouchDB 当 update 处理 → 409 (P2)
          const { _rev: _oldRev, ...rest } = doc;
          return { ...rest, _id: CHAPTER_PREFIX + bookId + CHAPTER_SEP + idx };
        })
        .filter((d): d is ChapterDoc & { _rev?: string } => !!d);

      // PouchDB 改 _id 等价于「删旧 + 建新」
      const tombstones = oldDocs.map((d) => ({
        _id: d._id,
        _rev: d._rev,
        _deleted: true as const,
      }));
      // 显式联合类型（N6：替代 as unknown as 双重断言）
      // PouchDB bulkDocs 类型签名只接受 PutDocument[]，但删除需要传
      // { _deleted: true } 文档，类型系统无法表达 put+remove 混合语义，cast 必要
      type MigrationBatch =
        (ChapterDoc & { _rev?: string }) | { _id: string; _rev: string; _deleted: true };
      const batch: MigrationBatch[] = [...tombstones, ...migrated];
      const results = await this.db.bulkDocs(batch as PouchDB.Core.PutDocument<ChapterDoc>[]);

      // 仅记录非 409 失败（409 是并发冲突，下次启动会再尝试旧 _id → 幂等）
      const classified = classifyBulkResults(results);
      if (classified.fatal.length > 0) {
        console.warn(
          '[DbService] legacy chapter migration partial failure:',
          classified.fatal.map((f) => ('id' in f ? f.id : 'unknown')),
        );
      }
    } catch (e) {
      console.warn('[DbService] legacy chapter _id migration failed:', e);
    }
  }

  // ============ 启动诊断 ============

  /**
   * 启动 hook（兼容保留）：当前实现为 no-op，首次启动书架为空。
   *
   * @deprecated 自 2026-09 起不再灌入内置 seed。`book.repository.ts:61`
   *   仍在调用本方法以保留接口稳定；下一轮重构可移除本方法并合并
   *   `bookAll()` 调用，避免重复全表扫描（review_round_1/R1）。
   *
   * @history 早期版本从 `assets/data/books.json` + `assets/data/chapters/*.json`
   *   灌入 13 本 mock 书（含 stub 首章）用于演示；2026-09 起移除。
   */
  async seedIfEmpty(): Promise<{ seeded: false; bookCount: 0 }> {
    return { seeded: false, bookCount: 0 };
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
  private async bookPutWithRetry(
    baseDoc: BookDoc,
    newProgress?: BookDoc['progress'],
  ): Promise<void> {
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

  /** Group 写入，遇 409 冲突重试一次 */
  private async groupPutWithRetry(baseDoc: GroupDoc): Promise<void> {
    const tryWrite = async (): Promise<void> => {
      const doc: GroupDoc & { _rev?: string } = { ...baseDoc };
      try {
        const existing = (await this.db.get<GroupDoc>(baseDoc._id)) as StoredGroupDoc;
        doc._rev = existing._rev;
      } catch (e: unknown) {
        if (!this.isNotFound(e)) throw e;
      }
      await this.db.put(doc as PouchDB.Core.PutDocument<GroupDoc>);
    };
    try {
      await tryWrite();
    } catch (e: unknown) {
      if (!this.isConflict(e)) throw e;
      await tryWrite(); // 冲突：重试一次拿最新 _rev
    }
  }

  private bookDocToBook(doc: StoredBookDoc): Book {
    // 主动 strip coverColor：老 PouchDB 数据若残留此字段，...rest 会带进返回的 Book
    const {
      _id,
      _rev,
      type,
      coverColor: _cc,
      ...rest
    } = doc as StoredBookDoc & { coverColor?: string };
    return rest as Book;
  }

  private groupDocToGroup(doc: StoredGroupDoc): BookshelfGroup {
    const { _id, _rev, type, ...rest } = doc;
    return rest as BookshelfGroup;
  }

  private chapterDocToChapter(doc: StoredChapterDoc): Chapter {
    const { _id, _rev, type, ...rest } = doc;
    return rest as Chapter;
  }
}
