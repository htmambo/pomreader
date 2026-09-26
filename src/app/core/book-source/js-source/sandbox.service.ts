import { Injectable, signal } from '@angular/core';
import { FetchError } from '../fetch-error';
import { cssRulesEnabled } from '../smart-add/smart-rules';

export type SandboxFn =
  | 'search' | 'bookInfo' | 'toc' | 'chapterList'
  | 'content' | 'chapterContent' | 'explore';

export interface LoadedModule { fileName: string; fns: string[]; }

/**
 * HTTP 代理请求/响应（仅沙箱内部用）
 * 完整 Window.pomAPI 接口在 page-fetcher.service.ts 声明
 */
interface HttpProxyRequest {
  url: string; method?: string;
  headers?: Record<string, string>; body?: string | null;
}
interface HttpProxyResponse { status: number; headers: Record<string, string>; body: string; cfChallenge?: boolean; }

/** legado.query 契约（与 sandbox.worker.ts 同源声明保持一致 —— Worker 无 import 策略） */
export interface QueryLink { href: string; text: string; }
export interface QueryItem {
  tag: string; text: string; html: string; href: string; links: QueryLink[];
}

interface PendingCall {
  resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout>;
}

interface PendingLoad {
  resolve: (m: LoadedModule) => void; reject: (e: Error) => void;
}

interface WorkerMessage {
  type: 'loaded' | 'result' | 'http' | 'query' | 'init-error' | 'worker-ready' | 'worker-log';
  fileName?: string; fns?: string[];
  reqId?: string; ok?: boolean; value?: unknown;
  error?: string; errorName?: string; request?: HttpProxyRequest;
  html?: string; selector?: string; baseUrl?: string;
  stack?: string;
  level?: 'info' | 'warn' | 'error';
  msg?: string;
}

const POOL_CAPACITY = 6;       // spec FR-1.3.2
const CALL_TIMEOUT_MS = 15_000; // spec FR-1.3.2
// load 必须等 Worker 真实回执：首次加载含 Worker 脚本启动耗时，50ms 兜底会把
// 「回复未到」误判成空 fns（书源未定义 search()）；10s 超时拒绝并保留真实原因
// (Round 9: 5s 在 dev 环境冷启动+硬化段执行偏紧,10s 给用户更宽容的诊断窗口)
const LOAD_TIMEOUT_MS = 10_000;
/** legado.query 主线程 DOMParser 输入上限（防超大 HTML 解析 OOM） */
const QUERY_HTML_LIMIT = 5 * 1024 * 1024;

/**
 * 沙箱 Service（实施计划 T-002 + spec FR-1.3）
 * 单 Worker + 内部 Map 模拟 pool 容量 6（DM-2）；
 * 单次 call 15s 超时熔断（FR-1.3.2）；
 * invalidate(fileName) 清除 Worker 模块缓存 + 本地 metadata（FR-1.3.1）。
 */
@Injectable({ providedIn: 'root' })
export class SandboxService {
  /**
   * CF 挑战钩子：主进程代理报告 Tier 1 自动过盾失败（cfChallenge）时调用。
   * 本类可被 forTest() 手动实例化（无 DI 上下文），UI 引导逻辑由
   * cf-prompt.service.ts（root injectable，启动时注册此钩子）承担。
   */
  static cfChallengeHook: ((url: string) => void) | null = null;

  /** 进度信号:UI 订阅显示当前执行到哪一步(load/call 步骤化日志)
   *  使用 readonly signal + 内部 push —— 避免外部直接 mutate
   */
  readonly progress = signal<string[]>([]);

