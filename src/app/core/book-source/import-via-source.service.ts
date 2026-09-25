import { Injectable, inject } from '@angular/core';
import { BookSourceRegistry } from './book-source.registry';
import { PageFetcher, ResolvedBook } from './book-source.adapter';
import { FetchError } from './fetch-error';
import { PageFetcherService } from './page-fetcher.service';

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
 * ImportViaSourceService — 显式书源导入（实施计划 T-007 + spec FR-1.7）
 *
 * 与 MultiSourceSearchService 的区别：
 * - MultiSourceSearchService 跨多书源聚合 + 去重（场景：找一本可能多书源都有的书）
 * - ImportViaSourceService 显式指定单个书源（场景：已知用某书源导入特定 URL / 搜索关键词）
 *
 * 适配器 duck-typed `search()`：未实现则 searchAndSelect 抛错；
 * 内置 BaseSourceAdapter（5 站 + 启发式）不暴露 search()，仅 JS 书源 / 扩展书源可能实现。
 */
@Injectable({ providedIn: 'root' })
export class ImportViaSourceService {
  private readonly registry = inject(BookSourceRegistry);
  private readonly pageFetcher = inject(PageFetcherService, { optional: true });

  /**
   * 通过指定书源（或自动 resolve）解析书页 URL → 目录
   * - sourceName 缺省 → registry.fetchCatalog 走 resolve() 自动匹配
   * - sourceName 指定 → 仅在该书源 match(url) 时走该书源；否则回退到 registry.fetchCatalog
   */
  async importByUrl(url: string, sourceName?: string): Promise<ResolvedBook> {
    if (sourceName) {
      const adapter = this.registry.get(sourceName);
      if (adapter && adapter.match(url)) {
        const fetcher = this.requireFetcher();
        return adapter.fetchCatalog(url, fetcher);
      }
    }
    return this.registry.fetchCatalog(url);
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