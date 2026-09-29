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
import { isJsonSourceMeta, type BookSourceMeta } from './source-meta.types';
import { readBookSourceEngine, resolveEngineMode } from './feature-flag';
import { JsonRuleAdapter } from './json-rule/json-rule.adapter';
import { RuleEngineService } from './json-rule/rule-engine.service';
import { type BookSourceDoc } from '../models/book-source-doc.model';
import { UNIVERSAL_BOOK_SOURCE_UUID } from './book-source.constants';

/**
 * 书源适配器注册表（spec §4.3）
 * - 专用适配器优先（5 站固定选择器）
 * - 启发式适配器兜底（复刻原 vendor 通用解析，任意 URL 可试）
 * - register() 开放扩展
 * - 过渡期：JSON 规则适配器（`registerRuleAdapters`）与 JS 沙箱适配器（`loadAllJsAdapters`）并存，
 *   由 `pom.bookSource.engine` 运行时开关决定装哪些（方案 §3.3；P4 删 JS 链路时一并删）
 */
@Injectable({ providedIn: 'root' })
export class BookSourceRegistry {
  private readonly adapters: BookSourceAdapter[] = [];
  private fetcher: PageFetcher | null = null;
  private ruleEngine: RuleEngineService | null = null;
  /** 已注册的 JSON 规则适配器（切开关重装时按这份清单撤掉，避免重复注册） */
  private readonly ruleAdapters: JsonRuleAdapter[] = [];

  constructor() {
    try {
      this.fetcher = inject(PageFetcherService);
    } catch {
      this.fetcher = null;
    }
    try {
      this.ruleEngine = inject(RuleEngineService);
    } catch {
      this.ruleEngine = null;
    }
  }

