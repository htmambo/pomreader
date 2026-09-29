import { Injectable, inject } from '@angular/core';
import {
  type BookSourceAdapter,
  type CatalogEntry,
  type PageFetcher,
  type ResolvedBook,
  extractMetaUuid,
  hasMetaUuid,
} from './book-source.adapter';
import { PageFetcherService } from './page-fetcher.service';
import { FetchError } from './fetch-error';
import { JsSourceAdapter } from './js-source/js-source.adapter';
import { SandboxService } from './js-source/sandbox.service';
import { type BookSourceMeta } from './js-source/source-meta.types';
import { jsEngineEnabled, ruleEngineEnabled } from './feature-flag';
import { JsonRuleAdapter } from './json-rule/json-rule.adapter';
import { RuleEngineService } from './json-rule/rule-engine.service';
import { UNIVERSAL_BOOK_SOURCE_UUID } from './book-source.constants';

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
   * 注册 JSON 规则书源适配器（方案 §3.3 / P1）：插入到所有 JS 适配器之前。
   * - resolve 按数组序 first-match，JSON 在 JS 前 → 同 uuid / 同域名时 JSON 胜出（JSON > JS）。
   * - 决策说明：方案字面优先级「JSON > JS > 内置适配器」，但为避免破坏现有阅读功能，
   *   不改变内置/启发式适配器的现有优先级（仍排最前）；实际顺序为「内置 > 启发式 > JSON > JS」。
   * - 用 instanceof JsSourceAdapter 定位插入点（本模块已 import 该类，无新增耦合）。
   */
  registerRuleAdapter(adapter: JsonRuleAdapter): void {
    const firstJsIdx = this.adapters.findIndex((a) => a instanceof JsSourceAdapter);
    if (firstJsIdx === -1) {
      this.adapters.push(adapter);
    } else {
      this.adapters.splice(firstJsIdx, 0, adapter);
    }
  }

  /**
   * 启动时拉取全部书源元数据，逐个构造 JsSourceAdapter 注册。
   * - 运行时开关 jsEngineEnabled() 为 false → 直接返回（P1 运行时开关，取代原编译期 flag）
   * - preload 不可用（浏览器降级） → 直接返回
   * - 单条书源失败 → console.warn 跳过，不阻塞其他
   *
   * @param externalSandbox 可选：外部传入的 SandboxService（推荐，APP_INITIALIZER 等异步上下文中
   *        调 `inject()` 会抛 NG0203）。不传时尝试内部 inject（仅 forTest / 直接调用场景可用）
   */
  async loadAllJsAdapters(externalSandbox?: SandboxService): Promise<void> {
    if (!jsEngineEnabled()) {
      console.warn('[registry] loadAllJsAdapters 早返回：运行时开关 jsEngineEnabled() = false');
      return;
    }
    const pom =
      typeof window !== 'undefined'
        ? (
            window as unknown as {
              pomAPI?: { booksourceList?: () => Promise<BookSourceMeta[]> };
            }
          ).pomAPI
        : undefined;
    if (!pom?.booksourceList) {
      console.warn(
        '[registry] loadAllJsAdapters 早返回：window.pomAPI.booksourceList 不存在（preload 未注册 / 非 Electron 环境）',
      );
      return;
    }
    let sandbox: SandboxService | undefined = externalSandbox;
    if (!sandbox) {
      try {
        sandbox = inject(SandboxService);
      } catch (e) {
        console.warn(
          '[registry] loadAllJsAdapters 早返回：inject(SandboxService) 失败（无 Angular 注入上下文）',
          e,
        );
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
      console.info(
        `[registry] ✓ loadAllJsAdapters 完成：注册 ${registered} 个 JS 书源`,
        registeredNames,
      );
    } catch (err) {
      console.warn('[registry] 拉取书源列表失败:', err);
    }
  }

  /**
   * 启动时拉取全部 JSON 规则书源元数据，逐个构造 JsonRuleAdapter 注册（方案 §3.3 / P1）。
   * 结构与 loadAllJsAdapters 镜像：
   * - 运行时开关 ruleEngineEnabled() 为 false → 直接返回
   * - window.pomAPI.booksourceListJson 不存在（P2 才实现该 IPC，过渡期预期）→ console.warn 直接返回
   * - 单条书源失败 → console.warn 跳过，不阻塞其他
   *
   * @param externalService 可选：外部传入的 RuleEngineService（推荐，APP_INITIALIZER 等异步上下文中
   *        调 `inject()` 会抛 NG0203）。不传时尝试内部 inject（仅 forTest / 直接调用场景可用）
   */
  async loadAllRuleAdapters(externalService?: RuleEngineService): Promise<void> {
    if (!ruleEngineEnabled()) {
      console.warn('[registry] loadAllRuleAdapters 早返回：运行时开关 ruleEngineEnabled() = false');
      return;
    }
    const pom =
      typeof window !== 'undefined'
        ? (
            window as unknown as {
              // P2 的 scanJsonDir 产出同构 BookSourceMeta[]，此处按 BookSourceMeta[] 处理（本地 cast）
              pomAPI?: { booksourceListJson?: () => Promise<BookSourceMeta[]> };
            }
          ).pomAPI
        : undefined;
    if (!pom?.booksourceListJson) {
      console.warn(
        '[registry] loadAllRuleAdapters 早返回：window.pomAPI.booksourceListJson 不存在（preload 未注册 / 非 Electron 环境）',
      );
      return;
    }
    let service: RuleEngineService | undefined = externalService;
    if (!service) {
      try {
        service = inject(RuleEngineService);
      } catch (e) {
        console.warn(
          '[registry] loadAllRuleAdapters 早返回：inject(RuleEngineService) 失败（无 Angular 注入上下文）',
          e,
        );
        return;
      }
    }
    try {
      const list = await pom.booksourceListJson();
      let registered = 0;
      const registeredNames: string[] = [];
      for (const meta of list) {
        if (!meta.enabled) continue;
        try {
          const adapter = new JsonRuleAdapter(meta, service);
          this.registerRuleAdapter(adapter);
          registered++;
          registeredNames.push(adapter.name);
        } catch (err) {
          console.warn(`[registry] 加载 JSON 书源 ${meta.fileName} 失败:`, err);
        }
      }
      console.info(
        `[registry] ✓ loadAllRuleAdapters 完成：注册 ${registered} 个 JSON 书源`,
        registeredNames,
      );
    } catch (err) {
      console.warn('[registry] 拉取 JSON 书源列表失败:', err);
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

  /**
   * 按 URL 匹配适配器（resolve 的不抛错公开版）：专用 > JS 书源 > 启发式兜底。
   * 供 UI 层"猜当前源"（如换源弹窗默认选中）；不想命中启发式兜底的调用方需自行过滤。
   */
  matchByUrl(url: string): BookSourceAdapter | undefined {
    if (!url) return undefined;
    try {
      return this.resolve(url);
    } catch {
      return undefined;
    }
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

  /**
   * 按 legado meta.uuid 锚定具体书源（用于阅读时重抓章节列表/正文）。
   * - JsSourceAdapter 来源：精确匹配 meta.uuid
   * - UNIVERSAL_BOOK_SOURCE_UUID 永远返回 undefined（保证万能搜索的 bookSourceUuid 不误命中具体书源）
   * - 空 / 无效输入 → undefined
   * - 不依赖 instanceof，用 extractMetaUuid 工具（避免 registry 反向耦合 js-source 子模块）
   *
   * 注：如需"按 adapter.name 查"请用 `getByName(name)`，两者语义独立。
   */
  getByUuid(uuid: string): BookSourceAdapter | undefined {
    if (!uuid || uuid === UNIVERSAL_BOOK_SOURCE_UUID) return undefined;
    return this.adapters.find((a) => extractMetaUuid(a) === uuid);
  }

  /** 按 adapter.name 查找（独立 API，与 getByUuid 语义分离，不混淆 uuid/name 命名空间） */
  getByName(name: string): BookSourceAdapter | undefined {
    if (!name) return undefined;
    return this.adapters.find((a) => a.name === name);
  }

  /**
   * 按 URL 查找首个 match 的 JsSourceAdapter（universal-search 等场景用）。
   * 仅匹配持有有效 meta.uuid 的 JS 书源（内置启发式适配器 match 任意 URL 会误命中，跳过）。
   * 找不到时返回 undefined（调用方决定 fallback）。
   */
  findJsSourceAdapterByUrl(url: string): BookSourceAdapter | undefined {
    if (!url) return undefined;
    for (const a of this.adapters) {
      if (hasMetaUuid(a) && a.match(url)) return a;
    }
    return undefined;
  }
}