  /** 加一条进度日志(同时打 console 供 dev 排查) —— 整段 try-catch 防止
   *  toLocaleTimeString / console.* / signal.update 任何一处抛错导致 onerror 递归 */
  private log(msg: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    let line: string;
    try {
      line = `[${new Date().toLocaleTimeString()}] ${msg}`;
    } catch {
      line = `[??:??:??] ${msg}`;
    }
    try {
      this.progress.update((arr) => [...arr, line].slice(-100));
    } catch { /* progress 不可用时静默 */ }
    try {
      if (level === 'error') console.error(msg);
      else if (level === 'warn') console.warn(msg);
      else console.info(msg);
    } catch { /* console.* 在 Worker error 期间可能被 zone 抑制,静默 */ }
  }

  /** 清空进度日志(每次新执行前) */
  clearProgress(): void {
    this.progress.set([]);
  }

  private worker: Worker | null = null;
  private readonly loaded = new Map<string, LoadedModule>();
  /** 书源源码缓存:key=fileName, value=上次加载的源码 —— load 时比对,内容变化则重新加载 */
  private readonly sourceCache = new Map<string, string>();
  private readonly pendingLoads = new Map<string, PendingLoad>();
  private readonly pending = new Map<string, PendingCall>();
  private poolActive = 0;
  private readonly poolQueue: Array<() => void> = [];
  /** Worker 启动健康状态：用于 LOAD_TIMEOUT reject 时附诊断信息 */
  private workerReadyReceived = false;
  private workerMessageCount = 0;
  /** Worker ready 信号 promise：load 路径等 ready 后再发消息(Round 9 P1-2) */
  private workerReadyResolve: (() => void) | null = null;
  private workerReadyReject: ((e: Error) => void) | null = null;
  private workerReadyPromise: Promise<void> | null = null;

  static forTest(worker: Worker): SandboxService {
    const svc = new SandboxService();
    svc.attach(worker);
    return svc;
  }

  private ensureWorker(): Worker {
    if (!this.worker) {
      // Round 3 hardening: classic worker（非 module）
      // — 沙箱内 dynamic `import()` 不可用（仅 module worker 支持）
      // — 用户书源 JS 无法 import('https://evil.com/...') 绕网络出口
      // — worker.ts 自身不使用 ES import 语句（只用 self / postMessage），classic 模式兼容
      // Round 12: Angular 18 application builder 不支持 webWorkerTsConfig 自动单独打包 worker,
      //   改用预编译 + assets 路径引用: assets/sandbox.worker.js 由 build 脚本(esbuild)产出并复制
      const url = new URL('assets/sandbox.worker.js', document.baseURI).href;
      this.attach(new Worker(url));
    }
    return this.worker!;
  }

