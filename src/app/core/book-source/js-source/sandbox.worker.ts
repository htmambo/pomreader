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
// 任何同步异常必须 postMessage 回主线程,否则主线程只能等到 LOAD_TIMEOUT_MS
// 才看到"Worker 无回执",真实失败原因被掩盖(Round 8: 用户报 hetubook.js
// 加载超时,根因即此路径未被覆盖)
// Round 11: 分阶段 try-catch —— 任何阶段抛错都立刻 postMessage 回主线程,精确定位失败阶段
try {
  logToMain("info", '[sandbox.worker] ▶ 阶段 1/4: 删敏感全局(window/document/localStorage/parent/top)');
  delete (self as unknown as Record<string, unknown>)['window'];
  delete (self as unknown as Record<string, unknown>)['document'];
  delete (self as unknown as Record<string, unknown>)['localStorage'];
  delete (self as unknown as Record<string, unknown>)['parent'];
  delete (self as unknown as Record<string, unknown>)['top'];
  logToMain("info", '[sandbox.worker] ✓ 阶段 1/4 完成');
} catch (err) {
  replyInitError(err, '阶段 1/4 删敏感全局');
}
try {
  logToMain("info", '[sandbox.worker] ▶ 阶段 2/4: 屏蔽 10 个网络出口(fetch/XMLHttpRequest/WebSocket 等)');
  // 注意:navigator 不在此处屏蔽!阶段 3/4 要 Object.defineProperty(self, 'navigator', ...),
  //   二次 defineProperty 同一属性(configurable:false)会抛 TypeError,导致整个硬化段崩
  const NETWORK_API_BLOCKLIST = [
    'fetch', 'XMLHttpRequest', 'WebSocket', 'importScripts',
    'Worker', 'SharedWorker', 'EventSource', 'WebTransport',
    'RTCPeerConnection', 'RTCDataChannel',
  ];
  for (const name of NETWORK_API_BLOCKLIST) {
    Object.defineProperty(self, name, {
      get: () => { throw new Error(`${name} is disabled in sandbox; use legado.http instead`); },
      set: () => { throw new Error(`${name} is read-only and disabled in sandbox`); },
      enumerable: false,
      configurable: false,
    });
  }
  logToMain("info", '[sandbox.worker] ✓ 阶段 2/4 完成');
} catch (err) {
  replyInitError(err, '阶段 2/4 屏蔽网络出口');
}
try {
  logToMain("info", '[sandbox.worker] ▶ 阶段 3/4: navigator Proxy + sendBeacon 拦截');
  const originalNavigator = (self as unknown as { navigator?: object })['navigator'] ?? {};
  Object.defineProperty(self, 'navigator', {
    value: new Proxy(originalNavigator, {
      get(target, prop) {
        if (prop === 'sendBeacon') return () => { throw new Error('sendBeacon is disabled in sandbox'); };
        const v = Reflect.get(target, prop);
        return typeof v === 'function' ? v.bind(target) : v;
      },
      has(target, prop) {
        if (prop === 'sendBeacon') return true;
        return Reflect.has(target, prop);
      },
      getOwnPropertyDescriptor(target, prop) {
        if (prop === 'sendBeacon') return { configurable: false, enumerable: true, value: undefined };
        return Reflect.getOwnPropertyDescriptor(target, prop);
      },
      set(_, prop) {
        if (prop === 'sendBeacon') throw new Error('sendBeacon is disabled in sandbox');
        throw new Error(`navigator is read-only in sandbox (attempted set: ${String(prop)})`);
      },
      defineProperty(_, prop) { throw new Error(`navigator is frozen in sandbox (attempted defineProperty: ${String(prop)})`); },
      deleteProperty(_, prop) { throw new Error(`navigator is frozen in sandbox (attempted delete: ${String(prop)})`); },
    }),
    writable: false,
    configurable: false,
  });
  logToMain("info", '[sandbox.worker] ✓ 阶段 3/4 完成');
} catch (err) {
  replyInitError(err, '阶段 3/4 navigator Proxy');
}
try {
  logToMain("info", '[sandbox.worker] ▶ 阶段 4/4: 冻结 Object/Array/Function 原型链');
  Object.freeze(Object.prototype);
  Object.freeze(Array.prototype);
  Object.freeze(Function.prototype);
  logToMain("info", '[sandbox.worker] ✓ 阶段 4/4 完成');
} catch (err) {
  replyInitError(err, '阶段 4/4 冻结原型链');
}

