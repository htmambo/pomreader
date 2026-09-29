/**
 * 规则引擎服务（书源 JSON 规则化 P1.6）—— 替代 `SandboxService` 的三个消费点
 *
 * 消费点：书源调试页 / 书源测试页（两处今天调 `sandbox.call(fileName, entry, args)`，
 * 迁移后调本服务）。书源健康检测服务已删（零生产消费方，见 CONVENTIONS §exceptions）——
 * 它的能力探测（"这个源实现了哪些函数"）对 JSON 规则源恒为四入口全有，等价于无信息；
 * 真正有用的信号是主进程给的 `rulesInvalid`（JSON 合法性 + 必填规则非空），列表页已在用。
 *
 * 三件事，按顺序：
 * 1. **拿文档**：内存里的 `BookSourceDoc`（registry / 调试页）或经 IPC 读 JSON 文件（`readDoc`）；
 * 2. **造引擎**：`createRuleEngine` + 本服务提供的 HTTP 通道；
 * 3. **记 RuleTrace**：每次入口调用的请求 / 状态 / 条数 / 耗时，替代 `sandbox.progress`（F11）。
 *
 * ## HTTP 通道为什么直连 `booksourceHttpProxy`
 *
 * 与 `SandboxService.proxyHttp` **同一条通道**（都是 preload 的 `booksourceHttpProxy`），
 * 不走 `PageFetcherService.fetchHtml` —— 后者签名里没有 headers（带自定义头的源会静默丢头），
 * 且 `fetchPost` 遇 `cfChallenge` 只 throw 不弹窗（POST 搜索会丢掉人工过盾）。
 * 详见方案 §3.2「HTTP 链路」与 Round 3 修订。
 *
 * ## CF Tier 2 怎么接
 *
 * 响应带 `cfChallenge` → 直接调 `CfPromptService.prompt(url)`（fire-and-forget，不阻塞回执），
 * 等价于把 `sandbox.service.ts:623` 那一行原样搬到引擎层。**不经过 `FetchError`** ——
 * 那个错误码契约全仓没有监听器。
 */
import { Injectable, inject, signal, type Signal } from '@angular/core';
import * as v from 'valibot';
import { createRuleEngine, type EngineHttp, type RuleEngine } from './engine';
import type { BookInfoLike, LinkItem, RawSearchItem } from './engine';
import { BookSourceDocSchema, type BookSourceDoc } from '../../models/book-source-doc.model';
import { FetchError } from '../fetch-error';
import { CfPromptService } from '../../services/cf-prompt.service';

export type RuleEntry = 'search' | 'bookInfo' | 'chapterList' | 'chapterContent';

/** 单次 HTTP 往返的记录 */
export interface RuleTraceRequest {
  url: string;
  method: string;
  status: number;
  /** 该次往返耗时（ms） */
  ms: number;
  /** 命中 CF Tier 2（已弹人工过盾引导） */
  cfChallenge?: boolean;
}

/** 一次入口调用的完整轨迹（调试页一行 = 一个 RuleTrace） */
export interface RuleTrace {
  /** 书源标识（uuid + 名字），多源调试时区分来源 */
  source: string;
  entry: RuleEntry;
  requests: RuleTraceRequest[];
  /** 提取条数：search=结果数 / chapterList=章节数 / bookInfo=章节数 / chapterContent=正文字数 */
  resultCount: number;
  /** 入口总耗时（ms） */
  ms: number;
  /** 失败时的错误文案（成功时缺席）—— 响亮失败的证据留痕，不吞 */
  error?: string;
}

/** trace 环形缓冲上限：调试页一次会话可能跑几十次调用，钉住避免长会话无限增长 */
const MAX_TRACES = 50;

@Injectable({ providedIn: 'root' })
export class RuleEngineService {
  private readonly cfPrompt = inject(CfPromptService);
  private readonly traceBuf = signal<RuleTrace[]>([]);
  readonly traces: Signal<RuleTrace[]> = this.traceBuf.asReadonly();
  private fetchFallbackWarned = false;

  /**
   * 内存文档 → 引擎（**不记 trace**）
   *
   * 适配器走这条：抓取链路每章都调一次，记 trace 是调试页的职责，不该给热路径加开销。
   * 每次调用现造引擎（`createRuleEngine` 是纯构造，无 IO），因而"改完 JSON 立即生效"。
   */
  engineFor(doc: BookSourceDoc): RuleEngine {
    return this.buildEngine(doc, () => []);
  }

