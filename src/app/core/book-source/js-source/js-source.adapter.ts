/**
 * JS 书源适配器（实施计划 T-004 + spec FR-1.4）
 *
 * - match(url)：按 meta.urls[0] 主机名匹配（与 BaseSourceAdapter hostPattern 一致）
 * - fetchCatalog → 沙箱 `bookInfo(url)`；fetchChapter → 沙箱 `chapterContent(url)`
 * - search → 沙箱 `search(keyword, page)`（跨书源聚合搜索 duck-typed 入口）
 * - load() 缓存命中跳过（Worker 侧按 fileName 缓存）
 * - 读取源文件走 preload `pomAPI.booksourceRead`（renderer 不直接 FS）
 *
 * 字段命名约定（与 RawSearchItem 对齐）：
 * - legado 标准字段在前（name / author / url）；兼容字段在后（title / bookName / writer / bookUrl / link / description）
 * - 全部用 pickString helper 做 fallback 链，不写 `||` 字面量
 * - pickString 接受任意对象，内部防御 null / 非 plain object
 */
import {
  BookSourceAdapter,
  CatalogEntry,
  PageFetcher,
  RawSearchItem,
  ResolvedBook,
} from '../book-source.adapter';
import { FetchError } from '../fetch-error';
import { SandboxService } from './sandbox.service';
import { BookSourceMeta } from './source-meta.types';

/**
 * legado bookInfo() 返回结构（兼容多种命名）：
 * - 书名：name（legado 标准）→ title → bookName
 * - 作者：author（legado 标准）→ writer
 * - 章节：chapters[].name / chapters[].url（legado 标准）；兼容 title / bookUrl / link
 * 各 fallback 字段由 fetchCatalog 内 pickString 处理；interface 列出所有合法字段名
 */
interface BookInfoResult {
  // 书名（legado 标准在前）
  name?: string;
  title?: string;
  bookName?: string;
  // 作者
  author?: string;
  writer?: string;
  // 分类/题材（项目 Book.kind 对应）
  kind?: string;
  genre?: string;
  category?: string;
  class?: string;
  type?: string;
  // 章节
  chapters?: CatalogEntry[];
}

/** 手动 `new` 实例化（registry.loadAllJsAdapters 内），不挂 Angular DI */
export class JsSourceAdapter implements BookSourceAdapter {
  readonly name: string;
  private readonly hostPattern: RegExp | null;
  /** 已加载标记：load() 缓存命中时跳过 */
  private loaded = false;

  constructor(private readonly meta: BookSourceMeta, private readonly sandbox: SandboxService) {
    this.name = meta.name || meta.fileName;
    this.hostPattern = buildHostPattern(meta.url || meta.urls[0]);
  }

  match(url: string): boolean {
    if (!this.hostPattern) return false;
    return this.hostPattern.test(url);
  }

  async fetchCatalog(url: string, _fetcher: PageFetcher): Promise<ResolvedBook> {
    await this.ensureLoaded();
    const result = await this.sandbox.call<BookInfoResult>(
      this.meta.fileName, 'bookInfo', [url],
    );
    if (!result || !Array.isArray(result.chapters)) {
      throw new FetchError('parse-failed', `书源 ${this.name} 返回结果无 chapters`);
    }
    return {
      title: pickString(result, 'name', 'title', 'bookName') || this.name,
      author: pickString(result, 'author', 'writer') || '未知',
      kind: pickString(result, 'kind', 'genre', 'category', 'class', 'type'),
      chapters: result.chapters.map((ch) => ({
        title: pickString(ch, 'name', 'title', 'bookName') || '未知章节',
        url: pickString(ch, 'url', 'bookUrl', 'link') || '',
      })),
    };
  }

  async fetchChapter(entry: CatalogEntry, _fetcher: PageFetcher): Promise<string> {
    await this.ensureLoaded();
    const result = await this.sandbox.call<string>(
      this.meta.fileName, 'chapterContent', [entry.url],
    );
    return typeof result === 'string' ? result : '';
  }

  /**
   * 单书源 search() 返回结果上限（legado 普遍 10-50 条；100 是宽限兜底，
   * 防止畸形返回拖垮前端渲染 / 污染聚合去重 key 池）。
   */
  private static readonly MAX_SEARCH_RESULTS = 100;