  private attach(w: Worker): void {
    this.workerReadyReceived = false;
    this.workerMessageCount = 0;
    // 重置 ready promise:load 路径等 worker 发 worker-ready 再发消息(Round 9 P1-2)
    this.workerReadyPromise = new Promise<void>((resolve, reject) => {
      this.workerReadyResolve = resolve;
      this.workerReadyReject = reject;
    });
    this.worker = w;
    w.onmessage = (e: MessageEvent<WorkerMessage>) => this.handleMessage(e.data);
    w.onerror = (e) => {
      // w.onerror 回调本身**绝对不能抛错** —— Zone/GlobalErrorHandler 会二次捕获形成递归链
      // 用 try-syncReject-finally 三段式确保任何路径抛错都被吞掉
      let reason = 'Worker 错误：未知（:0）';
      try {
        const ev = e as ErrorEvent & { error?: Error; colno?: number };
        const errObj = ev.error;
        const stack = errObj?.stack ?? '';
        const detail = errObj ? `${errObj.name ?? 'Error'}: ${errObj.message ?? '?'}` : '(no error obj)';
        // 行 1:console.error —— 用普通 try-catch 包(zone patch 在 Worker error 期间可能抛错)
        try { console.error(`[SandboxService] ✗ Worker onerror: ${detail} (${ev.filename ?? ''}:${ev.lineno ?? 0}:${ev.colno ?? 0}) stack=${stack.slice(0, 200)}`); } catch {}
        // 行 2:progress.update —— 同样 try-catch
        this.log(`✗ Worker onerror: ${detail} (${ev.filename ?? ""}:${ev.lineno ?? 0}) stack=${stack.slice(0, 200)}`, "error");
        // 行 3:拼 reject reason
        reason = `Worker 错误：${errObj?.message ?? ev.message ?? '未知'}（${ev.filename ?? ''}:${ev.lineno ?? 0}）`;
        // 行 4:集中 settle workerReadyPromise(幂等,init-error 也走同一路径避免 race)
        try { this.settleWorkerReady(reason); } catch {}
        // 行 5:failAllPendingLoads —— cb.reject 可能抛错(用户 reject handler 抛错) 每个 reject 包 try
        this.failAllPendingLoads(reason);
      } catch (handlerErr) {
        // 兜底:任何路径抛错 —— 仍尝试 settle 一次,但不抛
        try { console.error('[SandboxService] ✗ onerror handler threw:', handlerErr); } catch {}
        try { this.settleWorkerReady(reason); } catch {}
        try { this.failAllPendingLoads(reason); } catch {}
      }
      // 最外层 guard:即使 try/catch 都没接住(极少见,如 Zone patch 后全局抛错),也不让 escape
      // (实际上到这里已经没有 throw,但某些 V8 引擎在 async 任务结束后仍可能检测到 unhandled)
    };
    w.onmessageerror = (e) => {
      const reason = `Worker 消息反序列化失败：${(e as MessageEvent).data ?? 'unknown'}`;
      this.log(reason, 'error');
      this.settleWorkerReady(reason);
      this.failAllPendingLoads(reason);
    };
  }

  /** 把所有 pendingLoads 立即拒绝并清空,用于 worker 启动失败兜底 */
  /** 集中 settle workerReadyPromise —— 无论 init-error / onerror / onmessageerror 谁先触发,
   *  都保证 promise 被 settle 一次;重复调用是 silent no-op
   */
  private settleWorkerReady(reason: string): void {
    const err = new Error(reason);
    if (this.workerReadyReject) {
      try { this.workerReadyReject(err); } catch { /* silent */ }
      this.workerReadyReject = null;
    }
    if (this.workerReadyResolve) {
      try { this.workerReadyResolve(); } catch { /* silent */ }
      this.workerReadyResolve = null;
    }
  }

  /** 把所有 pendingLoads 立即拒绝并清空,用于 worker 启动失败兜底 */
  private failAllPendingLoads(reason: string): void {
    if (this.pendingLoads.size === 0) return; // 幂等守卫：超时 reject 后再触发 init-error 不会重复 reject
    for (const [fileName, cb] of this.pendingLoads) {
      this.pendingLoads.delete(fileName);
      try { cb.reject(new Error(reason)); } catch { /* 用户 reject handler 抛错时静默,避免污染 onerror 链 */ }
    }
  }

  /** 等 Worker 发 worker-ready;若 worker 启动失败由 attach 的 onerror/onmessageerror 兜底 reject
   *  兜底超时：防止硬化段抛错后 init-error 也未送达（极少见,但需可观测）
   */
  private async waitForReady(): Promise<void> {
    if (this.workerReadyReceived) return;
    if (this.workerReadyPromise) {
      await Promise.race([
        this.workerReadyPromise,
        new Promise<void>((_, reject) => setTimeout(() => {
          reject(new Error(`Worker 未在 ${LOAD_TIMEOUT_MS}ms 内发 ready 信号(可能硬化段抛错且 init-error 未送达)`));
        }, LOAD_TIMEOUT_MS)),
      ]);
    }
  }