// 以下保留原始 hardenWorker 函数定义(供其他代码引用,但启动段已分阶段执行)
function hardenWorker(): void {
  logToMain("info", '[sandbox.worker] (legacy) hardenWorker 已废弃,启动段已分阶段执行');

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
logToMain("info", `[sandbox.worker] ✓ 屏蔽 ${NETWORK_API_BLOCKLIST.length} 个网络出口`);

/** navigator.sendBeacon 通过 Proxy 防逃逸（Round 5 加固）
 * - `get`: sendBeacon 拦截抛错；其他属性返回 bind 后的方法（防 this 逃逸）
 * - `has`: sendBeacon 返回 true（保持接口完整性）
 * - `getOwnPropertyDescriptor`: sendBeacon 返回非 configurable 描述符
 * - Round 6 hardening: 增加 `set` / `defineProperty` / `deleteProperty` trap 全部抛错
 *   防止书源 `navigator.x = ...` 写穿透到真实 navigator 对象
 */
const originalNavigator = (self as unknown as { navigator?: object })['navigator'] ?? {};
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
logToMain("info", '[sandbox.worker] ✓ 冻结 Object/Array/Function 原型链');
}

/** 启动失败时主动 postMessage 回主线程,避免 LOAD_TIMEOUT_MS 才看到「无回执」 */
function replyInitError(err: unknown, phase = '未知阶段'): void {
  logToMain("error", `[sandbox.worker] ✗ ${phase}抛错:`, err);
  const e = err as { message?: string; stack?: string };
  try {
    (self as DedicatedWorkerGlobalScope).postMessage({
      type: 'init-error',
      error: `${phase}失败：${String(e?.message ?? err)}`,
      stack: String(e?.stack ?? ''),
    });
    logToMain("info", '[sandbox.worker] → init-error 消息已发出');
  } catch {
    // postMessage 自身失败(Worker 已死),主线程 onerror 兜底
    logToMain("error", '[sandbox.worker] ✗ init-error postMessage 失败(Worker 已死)');
  }
}

/** 启动失败时主动 postMessage 回主线程,避免 LOAD_TIMEOUT_MS 才看到「无回执」 */
// 第二个 replyInitError 已删(原 line 160 重复声明,后者覆盖前者,导致运行时异常)

// ── 协议类型 ──────────────────────────────────────────────────────────────

interface HttpProxyRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | null;
}

/** Worker 内部日志 → postMessage 给主线程,主线程统一调 this.log() 推到 progress signal
 *  Worker 不能直接调主线程 signal —— 必须走 postMessage 桥接
 *  双写 console 是为了 DevTools 直接可见(进度面板也可见)
 */
function logToMain(level: 'info' | 'warn' | 'error', ...args: unknown[]): void {
  const msg = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  try {
    (self as DedicatedWorkerGlobalScope).postMessage({ type: 'worker-log', level, msg });
  } catch { /* swallow:worker 已死,主线程读不到 */ }
  // 双写 console(DevTools 可见)
  try {
    if (level === 'error') console.error(...args);
    else if (level === 'warn') console.warn(...args);
    else console.info(...args);
  } catch { /* swallow */ }
}

interface HttpProxyResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** 启动成功信号：所有硬化代码执行完成、message listener 已注册,主动 postMessage 通知主线程
 *  主线程收到 ready 后才认为 Worker 健康;若 load() 进入超时但没收到过 ready,
 *  说明硬化代码抛错(init-error 因 postMessage 失败未送达)或 Worker 整体崩溃
 */
function signalReady(): void {
  try {
    (self as DedicatedWorkerGlobalScope).postMessage({ type: 'worker-ready' });
    logToMain("info", '[sandbox.worker] ✓ 启动完成,worker-ready 已发出');
  } catch {
    logToMain("error", '[sandbox.worker] ✗ worker-ready postMessage 失败');
  }
}

/** legado.query 契约（与 sandbox.service.ts 同源声明保持一致 —— Worker 无 import 策略） */
interface QueryLink {
  href: string;
  text: string;
}
interface QueryItem {
  tag: string;
  text: string;
  html: string;
  href: string;
  links: QueryLink[];
  /** 元素属性集合（key 已 lowercase）。img@src/a@href 也包含在内 —— 封面/链接属性提取用 */
  attrs?: Record<string, string>;
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
    }
  | { type: 'query-result'; reqId: string; ok: boolean; items?: QueryItem[]; error?: string };

/** 启动异常消息（启动段 try-catch 主动 postMessage 回主线程,避免 LOAD_TIMEOUT_MS 才看到原因） */
interface InitErrorMessage {
  type: 'init-error';
  error: string;
  stack?: string;
}

