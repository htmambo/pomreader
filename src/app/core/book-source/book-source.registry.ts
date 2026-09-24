import { Injectable, inject } from '@angular/core';
import {
  BookSourceAdapter,
  CatalogEntry,
  PageFetcher,
  ResolvedBook,
} from './book-source.adapter';
import { PageFetcherService } from './page-fetcher.service';
import { FetchError } from './fetch-error';

/**
 * 书源适配器注册表（spec §4.3）
 * - register() 开放扩展（后续可加站或用户自配）
 * - 未知 URL 抛 unsupported-source（不兜底）
 */
@Injectable({ providedIn: 'root' })
export class BookSourceRegistry {
  private readonly adapters: BookSourceAdapter[] = [];
  private fetcher: PageFetcher | null = null;

  constructor() {
    // DI 环境下懒注入；测试用 forTest 直接覆盖
    try {
      this.fetcher = inject(PageFetcherService);
    } catch {
      this.fetcher = null;
    }
  }

  /** 测试用：直接注入 fetcher 绕过 Angular DI */
  static forTest(fetcher: PageFetcher): BookSourceRegistry {
    const reg = new BookSourceRegistry();
    reg.fetcher = fetcher;
    return reg;
  }

  private requireFetcher(): PageFetcher {
    if (!this.fetcher) throw new FetchError('parse-failed', 'fetcher 未初始化');
    return this.fetcher;
  }

  register(adapter: BookSourceAdapter): void {
    this.adapters.push(adapter);
  }

  private resolve(url: string): BookSourceAdapter {
    const a = this.adapters.find((x) => x.match(url));
    if (!a) throw new FetchError('unsupported-source');
    return a;
  }

  async fetchCatalog(url: string): Promise<ResolvedBook> {
    return this.resolve(url).fetchCatalog(url, this.requireFetcher());
  }

  async fetchChapter(entry: CatalogEntry): Promise<string> {
    return this.resolve(entry.url).fetchChapter(entry, this.requireFetcher());
  }

  supportedSources(): string[] {
    return this.adapters.map((a) => a.name);
  }
}