  static forTest(fetcher: PageFetcher, ruleEngine?: RuleEngineService): BookSourceRegistry {
    const reg = new BookSourceRegistry();
    reg.fetcher = fetcher;
    // 构造函数里的 inject() 在非注入上下文会失败（forTest 场景），故允许显式补一个假引擎
    if (ruleEngine) reg.ruleEngine = ruleEngine;
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
   * 注册 JSON 规则适配器（方案 §3.3，与 `loadAllJsAdapters` 并列的第三条装配路径）
   *
   * 与 JS 那条的三处**刻意不同**：
   * 1. `unshift` 到**最前**（不是 push）：方案规定的优先级是 `JSON > JS > 内置`，JSON 必须压过
   *    内置站点适配器。JS 链路保持原有的 push（内置优先），那条顺序是 `spec §4 R-2` 的既有决定，
   *    改它属于独立的行为变更，不在本任务范围内。
   * 2. **同 uuid 顶掉 JS 适配器**：迁移后同一逻辑源同时存在 `.js` 与 `.json` 时，JSON 胜出
   *    （方案 §3.3）。不顶掉的话 `getByUuid` 会命中先注册的那个，注册顺序一变行为就漂。
   * 3. `enabled === false` 的源**不注册**（与 `loadAllJsAdapters` 的 marker 判定同义 ——
   *    迁移期启停状态从 marker 文件内联进了 JSON 文档）。
   *
   * 运行时开关选 `'js'` 时**撤掉已注册的规则适配器**再返回 —— 只 early-return 的话，
   * 用户在 UI 上看到"已切到旧引擎"，实际匹配与执行仍走新引擎，开关形同虚设
   * （外部评审 R1 抓到）。
   */
  registerRuleAdapters(docs: readonly BookSourceDoc[]): void {
    if (readBookSourceEngine() === 'js') {
      this.clearRuleAdapters();
      console.warn('[registry] registerRuleAdapters 跳过：运行时开关 pom.bookSource.engine = js');
      return;
    }
    if (!this.ruleEngine) {
      console.warn(
        '[registry] registerRuleAdapters 跳过：RuleEngineService 不可用（无注入上下文）',
      );
      return;
    }
    const engine = this.ruleEngine;
    const names: string[] = [];
    for (const doc of docs) {
      // ⚠️ 先摘旧、再判启停（外部评审 R1 抓出）：只 `if (!doc.enabled) continue` 的话，
      // 一次"曾经启用、现已禁用"的重装会把内存里的旧适配器**留在原地**，
      // 用户在编辑器禁用书源于运行时完全失效。
      // 本轮这条路径尚未被触发（`loadAllRuleAdapters` 只在启动时调一次），属潜在缺陷，
      // 但 `registerRuleAdapters` 的契约就是"可重复调用"，先修掉而不是等它发作。
      this.dropRuleAdapter(doc.uuid);
      if (!doc.enabled) continue;
      try {
        const adapter = new JsonRuleAdapter(doc, (d) => engine.engineFor(d));
        // 「JSON 胜出」：顶掉同 uuid 的 JS 适配器。
        // 刻意放在**真的要装**之后 —— 对禁用的文档做同 uuid 清理会连它那份
        // 可用的 JS 兜底一起删掉，把"禁用新源"变成"这个源彻底消失"。
        const sameUuid = this.adapters.findIndex((a) => extractMetaUuid(a) === adapter.meta.uuid);
        if (sameUuid >= 0) this.adapters.splice(sameUuid, 1);
        this.adapters.unshift(adapter);
        this.ruleAdapters.push(adapter);
        names.push(adapter.name);
      } catch (err) {
        console.warn(`[registry] 注册规则书源 ${doc.uuid} 失败:`, err);
      }
    }
    console.info(`[registry] ✓ registerRuleAdapters 完成：注册 ${names.length} 个规则书源`, names);
  }

  /**
   * 摘掉某个 uuid 已注册的**规则**适配器（总表 + 规则清单两处）
   *
   * 判定依据是「在不在 `ruleAdapters` 清单里 + 对象同一性」，**不按 uuid 在总表里猜**：
   * 同 uuid 可能还有一份 JS 适配器（迁移期 JSON 未装上时的兜底），按 uuid 删会把它误伤。
   * 也不�� `instanceof JsonRuleAdapter` —— registry 刻意不反向依赖 `json-rule` / `js-source`
   * 子模块的类型层级（见 `getByUuid` 的同款注释），`ruleAdapters` 已经是权威清单。
   */
  private dropRuleAdapter(uuid: string): void {
    for (let i = this.ruleAdapters.length - 1; i >= 0; i--) {
      const a = this.ruleAdapters[i]!;
      if (a.meta.uuid !== uuid) continue;
      this.ruleAdapters.splice(i, 1);
      const j = this.adapters.indexOf(a);
      if (j >= 0) this.adapters.splice(j, 1);
    }
  }

  /** 是否已有 JSON 规则源在册（`resolveEngineMode` 的过渡期兜底输入） */
  hasRuleAdapters(): boolean {
    return this.ruleAdapters.length > 0;
  }

  /** 撤掉全部 JSON 规则适配器（切换运行时开关后重装用；先撤后装避免重复） */
  clearRuleAdapters(): void {
    for (const a of this.ruleAdapters) {
      const i = this.adapters.indexOf(a);
      if (i >= 0) this.adapters.splice(i, 1);
    }
    this.ruleAdapters.length = 0;
  }

  /**
   * 启动时拉取全部书源元数据，逐个构造 JsSourceAdapter 注册。
   * - 编译期总闸关 → 直接返回（实现计划 §8 回滚）
   * - 运行时开关判到不装 JS → 直接返回
   * - preload 不可用（浏览器降级） → 直接返回
   * - 单条书源失败 → console.warn 跳过，不阻塞其他
   *
   * @param externalSandbox 可选：外部传入的 SandboxService（推荐，APP_INITIALIZER 等异步上下文中
   *        调 `inject()` 会抛 NG0203）。不传时尝试内部 inject（仅 forTest / 直接调用场景可用）
   */
  async loadAllJsAdapters(externalSandbox?: SandboxService): Promise<void> {
    const mode = resolveEngineMode(readBookSourceEngine(), this.hasRuleAdapters());
    if (!mode.useJs) {
      console.warn(
        `[registry] loadAllJsAdapters 早返回：运行时开关 pom.bookSource.engine = ${readBookSourceEngine()}`,
      );
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
   * 启动时拉取全部 `.json` 规则书源，逐个读文档 + schema 校验后注册
   *
   * 与 `loadAllJsAdapters` 同构的**第三条装配路径**（方案 §3.3），但：
   * - 只认 `format === 'json'` 的条目（`.js` 走那条路径）；分派靠 `format` 字段
   *   而不是猜后缀 —— `.json` 源也可能带 marker 时代的残留文件
   * - 读文档 + valibot 校验走 `RuleEngineService.readDoc`（**权威 schema 单一来源**，
   *   主进程那份 `jsonEnvelopeError` 只做信封粗筛，见 D8）
   * - 单条失败只 warn 跳过：一份坏文档不能让整批书源都装不上
   *
   * ⚠️ P3 接线前本方法**无人调用** —— 迁移产出的 `.json` 没有任何东西装载，
   * 症状是"迁移报告说成功了，但搜不到那个书源"。由 `app.config.ts` 的
   * `initBookSources` 在 `migrate()` **之后**串行调用（顺序保证见 D11）。
   */
  async loadAllRuleAdapters(): Promise<void> {
    if (!this.ruleEngine) {
      console.warn(
        '[registry] loadAllRuleAdapters 早返回：RuleEngineService 不可用（无注入上下文）',
      );
      return;
    }
    const listFn = typeof window !== 'undefined' ? window.pomAPI?.booksourceList : undefined;
    if (!listFn) {
      console.warn(
        '[registry] loadAllRuleAdapters 早返回：window.pomAPI.booksourceList 不存在（preload 未注册 / 非 Electron 环境）',
      );
      return;
    }
    try {
      const list = await listFn();
      const engine = this.ruleEngine;
      const docs: BookSourceDoc[] = [];
      for (const meta of list) {
        if (!isJsonSourceMeta(meta)) continue;
        try {
          docs.push(await engine.readDoc(meta.fileName, meta.sourceDir));
        } catch (err) {
          console.warn(`[registry] 读取规则书源 ${meta.fileName} 失败（跳过该源）:`, err);
        }
      }
      this.registerRuleAdapters(docs);
    } catch (err) {
      console.warn('[registry] loadAllRuleAdapters 拉取书源列表失败:', err);
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