type WorkerOutbound =
  | { type: 'loaded'; fileName: string; fns: string[]; error?: string }
  | { type: 'http'; reqId: string; request: HttpProxyRequest }
  | { type: 'query'; reqId: string; html: string; selector: string; baseUrl: string }
  | { type: 'worker-log'; level: 'info' | 'warn' | 'error'; msg: string }
  | { type: 'result'; reqId: string; ok: boolean; value?: unknown; error?: string; errorName?: string };

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
function buildShim(): {
  http: Record<string, (req: unknown) => Promise<unknown>>;
  query: (html: string, selector: string, baseUrl: string) => Promise<QueryItem[]>;
} {
  return {
    http: {
      get: ((url: string, headers?: Record<string, string>) =>
        requestHttp({ url, method: 'GET', headers: headers ?? {} }).then((r) => r.body)) as unknown as (req: unknown) => Promise<unknown>,
      post: ((url: string, body?: string, headers?: Record<string, string>) =>
        requestHttp({
          url,
          method: 'POST',
          body: body ?? null,
          headers: headers ?? {},
        }).then((r) => r.body)) as unknown as (req: unknown) => Promise<unknown>,
      request: ((request: HttpProxyRequest) => requestHttp(request)) as unknown as (req: unknown) => Promise<unknown>,
    },
    /** CSS 选择器查询（主线程 DOMParser 执行；选择器非法/超限/被禁用时 reject） */
    query: ((html: string, selector: string, baseUrl: string) =>
      requestQuery(html, selector, baseUrl)) as unknown as (html: string, selector: string, baseUrl: string) => Promise<QueryItem[]>,
  };
}

const pendingHttp = new Map<
  string,
  { resolve: (v: HttpProxyResponse) => void; reject: (e: Error) => void }
>();

const pendingQueries = new Map<
  string,
  { resolve: (v: QueryItem[]) => void; reject: (e: Error) => void }
>();

function requestHttp(request: HttpProxyRequest): Promise<HttpProxyResponse> {
  return new Promise((resolve, reject) => {
    const reqId = `http-${Math.random().toString(36).slice(2)}-${Date.now()}`;
    pendingHttp.set(reqId, { resolve, reject });
    reply({ type: 'http', reqId, request });
  });
}

function requestQuery(html: string, selector: string, baseUrl: string): Promise<QueryItem[]> {
  return new Promise((resolve, reject) => {
    const reqId = `query-${Math.random().toString(36).slice(2)}-${Date.now()}`;
    pendingQueries.set(reqId, { resolve, reject });
    reply({ type: 'query', reqId, html, selector, baseUrl });
  });
}

function reply(msg: WorkerOutbound): void {
  (self as DedicatedWorkerGlobalScope).postMessage(msg);
}

// ── 消息处理 ──────────────────────────────────────────────────────────────

self.addEventListener('message', (e: MessageEvent<WorkerInbound>) => {
  // msg 提升到 try 外 —— catch 块需要引用 reqId 区分消息类型
  const msg = e.data as WorkerInbound | null;
  try {
    if (!msg || typeof msg.type !== 'string') {
      logToMain("error", '[sandbox.worker] ✗ 收到非预期消息:', msg);
      return;
    }
    if (msg.type === 'load') {
      logToMain("info", `[sandbox.worker] ▶ 收到 load 消息 fileName=${msg.fileName} sourceLen=${msg.source.length}`);
      // 编译失败必须显式回 error —— load 消息无 reqId，走外层 catch 会把错误吞掉，
      // 主线程只能收到空 fns，真实语法错误被掩盖成「书源未定义 search()」
      try {
        const mod = compileModule(msg.source);
        modules.set(msg.fileName, mod);
        const fns = Object.entries(mod)
          .filter(([, v]) => typeof v === 'function')
          .map(([k]) => k);
        reply({ type: 'loaded', fileName: msg.fileName, fns });
      } catch (err) {
        reply({
          type: 'loaded',
          fileName: msg.fileName,
          fns: [],
          error: String(
            (err as { message?: string })?.message ?? err,
          ),
        });
      }
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
    if (msg.type === 'query-result') {
      const p = pendingQueries.get(msg.reqId);
      if (!p) return;
      pendingQueries.delete(msg.reqId);
      if (msg.ok) {
        p.resolve(msg.items ?? []);
      } else {
        p.reject(new Error(msg.error ?? '选择器查询失败'));
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
// 启动成功信号: 必须在 listener 注册后才发,避免主线程收到 ready 后立即发 load 时 load 消息落在 worker 未注册 listener 上被丢(Round 9 P1-2)
signalReady();