  private handleMessage(msg: WorkerMessage): void {
    this.workerMessageCount++;
    if (msg.type === 'worker-log' && msg.msg) {
      // Worker 端日志(硬化阶段进度、load 接收、call 处理等) → 推到 progress signal
      this.log(msg.msg, msg.level ?? 'info');
      return;
    }
    if (msg.type === 'worker-ready') {
      // Worker 启动成功信号：硬化代码+message listener 都已就绪
      this.workerReadyReceived = true;
      this.workerReadyResolve?.();
      this.workerReadyResolve = null;
      this.log('[SandboxService] worker ready');
      return;
    }
    if (msg.type === 'init-error') {
      // Worker 启动段硬化代码抛错(被 worker 内 try-catch 捕获并 postMessage 回来)
      // 主动 reject 所有 pendingLoads,避免 LOAD_TIMEOUT_MS 才反馈
      this.log(`[SandboxService] worker init-error: ${msg.error}`, 'error');
      const reason = `Worker 启动失败：${msg.error ?? '未知错误'}`;
      // 集中 settle —— 与 onerror 同一路径,避免 race
      this.settleWorkerReady(reason);
      this.failAllPendingLoads(reason);
      return;
    }
    if (msg.type === 'loaded' && msg.fileName) {
      const cb = this.pendingLoads.get(msg.fileName);
      this.pendingLoads.delete(msg.fileName);
      if (msg.error) {
        // 编译/求值失败：不缓存空模块，向调用方抛 Worker 回传的真实错误
        cb?.reject(new Error(`书源编译失败：${msg.error}`));
        return;
      }
      const mod: LoadedModule = { fileName: msg.fileName, fns: msg.fns ?? [] };
      this.loaded.set(msg.fileName, mod);
      cb?.resolve(mod);
      return;
    }
    if (msg.type === 'result' && msg.reqId) {
      const entry = this.pending.get(msg.reqId);
      if (!entry) return;
      // 仅当成功 delete（result 先于 timeout）才释放池
      if (!this.pending.delete(msg.reqId)) return;
      clearTimeout(entry.timer);
      if (msg.ok) {
        entry.resolve(msg.value);
      } else {
        // 重建原始错误类型（保留 ReferenceError / TypeError）— 沙箱隔离可观测
        const name = msg.errorName ?? 'Error';
        const Ctor = (globalThis as unknown as Record<string, typeof Error>)[name] ?? Error;
        const e = new Ctor(msg.error ?? '沙箱调用失败');
        e.name = name;
        entry.reject(e);
      }
      this.poolRelease();
      return;
    }
    if (msg.type === 'http' && msg.reqId) {
      void this.proxyHttp(msg.reqId, msg.request as HttpProxyRequest);
    }
    if (msg.type === 'query' && msg.reqId) {
      this.proxyQuery(msg.reqId, msg.html ?? '', msg.selector ?? '', msg.baseUrl ?? '');
    }
  }

  private poolAcquire(): Promise<void> {
    if (this.poolActive < POOL_CAPACITY) { this.poolActive++; return Promise.resolve(); }
    return new Promise<void>((r) => this.poolQueue.push(r));
  }

  private poolRelease(): void {
    const next = this.poolQueue.shift();
    if (next) next(); else this.poolActive = Math.max(0, this.poolActive - 1);
  }

