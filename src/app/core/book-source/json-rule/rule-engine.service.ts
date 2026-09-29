/**
 * JSON 规则引擎服务（方案 §3.2 / P1）：RuleEngineService = JsonRuleEngine 的 Angular 装配层。
 *
 * 职责边界（对照历史沙箱服务在 JS 链路中的角色）：
 *  1. IO：每次入口调用都经 pomAPI.booksourceRead 重读文件 + JSON.parse + valibot parse
 *     （BookSourceDocSchema）——「改完立即生效」，无实例级缓存
 *     （书源是 dev 期频繁修改的资产，缓存会让改动不生效）。
 *  2. HTTP 接线：RuleEngineHttp 直连 pomAPI.booksourceHttpProxy（主进程 safeNetRequest，
 *     共享 persist:fetch session，CF cookie 互通）；cfChallenge → CfPromptService.prompt
 *     fire-and-forget（本次请求仍以非 2xx 失败，不阻塞抓取回执）。
 *  3. RuleTrace 暴露：内部 Subject → 只读 traces$ Observable 供调试页（P3）订阅。
 *     选型理由（vs 每次调用传 onTrace 透传）：adapter 不感知 trace，调用方（registry /
 *     聚合搜索）无需改签名；调试页订阅一次即可收全量流。引擎仍支持 per-call onTrace，
 *     本服务统一转发进 Subject，并补填 http trace 的 status（引擎的 RuleEngineHttp 只回
 *     body，status 只有本层知道 —— 引擎内请求逐条 await 串行，lastStatus 无竞态）。
 *
 * HTTP 状态码语义（对齐历史沙箱 worker 的 legado.http shim，P1 差分测试期逐字锁定）：
 *  仅 status ∈ [200,300) 视为成功 resolve body，其余一律 reject
 *  `Error('HTTP ${status}')`（含 3xx —— safe-net 已跟随重定向，3xx 到不了这里即异常）。
 *  本服务镜像该语义：非 2xx → FetchError('parse-failed', `HTTP ${status}`)。
 *  注意 page-fetcher.fetchPost 是 `status >= 400` 才抛，比引擎链路宽松；
 *  引擎链路对齐的是历史 worker shim（legado.http.get/post 的实际行为），不对齐 fetchPost。
 *
 * 无需 NgZone/inZone 包装：项目 zoneless（方案 §3.2 已论证）。
 */
import { Injectable, inject } from '@angular/core';
import { Subject, type Observable } from 'rxjs';
import * as v from 'valibot';
import { BookSourceDocSchema, type BookSourceDoc } from '../../models/book-source-doc.model';
import { FetchError } from '../fetch-error';
import { CfPromptService } from '../../services/cf-prompt.service';
import { type BookSourceMeta } from '../source-meta.types';
import {
  JsonRuleEngine,
  type RuleBookInfo,
  type RuleChapterItem,
  type RuleEngineHttp,
  type RuleSearchItem,
  type RuleTrace,
  type RuleTraceListener,
} from './engine';

@Injectable({ providedIn: 'root' })
export class RuleEngineService {
  private readonly cfPrompt = inject(CfPromptService);

  /** trace 流（调试用，P3 调试页订阅）；只读 Observable，外部不可 next */
  private readonly traceSubject = new Subject<RuleTrace>();
  readonly traces$: Observable<RuleTrace> = this.traceSubject.asObservable();

  async search(
    meta: BookSourceMeta,
    keyword: string,
    page: number | string = 1,
  ): Promise<RuleSearchItem[]> {
    const doc = await this.loadDoc(meta);
    const { engine, onTrace } = this.createEngine();
    return engine.search(doc, keyword, page, onTrace);
  }

  async bookInfo(meta: BookSourceMeta, bookUrl: string): Promise<RuleBookInfo> {
    const doc = await this.loadDoc(meta);
    const { engine, onTrace } = this.createEngine();
    return engine.bookInfo(doc, bookUrl, onTrace);
  }

  async chapterList(meta: BookSourceMeta, bookUrl: string): Promise<RuleChapterItem[]> {
    const doc = await this.loadDoc(meta);
    const { engine, onTrace } = this.createEngine();
    return engine.chapterList(doc, bookUrl, onTrace);
  }

  async chapterContent(meta: BookSourceMeta, chapterUrl: string): Promise<string> {
    const doc = await this.loadDoc(meta);
    const { engine, onTrace } = this.createEngine();
    return engine.chapterContent(doc, chapterUrl, onTrace);
  }

