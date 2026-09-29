/**
 * 规则书源适配器（书源 JSON 规则化 P1.5）—— 旧 `js-source/js-source.adapter.ts` 的继任者
 *
 * 职责与旧适配器**逐条对齐**（同一套 `BookSourceAdapter` 接口 + duck-typed `search()`），
 * 差别只有一处根本性的：没有沙箱，规则来自 JSON 文档，HTTP 直连 `booksourceHttpProxy`。
 *
 * ## 为什么 search 映射不抄旧适配器的 fallback 链
 *
 * 旧适配器要从沙箱返回的**任意形状**对象里挑字段（`name`/`title`/`bookName`…），
 * 因为存量 JS 书源是用户可改的代码，返回键名不固定。本适配器面对的是引擎的
 * `RawSearchItem` —— 字段名由 `engine.ts` 写死，形状是确定的。这里再抄一遍 fallback 链
 * 只会制造"看起来兼容、实际永远不会命中"的死代码。真要统一行为，改引擎的输出形状。
 *
 * 但**对外契约（`RawSearchItem` 的可选字段、丢弃空条目、100 条上限、缺省文案）保持不变** ——
 * 下游 `MultiSourceSearchService` 与渲染层只认这套契约。
 */
import {
  type BookSourceAdapter,
  type CatalogEntry,
  type PageFetcher,
  type RawSearchItem,
  type ResolvedBook,
} from '../book-source.adapter';
import { FetchError } from '../fetch-error';
import type { BookSourceDoc } from '../../models/book-source-doc.model';
import { SEARCH_MAX_ITEMS } from './guard';
import type { RuleEngine } from './engine';

/** 构造引擎的工厂 —— 由 `RuleEngineService` 实现；此处只声明形状，便于单测注入假引擎 */
export type RuleEngineFactory = (doc: BookSourceDoc) => RuleEngine;

/** adapter 暴露给 registry / UI 的 meta 形状（`extractMetaUuid` 按 duck typing 读 `meta.uuid`） */
interface AdapterMeta {
  uuid: string;
  name: string;
  urls: string[];
  enabled: boolean;
}

export class JsonRuleAdapter implements BookSourceAdapter {
  readonly name: string;
  /** registry 的 `extractMetaUuid` / `hasMetaUuid` 依赖这个属性（不反向耦合任何具体类型） */
  readonly meta: AdapterMeta;
  private readonly hostPattern: RegExp | null;

  constructor(
    private readonly doc: BookSourceDoc,
    private readonly engineFactory: RuleEngineFactory,
  ) {
    this.name = doc.name || doc.uuid;
    this.meta = { uuid: doc.uuid, name: doc.name, urls: doc.urls, enabled: doc.enabled };
    // 与 `JsSourceAdapter` 同思路：按**第一个** @url 建主机名正则（迁移后 urls 保持原顺序，
    // v1 不做镜像 failover —— 轮询优先级是二期的事，这里偷偷实现就是引入未承诺的行为）
    this.hostPattern = buildHostPattern(doc.urls[0] || doc.homepage);
  }

  match(url: string): boolean {
    if (!this.hostPattern) return false;
    return this.hostPattern.test(url);
  }

  async fetchCatalog(url: string, _fetcher: PageFetcher): Promise<ResolvedBook> {
    const info = await this.engineFactory(this.doc).bookInfo(url);
    if (!info || !Array.isArray(info.chapters)) {
      throw new FetchError('parse-failed', `书源 ${this.name} 返回结果无 chapters`);
    }
    return {
      title: info.title || this.name,
      author: info.author || '未知',
      kind: info.category || undefined,
      coverImageUrl: info.cover || undefined,
      chapters: info.chapters.map((ch) => ({ title: ch.name || '未知章节', url: ch.url || '' })),
    };
  }

  async fetchChapter(entry: CatalogEntry, _fetcher: PageFetcher): Promise<string> {
    const text = await this.engineFactory(this.doc).chapterContent(entry.url);
    return typeof text === 'string' ? text : '';
  }

  /**
   * 跨书源聚合搜索的 duck-typed 入口（与 `JsSourceAdapter.search` 同签名同语义）
   *
   * @param keyword 关键词；trim 后为空 → 返回 []，不发起任何请求
   * @param page 分页号（legado 多数 1-based）；非正整数 → 兜底 1
   * @throws 引擎侧失败直接抛（调用方 `MultiSourceSearchService` 用 `allSettled` 隔离单源）
   */
  async search(keyword: string, page?: number): Promise<RawSearchItem[]> {
    const kw = keyword?.trim();
    if (!kw) return [];
    const safePage = Number.isInteger(page) && (page as number) >= 1 ? (page as number) : 1;
    try {
      const items = await this.engineFactory(this.doc).search(kw, safePage);
      return items
        .map(toRawSearchItem)
        .filter((it): it is RawSearchItem => it !== null)
        .slice(0, SEARCH_MAX_ITEMS);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[JsonRuleAdapter] 书源 ${this.name} search 失败: ${msg}`);
      throw e;
    }
  }
}

/**
 * 引擎返回项 → `RawSearchItem`
 *
 * 丢弃「名字与链接都为空」的条目：它们进不了聚合去重 key 池，只会渲染出幽灵行。
 * 空字符串归一成 `undefined`（而非 `''`），让下游的"有值才显示"判断保持原语义。
 */
function toRawSearchItem(it: {
  name: string;
  author: string;
  kind: string;
  bookUrl: string;
}): RawSearchItem | null {
  const name = (it.name || '').trim();
  const url = (it.bookUrl || '').trim();
  if (!name && !url) return null;
  return {
    name,
    url,
    author: it.author || undefined,
    kind: it.kind || undefined,
  };
}

/** 主机名 → 正则（剥 www.，转义点号；与 `JsSourceAdapter` / `BaseSourceAdapter` 同一套） */
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
