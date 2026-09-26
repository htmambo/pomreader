import { Injectable, inject } from '@angular/core';
import {
  BookSourceAdapter,
  CatalogEntry,
  PageFetcher,
  ResolvedBook,
} from './book-source.adapter';
import { PageFetcherService } from './page-fetcher.service';
import { FetchError } from './fetch-error';
import { JsSourceAdapter } from './js-source/js-source.adapter';
import { SandboxService } from './js-source/sandbox.service';
import { BookSourceMeta } from './js-source/source-meta.types';
import { BOOK_SOURCE_FEATURE_FLAGS } from './feature-flag';

/**
 * 书源适配器注册表（spec §4.3）
 * - 专用适配器优先（5 站固定选择器）
 * - 启发式适配器兜底（复刻原 vendor 通用解析，任意 URL 可试）
 * - register() 开放扩展
 */
@Injectable({ providedIn: 'root' })
export class BookSourceRegistry {
  private readonly adapters: BookSourceAdapter[] = [];
  private fetcher: PageFetcher | null = null;

  constructor() {
    try {
      this.fetcher = inject(PageFetcherService);
    } catch {
      this.fetcher = null;
    }
  }

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

  /** 注册 JS 书源适配器（push 到末尾：内置 > 启发式 > JS，spec §4 R-2 缓解） */
  registerJsAdapter(adapter: JsSourceAdapter): void {
    this.adapters.push(adapter);
  }

  /**
   * 启动时拉取全部书源元数据，逐个构造 JsSourceAdapter 注册。
   * - Feature Flag 关 → 直接返回（实现计划 §8 回滚）
   * - preload 不可用（浏览器降级） → 直接返回
   * - 单条书源失败 → console.warn 跳过，不阻塞其他
   *
   * @param externalSandbox 可选：外部传入的 SandboxService（推荐，APP_INITIALIZER 等异步上下文中
   *        调 `inject()` 会抛 NG0203）。不传时尝试内部 inject（仅 forTest / 直接调用场景可用）
   */
  async loadAllJsAdapters(externalSandbox?: SandboxService): Promise<void> {
    if (!BOOK_SOURCE_FEATURE_FLAGS.enableJsSource) {
      console.warn('[registry] loadAllJsAdapters 早返回：BOOK_SOURCE_FEATURE_FLAGS.enableJsSource = false');
      return;
    }
    const pom = typeof window !== 'undefined' ? (window as unknown as {
      pomAPI?: { booksourceList?: () => Promise<BookSourceMeta[]> };
    }).pomAPI : undefined;
    if (!pom?.booksourceList) {
      console.warn('[registry] loadAllJsAdapters 早返回：window.pomAPI.booksourceList 不存在（preload 未注册 / 非 Electron 环境）');
      return;
    }
    let sandbox: SandboxService | undefined = externalSandbox;
    if (!sandbox) {
      try {
        sandbox = inject(SandboxService);
      } catch (e) {
        console.warn('[registry] loadAllJsAdapters 早返回：inject(SandboxService) 失败（无 Angular 注入上下文）', e);
        return;
      }
    }
    try {
      const list = await pom.booksourceList();
      let registered = 0;
      const registeredNames: string[] = [];
      for (const meta of list) {
        if (!meta.enabled) continue;
        try {
          const adapter = new JsSourceAdapter(meta, sandbox);
          this.registerJsAdapter(adapter);
          registered++;
          registeredNames.push(adapter.name);
        } catch (err) {
          console.warn(`[registry] 加载书源 ${meta.fileName} 失败:`, err);
        }
      }
      console.info(`[registry] ✓ loadAllJsAdapters 完成：注册 ${registered} 个 JS 书源`, registeredNames);
    } catch (err) {
      console.warn('[registry] 拉取书源列表失败:', err);
    }
  }

  /** 专用适配器优先；找不到走启发式兜底（匹配任意 http URL） */
  private resolve(url: string): BookSourceAdapter {
    // 1. 专用适配器（hostPattern 限定具体域名）
    const specific = this.adapters.find((x) => x.name !== '通用（启发式）' && x.match(url));
    if (specific) return specific;
    // 2. 启发式兜底
    const heuristic = this.adapters.find((x) => x.name === '通用（启发式）' && x.match(url));
    if (heuristic) return heuristic;
    throw new FetchError('unsupported-source');
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

  /** 按书源名查找适配器（T-006 多源搜索用：search(keyword) 鸭子类型） */
  get(name: string): BookSourceAdapter | undefined {
    return this.adapters.find((a) => a.name === name);
  }
}
