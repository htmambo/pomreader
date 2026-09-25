/// <reference lib="webworker" />

/**
 * 书源沙箱 Worker（实施计划 T-002 + spec FR-1.3 + NFR-2）
 *
 * 职责：
 * - 启动时深度冻结敏感全局（沙箱硬化，legado 同款思路）
 * - 按 fileName 缓存 `new Function('legado', source)` 编译产物
 * - legado.http.{get,post,request} 走 postMessage 回主线程执行（绕 CORS）
 * - 单函数调用支持 async/await，结果通过 reqId 回传
 *
 * Round 4 hardening 摘要：
 * - Classic Worker（sandbox.service.ts 不传 type: 'module'）→ dynamic import() 不可用
 * - 网络 API 屏蔽：用 Object.defineProperty getter 抛错（不是单纯赋值；configurable: false 防 delete + 重定义）
 * - 原型链冻结防 prototype pollution
 */

// ── 启动时沙箱硬化（NFR-2） ──────────────────────────────────────────────
delete (self as unknown as Record<string, unknown>).window;
delete (self as unknown as Record<string, unknown>).document;
delete (self as unknown as Record<string, unknown>).localStorage;
delete (self as unknown as Record<string, unknown>).parent;
delete (self as unknown as Record<string, unknown>).top;

/** Round 4/5 hardening: 屏蔽所有可能的网络出口
 * - fetch / XMLHttpRequest / WebSocket：标准网络出口
 * - importScripts：Worker 自身 import（classic worker 中可用）
 * - Worker / SharedWorker：创建子 Worker 是 Critical 旁路
 * - EventSource / WebTransport / RTCPeerConnection / RTCDataChannel：SSE/WebRTC 出口
 * - 屏蔽机制：`Object.defineProperty` getter 抛错；setter 也抛错（防止书源覆盖 + 探测）
 * - Round 5: 屏蔽失败必须抛错，不能静默 ignore（暴露沙箱加固问题）
 */
const NETWORK_API_BLOCKLIST = [
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'importScripts',
  'Worker',
  'SharedWorker',
  'EventSource',
  'WebTransport',
  'RTCPeerConnection',
  'RTCDataChannel',
];
for (const name of NETWORK_API_BLOCKLIST) {
  Object.defineProperty(self, name, {
    get: () => {
      throw new Error(`${name} is disabled in sandbox; use legado.http instead`);
    },
    set: () => {
      throw new Error(`${name} is read-only and disabled in sandbox`);
    },
    enumerable: false,
    configurable: false,
  });
}

/** navigator.sendBeacon 通过 Proxy 防逃逸（Round 5 加固）
 * - `get`: sendBeacon 拦截抛错；其他属性返回 bind 后的方法（防 this 逃逸）
 * - `has`: sendBeacon 返回 true（保持接口完整性）
 * - `getOwnPropertyDescriptor`: sendBeacon 返回非 configurable 描述符
 * - Round 6 hardening: 增加 `set` / `defineProperty` / `deleteProperty` trap 全部抛错
 *   防止书源 `navigator.x = ...` 写穿透到真实 navigator 对象
 */
const originalNavigator = (self as unknown as { navigator?: object }).navigator ?? {};
Object.defineProperty(self, 'navigator', {
  value: new Proxy(originalNavigator, {
    get(target, prop) {
      if (prop === 'sendBeacon') {
        return () => { throw new Error('sendBeacon is disabled in sandbox'); };
      }
      const v = Reflect.get(target, prop);
      return typeof v === 'function' ? v.bind(target) : v;
    },
    has(target, prop) {
      if (prop === 'sendBeacon') return true;
      return Reflect.has(target, prop);
    },
    getOwnPropertyDescriptor(target, prop) {
      if (prop === 'sendBeacon') {
        return { configurable: false, enumerable: true, value: undefined };
      }
      return Reflect.getOwnPropertyDescriptor(target, prop);
    },
    set(_, prop) {
      if (prop === 'sendBeacon') {
        throw new Error('sendBeacon is disabled in sandbox');
      }
      throw new Error(`navigator is read-only in sandbox (attempted set: ${String(prop)})`);
    },
    defineProperty(_, prop) {
      throw new Error(`navigator is frozen in sandbox (attempted defineProperty: ${String(prop)})`);
    },
    deleteProperty(_, prop) {
      throw new Error(`navigator is frozen in sandbox (attempted delete: ${String(prop)})`);
    },
  }),
  writable: false,
  configurable: false,
});