  /**
   * 跨书源聚合搜索的 duck-typed 入口（FR-2 + MultiSourceSearchService.searchAll 过滤条件）。
   * 委托给沙箱内 legado 书源脚本的 `search(keyword, page)` 函数，兼容 legado 风格命名差异。
   *
   * @param keyword 搜索关键词；trim 后空字符串/undefined → 返回 [] 不调沙箱
   * @param page 分页号（legado 多数书源 1-based；非正整数 → 兜底 1；与 source-debug.component.ts:329 调试页对齐）
   * @returns 规范化后的 RawSearchItem[]；非数组 / 全空条目 → 过滤；截断至 MAX_SEARCH_RESULTS 条
   * @throws 沙箱调用 / 加载失败时抛 Error；调用方（如 MultiSourceSearchService）应使用
   *         Promise.allSettled 隔离单源失败，避免拖累整个聚合搜索
   */
  async search(keyword: string, page?: number): Promise<RawSearchItem[]> {
    const kw = keyword?.trim();
    if (!kw) return [];
    const safePage = Number.isInteger(page) && (page as number) >= 1 ? (page as number) : 1;
    try {
      await this.ensureLoaded();
      const raw = await this.sandbox.call<unknown>(
        this.meta.fileName, 'search', [kw, safePage],
      );
      if (!Array.isArray(raw)) return [];
      return raw
        .map(toRawSearchItem)
        .filter((it): it is RawSearchItem => it !== null)
        .slice(0, JsSourceAdapter.MAX_SEARCH_RESULTS);
    } catch (e) {
      // 结构化日志：Tag 前缀方便 DevTools 检索；throw 由调用方（MultiSourceSearchService.searchAll
      // 用 Promise.allSettled 隔离）兜底，不会拖累整个聚合搜索
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[JsSourceAdapter] 书源 ${this.name} search 失败: ${msg}`);
      throw e;
    }
  }

  /**
   * 每次 fetchCatalog/fetchChapter/search 入口都重新读源码 + 交给 sandbox.load。
   * 不保留实例级缓存的原因：书源脚本是用户在 dev 期频繁修改的资产，需要修改后
   * 立即生效（sandbox 内部已按 fileName + sourceCache 做缓存判断：源码变了自动
   * invalidate + 重新编译；源码未变走缓存，几 ms 完成）。原 `if (this.loaded) return`
   * 缓存策略会让用户改完源码不生效，是 dev 期体验陷阱。
   *
   * 注意：sandbox.load 内部的 sourceCache 在首次 load 后才有值，所以首次 load 后
   * 第二次调 ensureLoaded 时 sourceCache 比对才生效——我们 readSource 拿到最新源，
   * sandbox 自己决定要不要重新编译。
   */
  private async ensureLoaded(): Promise<void> {
    const source = await this.readSource();
    await this.sandbox.load(this.meta.fileName, source);
  }

  private async readSource(): Promise<string> {
    // 不在 Window.pomAPI 上声明 booksourceRead（与 sandbox/page-fetcher 的 declare global 互不冲突）
    const pom = (typeof window !== 'undefined' ? (window as unknown as {
      pomAPI?: { booksourceRead?: (fileName: string, sourceDir?: string | null) => Promise<string> };
    }).pomAPI : undefined);
    const read = pom?.booksourceRead;
    if (!read) throw new FetchError('source-unavailable', 'booksourceRead IPC 不可用');
    return await read(this.meta.fileName, this.meta.sourceDir || null);
  }
}

/**
 * legado search 返回项 → RawSearchItem 规范化（与 fetchCatalog 同一套 fallback 约定）：
 * - 标准在前：name / author / url / intro
 * - 兼容在后：title / bookUrl / description + 各类常见命名（by/bookAuthor/novelType 等）
 * 非 plain object 一律丢弃；name/url 都为空（即 `[{}]` / `[{name: ""}]`）也丢弃，
 * 避免污染聚合去重 key 池与前端渲染幽灵条目。
 *
 * 调试日志：首次调用时 console.debug 打印原始对象的 keys，便于排查书源 script
 * 实际使用的字段名（如果所有 fallback 都没命中，按 console 输出收紧 fallback 链）。
 */
let toRawSearchItemLogged = false;
function toRawSearchItem(raw: unknown): RawSearchItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (!toRawSearchItemLogged) {
    toRawSearchItemLogged = true;
    console.debug('[JsSourceAdapter] 调试：search() 第一条原始数据 keys =', Object.keys(obj));
  }
  const name = pickString(obj, 'name', 'title');
  const url = pickString(obj, 'url', 'bookUrl', 'link', 'href');
  if (!name && !url) return null;
  return {
    name,
    author: pickString(obj, 'author', 'writer', 'creator', 'by', 'bookAuthor', 'authorName'),
    kind: pickString(obj, 'kind', 'genre', 'category', 'class', 'type', 'sort', 'tag', 'classify', 'bookType', 'novelType'),
    url,
    intro: pickString(obj, 'intro', 'description', 'summary', 'desc', 'brief'),
  };
}

/**
 * 按序取首个非空字符串（trim 后空字符串也算无值）。fallback 链统一规范：
 * - 入参 it 接受任意对象（含 null/undefined）；内部防御，非 plain object 返回 undefined
 * - caller 不用预先做 cast 或 null 检查
 */
function pickString(it: unknown, ...keys: string[]): string | undefined {
  if (!it || typeof it !== 'object') return undefined;
  const rec = it as Record<string, unknown>;
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === 'string') {
      const trimmed = v.trim();
      if (trimmed) return trimmed;
    }
  }
  return undefined;
}

/** 主机名 → 正则（剥 www.，转义点号；与 base-source.adapter.ts 思路一致） */
function buildHostPattern(mainUrl: string): RegExp | null {
  if (!mainUrl) return null;
  try {
    const u = new URL(mainUrl);
    const host = u.hostname.replace(/^www\./, '').replace(/\./g, '\\.');
    return new RegExp(`^https?://([^/]+\\.)?${host}(/|$)`);
  } catch {
    return null;
  }
}