  /** load(fileName, source) — 缓存命中直接返回；否则等 Worker ready 后发 'load' 并等回执（编译失败/超时均 reject） */
  async load(fileName: string, source: string): Promise<LoadedModule> {
    // 缓存命中但源码已修改 → 主动失效 + 重新编译
    if (this.loaded.has(fileName) && this.sourceCache.get(fileName) !== source) {
      this.log(`⚠ 书源 ${fileName} 源码已变更,重新加载...`);
      this.invalidate(fileName);
    }
    const cached = this.loaded.get(fileName);
    if (cached) {
      this.log(`✓ 书源 ${fileName} 已缓存,直接返回 fns=${cached.fns.join(',') || '(无)'}`);
      return cached;
    }
    this.sourceCache.set(fileName, source);
    this.log(`⏳ 正在加载书源 ${fileName} (源码 ${source.length} 字节)...`);
    this.log(`⏳ 步骤 1/3: 等待 Worker ready 信号...`);
    await this.waitForReady();
    this.log(`✓ 步骤 1/3 完成: Worker ready,发送 load 消息`);
    this.ensureWorker().postMessage({ type: 'load', fileName, source });
    this.log(`⏳ 步骤 2/3: 等待 Worker 编译书源并返回 loaded 回执...`);
    return new Promise<LoadedModule>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingLoads.delete(fileName);
        const diag = `ready=${this.workerReadyReceived ? '是' : '否'} 收到消息=${this.workerMessageCount} 条`;
        this.log(`✗ 步骤 2/3 超时: ${diag}`, 'error');
        reject(new FetchError('timeout',
          `书源 ${fileName} 加载超时（${LOAD_TIMEOUT_MS}ms，Worker 未回执；${diag}）。` +
          `如 ready=否 → Worker 启动段硬化代码抛错或 Worker 整体未启动；` +
          `如 ready=是 → Worker 处理 load 时未回执,可能书源顶层有同步死循环或阻塞调用。`,
        ));
      }, LOAD_TIMEOUT_MS);
      this.pendingLoads.set(fileName, {
        resolve: (m) => {
          clearTimeout(timer);
          this.log(`✓ 步骤 3/3 完成: 书源 ${fileName} 加载成功 fns=${m.fns.join(',') || '(无)'}`);
          resolve(m);
        },
        reject: (e) => {
          clearTimeout(timer);
          this.log(`✗ 步骤 3/3 失败: ${e.message}`, 'error');
          reject(e);
        },
      });
    });
  }

  /** call(fileName, fn, args) — 15s 超时熔断 + pool 排队 */
  async call<T = unknown>(fileName: string, fn: SandboxFn, args: unknown[]): Promise<T> {
    await this.poolAcquire();
    const reqId = `req-${Math.random().toString(36).slice(2)}-${Date.now()}`;
    // 步骤化日志:便于用户定位卡哪一步
    this.log(`▶ 调用 ${fileName}.${fn}(${args.map((a) => typeof a === 'string' ? `"${a.slice(0, 60)}${a.length > 60 ? '...' : ''}"` : JSON.stringify(a)).join(', ')})`);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(reqId)) {
          this.poolRelease();
          this.log(`✗ ${fileName}.${fn} 超时 (${CALL_TIMEOUT_MS}ms)`, 'error');
          reject(new FetchError('timeout', `沙箱调用 ${fileName}.${fn} 超时（${CALL_TIMEOUT_MS}ms）`));
        }
      }, CALL_TIMEOUT_MS);
      this.pending.set(reqId, {
        resolve: (v) => {
          clearTimeout(timer);
          const len = typeof v === 'string' ? v.length : v === undefined ? 0 : JSON.stringify(v).length;
          this.log(`✓ ${fileName}.${fn} 返回 (${len} 字节)`);
          resolve(v as T);
        },
        reject: (e: Error) => {
          clearTimeout(timer);
          this.log(`✗ ${fileName}.${fn} 异常: ${e.message}`, 'error');
          reject(e);
        },
        timer,
      });
      this.ensureWorker().postMessage({ type: 'call', reqId, fileName, fn, args });
    });
  }

  /** invalidate(fileName) — 清 Worker + 本地缓存（FR-1.3.1） */
  invalidate(fileName: string): void {
    if (this.worker) this.worker.postMessage({ type: 'invalidate', fileName });
    this.loaded.delete(fileName);
    this.sourceCache.delete(fileName);
    this.pendingLoads.delete(fileName);
  }

  private async proxyHttp(reqId: string, request: HttpProxyRequest): Promise<void> {
    // 主进程代理优先：走 safeNetRequest（共享 persist:fetch session，CF cookie 互通、免 CORS）。
    // Round 14 曾改走 renderer fetch 绕开 net.request redirect: 'manual' 主动 abort 的
    // 'Redirect was cancelled' 误报 —— 该问题已在 safe-net 修复（aborted 标记），主链路回到主进程。
    const proxy = window.pomAPI?.booksourceHttpProxy;
    if (proxy) {
      try {
        const res = await proxy(request);
        // Tier 1 自动过盾失败（交互式 Turnstile）→ 通知 UI 层引导人工过盾（Tier 2）
        if (res.cfChallenge) SandboxService.cfChallengeHook?.(request.url);
        this.worker!.postMessage({ type: 'http-result', reqId, status: res.status, headers: res.headers, body: res.body });
      } catch (e) {
        const msg = (e as Error)?.message ?? String(e);
        this.log(`✗ legado.http 主进程代理失败: ${msg} (URL=${request.url.slice(0, 80)})`, 'error');
        this.sendHttpError(reqId);
      }
      return;
    }
    // 浏览器 dev 降级（无 pomAPI）：renderer fetch，受 CORS 限制
    try {
      const resp = await fetch(request.url, {
        method: request.method ?? 'GET',
        headers: request.headers ?? {},
        body: request.body ?? undefined,
      });
      const body = await resp.text();
      const headers: Record<string, string> = {};
      resp.headers.forEach((v, k) => { headers[k] = v; });
      this.worker!.postMessage({ type: 'http-result', reqId, status: resp.status, headers, body });
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      const hint = msg.includes('Failed to fetch') || msg.includes('NetworkError')
        ? ' —— 网络/CORS/DNS 失败(浏览器 fetch 限制):检查书源 URL 可达性或设置 CSP/CORS 头'
        : '';
      this.log(`✗ legado.http fetch 失败: ${msg}${hint} (URL=${request.url.slice(0, 80)})`, 'error');
      this.sendHttpError(reqId);
    }
  }

  private sendHttpError(reqId: string): void {
    this.worker!.postMessage({ type: 'http-result', reqId, status: 599, headers: {}, body: '' });
  }

  /**
   * legado.query 主线程执行体：DOMParser 解析（不挂载、不执行脚本），只回传纯数据。
   * error 通道：Feature Flag 关闭 / HTML 超 5MB / 选择器非法 → {ok:false,error} → Worker 侧 reject
   */
  private proxyQuery(reqId: string, html: string, selector: string, baseUrl: string): void {
    const fail = (error: string) =>
      this.worker!.postMessage({ type: 'query-result', reqId, ok: false, error });
    if (!cssRulesEnabled()) {
      fail('CSS 规则已禁用（localStorage pom.cssRules=0）');
      return;
    }
    if (html.length > QUERY_HTML_LIMIT) {
      fail(`HTML 超过 ${QUERY_HTML_LIMIT / 1024 / 1024}MB 解析上限`);
      return;
    }
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const items = Array.from(doc.querySelectorAll(selector)).map((el) =>
        this.toQueryItem(el, baseUrl),
      );
      this.worker!.postMessage({ type: 'query-result', reqId, ok: true, items });
    } catch (e) {
      fail(`选择器无效：${(e as Error).message}`);
    }
  }

  /** 命中元素 → 契约结构；links 为自身（a 时）+ 后代锚点，href 一律预绝对化 */
  private toQueryItem(el: Element, baseUrl: string): QueryItem {
    const abs = (href: string | null): string => {
      if (!href) return '';
      try {
        return new URL(href, baseUrl).href;
      } catch {
        return '';
      }
    };
    const isAnchor = el.tagName === 'A';
    const anchors = isAnchor ? [el] : Array.from(el.querySelectorAll('a[href]'));
    return {
      tag: el.tagName.toLowerCase(),
      text: (el.textContent ?? '').trim(),
      html: el.innerHTML,
      href: isAnchor ? abs(el.getAttribute('href')) : '',
      links: anchors
        .map((a) => ({ href: abs(a.getAttribute('href')), text: (a.textContent ?? '').trim() }))
        .filter((l) => l.href),
    };
  }
}