  /**
   * 每次入口调用重读文件 + valibot parse（无缓存 —— 「改完立即生效」；
   * JSON.parse + safeParse 是微秒级开销，无需缓存优化）。
   */
  private async loadDoc(meta: BookSourceMeta): Promise<BookSourceDoc> {
    // 本地 cast 而非改 Window.pomAPI 全局声明
    // （page-fetcher.service.ts 的声明 sourceDir?: string 不收 null，这里按 null 传）
    const pom = window.pomAPI as
      | { booksourceRead?: (fileName: string, sourceDir?: string | null) => Promise<string> }
      | undefined;
    const read = pom?.booksourceRead;
    if (!read) throw new FetchError('source-unavailable', 'booksourceRead IPC 不可用');
    // read 自身 reject（文件不存在等）原样透传
    const raw = await read(meta.fileName, meta.sourceDir || null);
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (e) {
      throw new FetchError(
        'parse-failed',
        `书源 ${meta.fileName} JSON 解析失败: ${(e as Error)?.message ?? String(e)}`,
      );
    }
    const parsed = v.safeParse(BookSourceDocSchema, json);
    if (!parsed.success) {
      // valibot issues 摘要带字段路径（如 rules.searchPath），便于用户定位规则 JSON 错误
      const summary = parsed.issues
        .map((i) => {
          const path = i.path?.map((p) => String(p.key)).join('.');
          return `${path || '(root)'}: ${i.message}`;
        })
        .join('; ');
      throw new FetchError('parse-failed', `书源 ${meta.fileName} 规则校验失败: ${summary}`);
    }
    return parsed.output;
  }

  /**
   * 每次调用新建引擎（引擎无状态，构造开销可忽略；不复用实例避免 lastStatus 串扰）。
   * onTrace 转发进 traceSubject，并为 stage=http 的 trace 补填 status。
   */
  private createEngine(): { engine: JsonRuleEngine; onTrace: RuleTraceListener } {
    let lastStatus: number | undefined;
    const http: RuleEngineHttp = {
      get: async (url, headers) => {
        const res = await this.proxyRequest('GET', url, undefined, headers);
        lastStatus = res.status;
        return res.body;
      },
      post: async (url, body, headers) => {
        const res = await this.proxyRequest('POST', url, body, headers);
        lastStatus = res.status;
        return res.body;
      },
    };
    const onTrace: RuleTraceListener = (t) => {
      // 引擎内每个请求 await 串行后才发 http trace，lastStatus 即该请求的状态码
      this.traceSubject.next(
        t.stage === 'http' && t.status === undefined ? { ...t, status: lastStatus } : t,
      );
    };
    return { engine: new JsonRuleEngine(http), onTrace };
  }

  /**
   * booksourceHttpProxy 直连 + CF 钩子 + 状态码语义（2xx-only resolve 契约，
   * 语义对齐见本文件头注释）。
   */
  private async proxyRequest(
    method: 'GET' | 'POST',
    url: string,
    body: string | undefined,
    headers: Record<string, string>,
  ): Promise<{ status: number; body: string }> {
    const proxy = window.pomAPI?.booksourceHttpProxy;
    if (!proxy) throw new FetchError('source-unavailable', 'booksourceHttpProxy IPC 不可用');
    let res: { status: number; body: string; cfChallenge?: boolean };
    try {
      res = await proxy({ url, method, headers, body: body ?? null });
    } catch (e) {
      // 代理自身失败（网络/DNS/IPC 异常；历史沙箱语义为 sendHttpError 599 → reject HTTP 599）
      throw new FetchError(
        'source-unavailable',
        `书源 HTTP 代理失败: ${(e as Error)?.message ?? String(e)}`,
      );
    }
    // Tier 1 自动过盾失败 → Tier 2 人工过盾引导；fire-and-forget 不阻塞本次回执
    // （本次请求仍以非 2xx 失败，与历史沙箱链路语义等价）
    if (res.cfChallenge) this.cfPrompt.prompt(url);
    // 仅 [200,300) 视为成功，其余 reject HTTP ${status}（历史 worker shim 语义）
    if (res.status < 200 || res.status >= 300) {
      throw new FetchError('parse-failed', `HTTP ${res.status}`);
    }
    return { status: res.status, body: res.body ?? '' };
  }
}