  /**
   * 造 HTTP 通道。
   *
   * `sink` 按**每次调用**传入（闭包持有自己的数组），刻意不用实例级共享数组：
   * 两个入口并发跑时（如测试页同时跑搜索与目录），共享 sink 会把 A 的请求记进 B 的轨迹。
   */
  private buildEngine(doc: BookSourceDoc, newSink: () => RuleTraceRequest[]): RuleEngine {
    return createRuleEngine({
      // 缺省收口（`searchContentType` 的条件缺省等）由 `createRuleEngine` 内部完成 ——
      // 它镜像的是生成模板的缺省链，放在引擎里才能保证**每条**构造路径都过（含差分基座）。
      rules: doc.rules,
      homepage: doc.homepage,
      headers: doc.headers,
      http: this.buildHttp(newSink()),
    });
  }

  // ── 四入口（带 trace；调试 / 测试 / 健康检测用）──

  async search(doc: BookSourceDoc, keyword: string, page: number): Promise<RawSearchItem[]> {
    return this.traced(doc, 'search', (sink) => async () => {
      const items = await this.buildEngine(doc, sink).search(keyword, page);
      return { value: items, count: items.length };
    });
  }

  async bookInfo(doc: BookSourceDoc, bookUrl: string): Promise<BookInfoLike> {
    return this.traced(doc, 'bookInfo', (sink) => async () => {
      const info = await this.buildEngine(doc, sink).bookInfo(bookUrl);
      return { value: info, count: info.chapters.length };
    });
  }

  async chapterList(doc: BookSourceDoc, bookUrl: string): Promise<LinkItem[]> {
    return this.traced(doc, 'chapterList', (sink) => async () => {
      const items = await this.buildEngine(doc, sink).chapterList(bookUrl);
      return { value: items, count: items.length };
    });
  }

  async chapterContent(doc: BookSourceDoc, chapterUrl: string): Promise<string> {
    return this.traced(doc, 'chapterContent', (sink) => async () => {
      const text = await this.buildEngine(doc, sink).chapterContent(chapterUrl);
      return { value: text, count: text.length };
    });
  }

  clearTraces(): void {
    this.traceBuf.set([]);
  }

