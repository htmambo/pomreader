import { Injectable } from '@angular/core';
import { FetchError } from '../fetch-error';

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
interface HttpProxyResponse { status: number; headers: Record<string, string>; body: string; }

interface PendingCall {
  resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout>;
}

interface WorkerMessage {
  type: 'loaded' | 'result' | 'http';
  fileName?: string; fns?: string[];
  reqId?: string; ok?: boolean; value?: unknown;
  error?: string; errorName?: string; request?: HttpProxyRequest;
}

const POOL_CAPACITY = 6;       // spec FR-1.3.2
const CALL_TIMEOUT_MS = 15_000; // spec FR-1.3.2
const LOAD_DELAY_MS = 50;       // v1 简化：避免消息时序耦合

/**
 * 沙箱 Service（实施计划 T-002 + spec FR-1.3）
 * 单 Worker + 内部 Map 模拟 pool 容量 6（DM-2）；
 * 单次 call 15s 超时熔断（FR-1.3.2）；
 * invalidate(fileName) 清除 Worker 模块缓存 + 本地 metadata（FR-1.3.1）。
 */
@Injectable({ providedIn: 'root' })
export class SandboxService {
  private worker: Worker | null = null;
  private readonly loaded = new Map<string, LoadedModule>();
  private readonly pendingLoads = new Map<string, (m: LoadedModule) => void>();
  private readonly pending = new Map<string, PendingCall>();
  private poolActive = 0;
  private readonly poolQueue: Array<() => void> = [];

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
      const url = new URL('./sandbox.worker', import.meta.url);
      this.attach(new Worker(url));
    }
    return this.worker!;
  }

  private attach(w: Worker): void {
    this.worker = w;
    w.onmessage = (e: MessageEvent<WorkerMessage>) => this.handleMessage(e.data);
    w.onerror = (e) => console.error('[SandboxService] worker error', e);
  }

  private handleMessage(msg: WorkerMessage): void {
    if (msg.type === 'loaded' && msg.fileName) {
      const mod: LoadedModule = { fileName: msg.fileName, fns: msg.fns ?? [] };
      this.loaded.set(msg.fileName, mod);
      const cb = this.pendingLoads.get(msg.fileName);
      if (cb) { this.pendingLoads.delete(msg.fileName); cb(mod); }
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
  }

  private poolAcquire(): Promise<void> {
    if (this.poolActive < POOL_CAPACITY) { this.poolActive++; return Promise.resolve(); }
    return new Promise<void>((r) => this.poolQueue.push(r));
  }

  private poolRelease(): void {
    const next = this.poolQueue.shift();
    if (next) next(); else this.poolActive = Math.max(0, this.poolActive - 1);
  }

  /** load(fileName, source) — 缓存命中直接返回；否则发 'load'，等 'loaded' 或 50ms 兜底 */
  load(fileName: string, source: string): Promise<LoadedModule> {
    const cached = this.loaded.get(fileName);
    if (cached) return Promise.resolve(cached);
    this.ensureWorker().postMessage({ type: 'load', fileName, source });
    return new Promise<LoadedModule>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingLoads.delete(fileName);
        resolve(this.loaded.get(fileName) ?? { fileName, fns: [] });
      }, LOAD_DELAY_MS);
      this.pendingLoads.set(fileName, (m) => { clearTimeout(timer); resolve(m); });
    });
  }

  /** call(fileName, fn, args) — 15s 超时熔断 + pool 排队 */
  async call<T = unknown>(fileName: string, fn: SandboxFn, args: unknown[]): Promise<T> {
    await this.poolAcquire();
    const reqId = `req-${Math.random().toString(36).slice(2)}-${Date.now()}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(reqId)) {
          this.poolRelease();
          reject(new FetchError('timeout', `沙箱调用 ${fileName}.${fn} 超时（${CALL_TIMEOUT_MS}ms）`));
        }
      }, CALL_TIMEOUT_MS);
      this.pending.set(reqId, { resolve: (v) => resolve(v as T), reject: (e) => reject(e), timer });
      this.ensureWorker().postMessage({ type: 'call', reqId, fileName, fn, args });
    });
  }

  /** invalidate(fileName) — 清 Worker + 本地缓存（FR-1.3.1） */
  invalidate(fileName: string): void {
    if (this.worker) this.worker.postMessage({ type: 'invalidate', fileName });
    this.loaded.delete(fileName);
    this.pendingLoads.delete(fileName);
  }

  private async proxyHttp(reqId: string, request: HttpProxyRequest): Promise<void> {
    const proxy = window.pomAPI?.booksourceHttpProxy;
    if (!proxy) { this.sendHttpError(reqId); return; }
    try {
      const res = await proxy(request);
      this.worker!.postMessage({ type: 'http-result', reqId, status: res.status, headers: res.headers, body: res.body });
    } catch { this.sendHttpError(reqId); }
  }

  private sendHttpError(reqId: string): void {
    this.worker!.postMessage({ type: 'http-result', reqId, status: 599, headers: {}, body: '' });
  }
}