/** Round 6/7 hardening: 在 Navigator.prototype 上直接替换 sendBeacon
 * 防止攻击者通过 Object.getPrototypeOf(navigator) 绕过 Proxy get trap
 * —— Proxy.getPrototypeOf trap 缺失时返回真实 Navigator.prototype，
 * 此处直接 patch 原型，所有 navigator 实例（包括绕过路径）的 sendBeacon 都抛错
 * Round 7: 加 try-catch + 读取原描述符保证 enumerable 兼容（某些环境可能不可配置）
 */
try {
  const originalDesc = Object.getOwnPropertyDescriptor(Navigator.prototype, 'sendBeacon');
  if (originalDesc?.configurable !== false) {
    Object.defineProperty(Navigator.prototype, 'sendBeacon', {
      value: () => { throw new Error('sendBeacon is disabled in sandbox (Navigator.prototype)'); },
      writable: false,
      configurable: false,
      enumerable: originalDesc?.enumerable ?? true,
    });
  }
} catch {
  // 失败时已有 Proxy set/defineProperty/deleteProperty trap 兜底（P1-2）
}

/** 原型链冻结防 prototype pollution；不冻结 globalThis（保留合法书源 var 声明） */
Object.freeze(Object.prototype);
Object.freeze(Array.prototype);
Object.freeze(Function.prototype);

// ── 协议类型 ──────────────────────────────────────────────────────────────

interface HttpProxyRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | null;
}

interface HttpProxyResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

type WorkerInbound =
  | { type: 'load'; fileName: string; source: string }
  | { type: 'call'; reqId: string; fileName: string; fn: string; args: unknown[] }
  | { type: 'invalidate'; fileName: string }
  | {
      type: 'http-result';
      reqId: string;
      status: number;
      headers: Record<string, string>;
      body: string;
    };

type WorkerOutbound =
  | { type: 'loaded'; fileName: string; fns: string[] }
  | { type: 'http'; reqId: string; request: HttpProxyRequest }
  | { type: 'result'; reqId: string; ok: boolean; value?: unknown; error?: string };

// ── 模块缓存（spec §3.2 — fileName → 命名函数表） ─────────────────────────

interface Module {
  search?: (...args: unknown[]) => unknown;
  bookInfo?: (...args: unknown[]) => unknown;
  toc?: (...args: unknown[]) => unknown;
  chapterList?: (...args: unknown[]) => unknown;
  content?: (...args: unknown[]) => unknown;
  chapterContent?: (...args: unknown[]) => unknown;
  explore?: (...args: unknown[]) => unknown;
}

const modules = new Map<string, Module>();

/**
 * 模块工厂：new Function('legado', source + return 导出表)
 * —— IIFE 隔离全局；导出表覆盖书源约定的全部函数名（legado 同款）
 */
function compileModule(source: string): Module {
  const factory = new Function(
    'legado',
    `${source}\n;return {\n  search: typeof search === "function" ? search : undefined,\n  bookInfo: typeof bookInfo === "function" ? bookInfo : undefined,\n  toc: typeof toc === "function" ? toc : undefined,\n  chapterList: typeof chapterList === "function" ? chapterList : undefined,\n  content: typeof content === "function" ? content : undefined,\n  chapterContent: typeof chapterContent === "function" ? chapterContent : undefined,\n  explore: typeof explore === "function" ? explore : undefined\n};`,
  );
  return factory(buildShim());
}