  /**
   * 读 JSON 书源文件 → valibot 校验 → 文档
   *
   * 校验失败抛 `parse-failed` 并带上 valibot 的问题路径（"哪个字段不合法"是排障第一诉求）。
   * ⚠️ 每次调用都重新读文件：不缓存，保住"用户改完 JSON 立即生效"（与旧适配器同语义）。
   *
   * P2 存储层落地后由 `booksourceRead` 供 `.json`；本方法**现在就可被单测覆盖**
   * （fake `window.pomAPI`），不需要等 P2。
   */
  async readDoc(fileName: string, sourceDir?: string | null): Promise<BookSourceDoc> {
    const raw = await this.readSourceFile(fileName, sourceDir);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new FetchError(
        'parse-failed',
        `书源 ${fileName} 不是合法 JSON：${(e as Error).message}`,
      );
    }
    const result = v.safeParse(BookSourceDocSchema, parsed);
    if (!result.success) {
      const issue = result.issues[0];
      const where = issue ? formatIssuePath(issue.path) : '';
      throw new FetchError(
        'parse-failed',
        `书源 ${fileName} 规则非法${where ? `（${where}）` : ''}：${issue?.message ?? '未知错误'}`,
      );
    }
    return result.output;
  }

  private async readSourceFile(fileName: string, sourceDir?: string | null): Promise<string> {
    // 复用 page-fetcher.service.ts 的同源声明，不在 Window 上重复 declare
    const read = typeof window !== 'undefined' ? window.pomAPI?.booksourceRead : undefined;
    if (!read) throw new FetchError('source-unavailable', 'booksourceRead IPC 不可用');
    return await read(fileName, sourceDir ?? undefined);
  }

  /**
   * preload HTTP 代理：与 `SandboxService.proxyHttp` 同一通道
   *
   * - `cfChallenge` → 调 Tier 2 弹窗（fire-and-forget，**不 return**、不 throw、不改本次回执）。
   * - 代理抛错**向上抛**（不放 599）：`engine.ts` 的 2xx 门会把它当失败处理，而错误信息里
   *   带着真实原因（"ECONNREFUSED" 比 "HTTP 599" 有用）。旧链路的 599 是给 Worker 侧
   *   一个可识别的数值占位，这里不需要跨进程传递，故不复刻该占位。
   * - 无 pomAPI（浏览器 dev）→ fetch 降级，与 `proxyHttp` 的降级分支同构。
   */
  private buildHttp(sink: RuleTraceRequest[]): EngineHttp {
    return async (req) => {
      const started = Date.now();
      const proxy = typeof window !== 'undefined' ? window.pomAPI?.booksourceHttpProxy : undefined;
      if (proxy) {
        const res = await proxy({
          url: req.url,
          method: req.method ?? 'GET',
          headers: req.headers ?? {},
          body: req.body ?? null,
        });
        const cfChallenge = !!res.cfChallenge;
        sink.push({
          url: req.url,
          method: req.method ?? 'GET',
          status: res.status,
          ms: Date.now() - started,
          cfChallenge,
        });
        // fire-and-forget：与 `sandbox.service.ts:623` 逐字等价
        if (cfChallenge) this.cfPrompt.prompt(req.url);
        return { status: res.status, body: res.body ?? '', cfChallenge };
      }
      this.warnFetchFallbackOnce();
      const resp = await fetch(req.url, {
        method: req.method ?? 'GET',
        headers: req.headers ?? {},
        body: req.body ?? undefined,
      });
      const body = await resp.text();
      sink.push({
        url: req.url,
        method: req.method ?? 'GET',
        status: resp.status,
        ms: Date.now() - started,
        cfChallenge: false,
      });
      return { status: resp.status, body };
    };
  }

  /**
   * 浏览器 dev 降级**只提示一次**：没有代理就意味着没有 CF Tier 2、SSRF 网关与 15s 超时，
   * 与 `SandboxService.proxyHttp` 的降级分支同构（那条走 `this.log(...)` 留痕），
   * 静默降级只会让人把"dev 环境跑不通"误判成书源规则有问题。
   */
  private warnFetchFallbackOnce(): void {
    if (this.fetchFallbackWarned) return;
    this.fetchFallbackWarned = true;
    console.warn(
      '[RuleEngineService] booksourceHttpProxy 不可用，降级为 renderer fetch（CORS 受限，且无 CF 过盾）',
    );
  }

  // ── trace ──

  private async traced<T>(
    doc: BookSourceDoc,
    entry: RuleEntry,
    build: (sink: () => RuleTraceRequest[]) => () => Promise<{ value: T; count: number }>,
  ): Promise<T> {
    const started = Date.now();
    const requests: RuleTraceRequest[] = [];
    const source = `${doc.name || doc.uuid}（${doc.uuid}）`;
    try {
      const { value, count } = await build(() => requests)();
      this.push({ source, entry, requests, resultCount: count, ms: Date.now() - started });
      return value;
    } catch (e) {
      // 失败也留痕：调试页要能看到"这次为什么炸"，静默吞掉等于把排障线索删了
      this.push({
        source,
        entry,
        requests,
        resultCount: 0,
        ms: Date.now() - started,
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  }

  private push(t: RuleTrace): void {
    this.traceBuf.update((prev) => [...prev, t].slice(-MAX_TRACES));
  }
}

/**
 * valibot 的 `issue.path` 元素是**对象**（`{type:'object', key:'rules'}`），不是字符串 ——
 * 直接 `path.join('.')` 会得到 `rules.searchPath` → `[object Object].[object Object]`。
 * （这个 bug 由本服务的单测当场抓到：断言匹配 `rules.searchPath` 却拿到一串 `[object Object]`。）
 *
 * 只取 `key`（object/array/map/set/tuple 五类路径项都带 `key`，或用 `index`/`value` 兜底），
 * 空路径（根级错误，如整个文档不是对象）返回空串，由调用方决定是否加括号。
 */
function formatIssuePath(path: readonly unknown[] | undefined): string {
  if (!path || !path.length) return '';
  return path
    .map((item) => {
      if (typeof item === 'string' || typeof item === 'number') return String(item);
      if (item && typeof item === 'object') {
        const rec = item as { key?: unknown; index?: unknown };
        if (rec.key !== undefined) return String(rec.key);
        if (rec.index !== undefined) return String(rec.index);
      }
      return '?';
    })
    .join('.');
}
