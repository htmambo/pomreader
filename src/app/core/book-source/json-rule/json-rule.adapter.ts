/**
 * JSON 规则书源适配器（方案 §3.2 / P1）：JsonRuleAdapter，
 * 执行后端为「JsonRuleEngine + RuleEngineService」（P4 起唯一用户书源链路；
 * 原为历史 JS 沙箱适配器的行为等价镜像，差分测试已随 P4 一并删除）。
 *
 * 行为要点：
 * - match(url)：meta.url || meta.urls[0] 主机名正则（buildHostPattern，v1 只取 [0]，不做 failover）
 * - fetchCatalog → engineService.bookInfo(...)，走同一套 pickString fallback 链
 *   （name/title/bookName、author/writer、kind/genre/category/class/type、cover/coverUrl/image、
 *   chapters[].name/url/bookUrl/link）。引擎当前返回 title/author/category/cover/chapters[{name,url}]，
 *   保留整条链为兼容未来字段差异与 legado 导入产物。
 * - fetchChapter → engineService.chapterContent(...)，非 string 返回 ''
 * - search → engineService.search(...)，toRawSearchItem 规范化 + 截断 MAX_SEARCH_RESULTS
 * - 「改完立即生效」：RuleEngineService 每次入口重读文件 + valibot parse 保证，
 *   adapter 不做实例级缓存。
 *
 * pickString / toRawSearchItem / buildHostPattern / MAX_SEARCH_RESULTS 共用自
 * ../source-parse.utils.ts（选择抽共用而非复制：这套 legado 兼容链是两条 adapter 必须
 * 永远一致的契约，复制会随字段兼容演进漂移）。
 *
 * meta 用 core/book-source/source-meta.types.ts 的 BookSourceMeta。
 * meta 暴露为实例属性供 extractMetaUuid 鸭子类型读取（registry 匹配用）。
 */
import {
  type BookSourceAdapter,
  type CatalogEntry,
  type PageFetcher,
  type RawSearchItem,
  type ResolvedBook,
} from '../book-source.adapter';
import { FetchError } from '../fetch-error';
import { type BookSourceMeta } from '../source-meta.types';
import {
  buildHostPattern,
  MAX_SEARCH_RESULTS,
  pickString,
  toRawSearchItem,
} from '../source-parse.utils';
import { type RuleEngineService } from './rule-engine.service';
import { type RuleChapterItem } from './engine';

/**
 * bookInfo 结果（引擎返回 RuleBookInfo = title/author/category/cover/chapters[{name,url}]；
 * interface 列出整条 fallback 链的合法字段名，兼容未来差异与 legado 命名）
 */
interface BookInfoResult {
  name?: string;
  title?: string;
  bookName?: string;
  author?: string;
  writer?: string;
  kind?: string;
  genre?: string;
  category?: string;
  class?: string;
  type?: string;
  cover?: string;
  coverUrl?: string;
  image?: string;
  chapters?: (CatalogEntry | RuleChapterItem)[];
}

/** 手动 `new` 实例化（registry 装配层），不挂 Angular DI */
export class JsonRuleAdapter implements BookSourceAdapter {
  readonly name: string;
  private readonly hostPattern: RegExp | null;

  constructor(
    private readonly meta: BookSourceMeta,
    private readonly engineService: RuleEngineService,
  ) {
    this.name = meta.name || meta.fileName;
    this.hostPattern = buildHostPattern(meta.url || meta.urls[0]);
  }

  match(url: string): boolean {
    if (!this.hostPattern) return false;
    return this.hostPattern.test(url);
  }

  async fetchCatalog(url: string, _fetcher: PageFetcher): Promise<ResolvedBook> {
    const result: BookInfoResult | null = await this.engineService.bookInfo(this.meta, url);
    if (!result || !Array.isArray(result.chapters)) {
      throw new FetchError('parse-failed', `书源 ${this.name} 返回结果无 chapters`);
    }
    return {
      title: pickString(result, 'name', 'title', 'bookName') || this.name,
      author: pickString(result, 'author', 'writer') || '未知',
      kind: pickString(result, 'kind', 'genre', 'category', 'class', 'type'),
      coverImageUrl: pickString(result, 'cover', 'coverUrl', 'image') || undefined,
      chapters: result.chapters.map((ch) => ({
        title: pickString(ch, 'name', 'title', 'bookName') || '未知章节',
        url: pickString(ch, 'url', 'bookUrl', 'link') || '',
      })),
    };
  }

  async fetchChapter(entry: CatalogEntry, _fetcher: PageFetcher): Promise<string> {
    const result = await this.engineService.chapterContent(this.meta, entry.url);
    return typeof result === 'string' ? result : '';
  }

  /**
   * 跨书源聚合搜索的 duck-typed 入口。
   *
   * @param keyword 搜索关键词；trim 后空字符串/undefined → 返回 [] 不调引擎
   * @param page 分页号（非正整数 → 兜底 1）
   * @returns 规范化后的 RawSearchItem[]；非数组 / 全空条目 → 过滤；截断至 MAX_SEARCH_RESULTS 条
   * @throws 引擎 / IO 失败时抛 Error；调用方应用 Promise.allSettled 隔离单源失败
   */
  async search(keyword: string, page?: number): Promise<RawSearchItem[]> {
    const kw = keyword?.trim();
    if (!kw) return [];
    const safePage = Number.isInteger(page) && (page as number) >= 1 ? (page as number) : 1;
    try {
      const raw: unknown = await this.engineService.search(this.meta, kw, safePage);
      if (!Array.isArray(raw)) return [];
      return raw
        .map(toRawSearchItem)
        .filter((it): it is RawSearchItem => it !== null)
        .slice(0, MAX_SEARCH_RESULTS);
    } catch (e) {
      // 结构化日志：Tag 前缀方便 DevTools 检索；throw 由调用方（Promise.allSettled 隔离）兜底
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[JsonRuleAdapter] 书源 ${this.name} search 失败: ${msg}`);
      throw e;
    }
  }
}