/** legado shim：legado.http.{get,post,request} 走 postMessage 回主线程 */
function buildShim(): { http: Record<string, (req: unknown) => Promise<unknown>> } {
  return {
    http: {
      get: (url: string, headers?: Record<string, string>) =>
        requestHttp({ url, method: 'GET', headers: headers ?? {} }).then((r) => r.body),
      post: (url: string, body?: string, headers?: Record<string, string>) =>
        requestHttp({
          url,
          method: 'POST',
          body: body ?? null,
          headers: headers ?? {},
        }).then((r) => r.body),
      request: (request: HttpProxyRequest) => requestHttp(request),
    },
  };
}

const pendingHttp = new Map<
  string,
  { resolve: (v: HttpProxyResponse) => void; reject: (e: Error) => void }
>();

function requestHttp(request: HttpProxyRequest): Promise<HttpProxyResponse> {
  return new Promise((resolve, reject) => {
    const reqId = `http-${Math.random().toString(36).slice(2)}-${Date.now()}`;
    pendingHttp.set(reqId, { resolve, reject });
    reply({ type: 'http', reqId, request });
  });
}

function reply(msg: WorkerOutbound): void {
  (self as DedicatedWorkerGlobalScope).postMessage(msg);
}

// ── 消息处理 ──────────────────────────────────────────────────────────────

self.addEventListener('message', (e: MessageEvent<WorkerInbound>) => {
  const msg = e.data;
  try {
    if (msg.type === 'load') {
      const mod = compileModule(msg.source);
      modules.set(msg.fileName, mod);
      const fns = Object.entries(mod)
        .filter(([, v]) => typeof v === 'function')
        .map(([k]) => k);
      reply({ type: 'loaded', fileName: msg.fileName, fns });
      return;
    }
    if (msg.type === 'call') {
      const mod = modules.get(msg.fileName);
      if (!mod) {
        reply({ type: 'result', reqId: msg.reqId, ok: false, error: '模块未加载' });
        return;
      }
      const fn = (mod as unknown as Record<string, (...args: unknown[]) => unknown>)[msg.fn];
      if (typeof fn !== 'function') {
        reply({ type: 'result', reqId: msg.reqId, ok: false, error: `函数 ${msg.fn} 未定义` });
        return;
      }
      Promise.resolve()
        .then(() => fn.apply(mod, msg.args))
        .then(
          (value) =>
            reply({
              type: 'result',
              reqId: msg.reqId,
              ok: true,
              value: value === undefined ? null : value,
            }),
          (err: unknown) =>
            reply({
              type: 'result',
              reqId: msg.reqId,
              ok: false,
              errorName: (err as { name?: string })?.name ?? 'Error',
              error: String((err as { stack?: string; message?: string })?.stack
                ?? (err as { message?: string })?.message
                ?? err),
            }),
        );
      return;
    }
    if (msg.type === 'invalidate') {
      modules.delete(msg.fileName);
      return;
    }
    if (msg.type === 'http-result') {
      const p = pendingHttp.get(msg.reqId);
      if (!p) return;
      pendingHttp.delete(msg.reqId);
      if (msg.status >= 200 && msg.status < 300) {
        p.resolve({ status: msg.status, headers: msg.headers, body: msg.body });
      } else {
        p.reject(new Error(`HTTP ${msg.status}`));
      }
      return;
    }
  } catch (err) {
    const reqId = (msg as { reqId?: string }).reqId;
    if (reqId) {
      reply({
        type: 'result',
        reqId,
        ok: false,
        errorName: (err as { name?: string })?.name ?? 'Error',
        error: String((err as { stack?: string; message?: string })?.stack
          ?? (err as { message?: string })?.message
          ?? err),
      });
    }
  }
});
