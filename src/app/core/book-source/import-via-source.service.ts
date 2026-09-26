import { Injectable, inject } from '@angular/core';
import { BookSourceRegistry } from './book-source.registry';
import { PageFetcher, ResolvedBook, extractMetaUuid } from './book-source.adapter';
import { FetchError } from './fetch-error';
import { PageFetcherService } from './page-fetcher.service';
import { UNIVERSAL_BOOK_SOURCE_UUID } from './book-source.constants';

/** 关键词搜索单项（归一化后供 UI 直接渲染） */
export interface SourceSearchHit {
  name: string;
  author?: string;
  url: string;
  intro?: string;
}

/** 内部使用：鸭子类型 search(keyword, page) → RawSearchItem[] */
interface RawSearchItem {
  name?: string;
  title?: string;
  author?: string;
  url?: string;
  bookUrl?: string;
  intro?: string;
  description?: string;
}

/**
 * importByUrl 返回值 —— 显式分两层（不混来源）：
 * - `book` 保持 ResolvedBook 纯净（适配器无关，不掺书源专属字段）
 * - `bookSourceUuid` 始终是 string（服务层兜底 UNIVERSAL_BOOK_SOURCE_UUID），consumer
 *   不必再 `?? 'universal'`
 *
 * 与 MultiSourceSearchService 的区别：MultiSourceSearchService 跨多源聚合 + 去重（找书），
 * 本服务显式指定单源（已知用某书源导入）。适配器 duck-typed `search()`：未实现抛错。
 */
export interface ImportByUrlResult {
  book: ResolvedBook;
  /**
   * 书源锚定（结构统一必有值）：
   * - JsSourceAdapter 来源：meta.uuid（精确锚定）
   * - 万能搜索 fallback：UNIVERSAL_BOOK_SOURCE_UUID（'universal' 常量）
   * - 破损 meta.uuid（空字符串）→ UNIVERSAL_BOOK_SOURCE_UUID 兜底
   */
  bookSourceUuid: string;
}

@Injectable({ providedIn: 'root' })
export class ImportViaSourceService {
  private readonly registry = inject(BookSourceRegistry);
  private readonly pageFetcher = inject(PageFetcherService, { optional: true });

  /**
   * 通过指定书源（或自动 resolve）解析书页 URL → 目录
   * - sourceName 缺省 → registry.fetchCatalog 走 resolve() 自动匹配
   * - sourceName 指定 → 仅在该书源 match(url) 时走该书源；否则回退到 registry.fetchCatalog
   *
   * @returns { book, bookSourceUuid? } book 永远是 ResolvedBook；bookSourceUuid 仅当
   *          指定书源且为 JsSourceAdapter 时返回 meta.uuid，其它场景 undefined（不混入）
   */
  /**
   * 通过指定书源（或自动 resolve）解析书页 URL → 目录
   * - sourceName 缺省 → registry.fetchCatalog 走 resolve() 自动匹配（万能搜索/启发式兜底）
   * - sourceName 指定 → 必须存在且 match(url) 才走该书源；否则抛 FetchError('unsupported-source')
   *   避免静默降级导致 Book.bookSourceUuid 与用户选择的书源不一致（P0-1 修复）
   *
   * @returns { book, bookSourceUuid } book 永远是 ResolvedBook；bookSourceUuid 结构统一：
   *          - JsSourceAdapter 命中 → meta.uuid（精确锚定）
   *          - sourceName 指定但 match 失败 / 源不存在 → 抛 FetchError（不返回）
   *          - 万能搜索 fallback → UNIVERSAL_BOOK_SOURCE_UUID（统一兜底，consumer 不必再 ?? 兜底）
   */
  async importByUrl(url: string, sourceName?: string): Promise<ImportByUrlResult> {
    if (sourceName) {
      // 用 getByName 而非 get：语义明确（按 name 查），与 getByUuid 命名空间分离
      const adapter = this.registry.getByName(sourceName);
      if (!adapter) {
        throw new FetchError('unsupported-source', `书源 "${sourceName}" 不存在或未启用`);
      }
      if (!adapter.match(url)) {
        throw new FetchError(
          'unsupported-source',
          `书源 "${sourceName}" 不支持该 URL：${url}`,
        );
      }
      const fetcher = this.requireFetcher();
      const book = await adapter.fetchCatalog(url, fetcher);
      // 空字符串 / 无 meta.uuid 也兜底为 UNIVERSAL（保证 bookSourceUuid 类型统一非 undefined）
      return { book, bookSourceUuid: extractMetaUuid(adapter) ?? UNIVERSAL_BOOK_SOURCE_UUID };
    }
    // 仅 sourceName 未指定时走万能搜索 fallback（registry 自动 resolve）
    const book = await this.registry.fetchCatalog(url);
    return { book, bookSourceUuid: UNIVERSAL_BOOK_SOURCE_UUID };
  }

  /**
   * 在指定书源内搜索关键词 → 书页 URL 列表
   * 用户选择某条后通常调 importByUrl 导入
   */
  async searchAndSelect(
    keyword: string,
    sourceName: string,
    page = 1,
  ): Promise<SourceSearchHit[]> {
    const adapter = this.registry.get(sourceName);
    if (!adapter) {
      throw new FetchError('unsupported-source', `书源不存在: ${sourceName}`);
    }
    const searchFn = (adapter as unknown as {
      search?: (kw: string, p: number) => Promise<RawSearchItem[]>;
    }).search;
    if (typeof searchFn !== 'function') {
      throw new FetchError(
        'unsupported-source',
        `书源 ${sourceName} 不支持 search()`,
      );
    }
    const raw = await searchFn(keyword, page);
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((r) => r && (r.url || r.bookUrl))
      .map((r) => ({
        name: (r.name || r.title || '').trim(),
        author: r.author,
        url: (r.url || r.bookUrl || '').trim(),
        intro: r.intro || r.description,
      }));
  }

  /** 列出当前 registry 中全部书源名（用于下拉） */
  supportedSources(): string[] {
    return this.registry.supportedSources();
  }

  /**
   * 测试入口：手动注入依赖（绕开 Angular DI 上下文 NG0203）。
   * 与 BookSourceRegistry.forTest 同模式：生产用 Angular 注入，测试用静态工厂。
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  static forTest(registry: BookSourceRegistry, fetcher: PageFetcher): ImportViaSourceService {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc: any = Object.create(ImportViaSourceService.prototype);
    svc.registry = registry;
    svc.pageFetcher = fetcher;
    return svc as ImportViaSourceService;
  }

  /** 取 PageFetcher：DI 失败（forTest）时抛 source-unavailable */
  private requireFetcher(): PageFetcher {
    if (!this.pageFetcher) {
      throw new FetchError(
        'source-unavailable',
        'PageFetcher 不可用（仅 in-browser / Electron 环境）',
      );
    }
    return this.pageFetcher;
  }
}
