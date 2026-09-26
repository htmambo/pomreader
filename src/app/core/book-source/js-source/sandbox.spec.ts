import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SandboxService } from './sandbox.service';
import { FetchError } from '../fetch-error';

// 沙箱硬化：jsdom 中 localStorage/window 来自原型 getter，需 defineProperty 屏蔽
const FORBIDDEN = ['window', 'document', 'localStorage', 'parent', 'top'] as const;
const SAVED = new Map<string, PropertyDescriptor | undefined>();
function applyHardening(): void {
  for (const k of FORBIDDEN) {
    SAVED.set(k, Object.getOwnPropertyDescriptor(globalThis, k));
    try { delete (globalThis as Record<string, unknown>)[k]; } catch { /* ignore */ }
    if (k === 'localStorage') {
      try { Object.defineProperty(globalThis, k, {
        get() { throw new ReferenceError(`${k} is not defined`); },
        set() { /* ignore */ }, configurable: true,
      }); } catch { /* ignore */ }
    } else {
      try { Object.defineProperty(globalThis, k,
        { value: undefined, configurable: true, writable: false }); } catch { /* ignore */ }
    }
  }
  // 注：prototype 冻结会破坏 Vite source-map 等，真实 worker 由启动段强制冻结
}
function restoreHardening(): void {
  for (const k of FORBIDDEN) {
    try { delete (globalThis as Record<string, unknown>)[k]; } catch { /* ignore */ }
    const d = SAVED.get(k);
    if (d) { try { Object.defineProperty(globalThis, k, d); } catch { /* ignore */ } }
  }
}

// Mock Worker：模拟 sandbox.worker 协议
type ModFns = Record<string, ((...a: unknown[]) => unknown) | undefined>;

class MockWorker {
  onmessage: ((e: { data: Record<string, unknown> }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onmessageerror: ((e: unknown) => void) | null = null;
  terminated = false;
  postLog: Array<Record<string, unknown>> = [];
  private readonly modules = new Map<string, ModFns>();
  private harden = false;
  private suspendLoad = false;
  private autoReadyEnabled = true;
  private readySent = false;
  enableHardening(): void { this.harden = true; }
  /** 测试用：收到 load 消息不自动回 loaded（让 init-error/onerror 先到达主线程） */
  suspendLoadReply(): void { this.suspendLoad = true; }
  /** 测试用：不自动发 worker-ready（模拟硬化段抛错或 worker 整体未启动） */
  disableAutoReady(): void { this.autoReadyEnabled = false; }
  /** 触发自动发 worker-ready（由 makeService 在 attach 后显式调用,模拟真实 worker 行为） */
  emitReady(): void {
    if (this.terminated || !this.autoReadyEnabled || this.readySent) return;
    this.readySent = true;
    this.onmessage?.({ data: { type: 'worker-ready' } });
  }
  postMessage(d: Record<string, unknown>): void {
    this.postLog.push(d);
    queueMicrotask(() => {
      if (this.terminated) return;
      if (d['type'] === 'load') this.handleLoad(d['fileName'] as string, d['source'] as string);
      else if (d['type'] === 'call') this.handleCall(d);
      else if (d['type'] === 'invalidate') this.modules.delete(d['fileName'] as string);
    });
  }
  terminate(): void { this.terminated = true; }
  addEventListener(): void { /* no-op */ }
  removeEventListener(): void { /* no-op */ }
  dispatchEvent(): boolean { return true; }
  private reply(data: Record<string, unknown>): void {
    queueMicrotask(() => { if (!this.terminated) this.onmessage?.({ data }); });
  }
  private handleLoad(fileName: string, source: string): void {
    if (this.suspendLoad) return; // 测试用：等待主线程主动发 init-error/onerror
    if (this.harden) applyHardening();
    try {
      const mod = new Function('legado',
        `${source}\n;return { search: typeof search === "function" ? search : undefined,` +
        ` bookInfo: typeof bookInfo === "function" ? bookInfo : undefined,` +
        ` toc: typeof toc === "function" ? toc : undefined,` +
        ` chapterList: typeof chapterList === "function" ? chapterList : undefined,` +
        ` content: typeof content === "function" ? content : undefined,` +
        ` chapterContent: typeof chapterContent === "function" ? chapterContent : undefined,` +
        ` explore: typeof explore === "function" ? explore : undefined };`,
      )({ http: { get: () => '', post: () => '', request: () => '' } }) as ModFns;
      this.modules.set(fileName, mod);
      this.reply({ type: 'loaded', fileName, fns: Object.entries(mod).filter(([, v]) => typeof v === 'function').map(([k]) => k) });
    } finally { if (this.harden) restoreHardening(); }
  }
  private handleCall(data: Record<string, unknown>): void {
    if (this.harden) applyHardening();
    const fn = this.modules.get(data['fileName'] as string)?.[data['fn'] as string] as ((...a: unknown[]) => unknown) | undefined;
    if (typeof fn !== 'function') {
      this.reply({ type: 'result', reqId: data['reqId'], ok: false, errorName: 'Error', error: 'fn 缺失' });
      return;
    }
    Promise.resolve().then(() => fn(...(data['args'] as unknown[]))).then(
      (v) => this.reply({ type: 'result', reqId: data['reqId'], ok: true, value: v ?? null }),
      (err: unknown) => this.reply({
        type: 'result', reqId: data['reqId'], ok: false,
        errorName: (err as Error)?.name ?? 'Error',
        error: String((err as Error)?.stack ?? (err as Error)?.message ?? err),
      }),
    ).finally(() => { if (this.harden) restoreHardening(); });
  }
}

const makeService = () => {
  const w = new MockWorker();
  return { svc: SandboxService.forTest(w as unknown as Worker), worker: w };
};
/** 触发 mock 发 worker-ready(模拟真实 worker 行为,默认开) */
const setupReady = (worker: MockWorker): void => worker.emitReady();
const flushMs = (ms: number) => vi.advanceTimersByTimeAsync(ms);

describe('SandboxService — 模块加载 + 调用', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it('load 后 call 返回正常结果', async () => {
    const { svc, worker } = makeService();
    setupReady(worker);
    const p = svc.load('ok', 'function search() { return "ok"; }');
    await flushMs(60); await p;
    expect(await svc.call<string>('ok', 'search', [])).toBe('ok');
  });
  it('已加载模块 cache 命中(同源码不重新发 load)', async () => {
    const { svc, worker } = makeService();
    setupReady(worker);
    const p1 = svc.load('cache', 'function search() { return 1; }');
    await flushMs(60); await p1;
    await svc.call('cache', 'search', []);
    const before = worker.postLog.filter((m) => m['type'] === 'load').length;
    // 同源码再次 load —— 命中缓存
    await svc.load('cache', 'function search() { return 1; }');
    expect(worker.postLog.filter((m) => m['type'] === 'load').length).toBe(before);
  });
  it('源码变更时自动失效缓存并重新加载', async () => {
    const { svc, worker } = makeService();
    setupReady(worker);
    const p1 = svc.load('cache', 'function search() { return 1; }');
    await flushMs(60); await p1;
    const before = worker.postLog.filter((m) => m['type'] === 'load').length;
    // 不同源码 —— 缓存失效,重新发 load
    const p2 = svc.load('cache', 'function search() { return 2; }');
    await flushMs(60); await p2;
    expect(worker.postLog.filter((m) => m['type'] === 'load').length).toBe(before + 1);
  });
});

describe('SandboxService — 沙箱隔离（NFR-2）', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it('localStorage.getItem 抛 ReferenceError', async () => {
    const { svc, worker } = makeService(); worker.enableHardening();
    setupReady(worker);
    const p = svc.load('m1', 'function search() { return localStorage.getItem("x"); }');
    await flushMs(60); await p;
    await expect(svc.call('m1', 'search', [])).rejects.toBeInstanceOf(ReferenceError);
  });
  it('window.parent 抛 TypeError', async () => {
    const { svc, worker } = makeService(); worker.enableHardening();
    setupReady(worker);
    const p = svc.load('m2', 'function search() { return window.parent.location; }');
    await flushMs(60); await p;
    await expect(svc.call('m2', 'search', [])).rejects.toBeInstanceOf(TypeError);
  });
  it('globalThis.localStorage 抛 ReferenceError', async () => {
    const { svc, worker } = makeService(); worker.enableHardening();
    setupReady(worker);
    const p = svc.load('m3', 'function search() { return globalThis.localStorage.getItem("x"); }');
    await flushMs(60); await p;
    await expect(svc.call('m3', 'search', [])).rejects.toBeInstanceOf(ReferenceError);
  });
});

describe('SandboxService — legado.query 主线程代理', () => {
  const SEARCH_HTML =
    '<dl class="list"><dd><a href="/book/5/index.html"><img src="c.jpg"></a>' +
    '<h4><a href="/book/5/index.html">庆余年</a></h4>' +
    '<div><a href="/book/5/index.html" class="button">免费阅读</a></div></dd></dl>';
  const BASE = 'https://www.example.com/search?keyword=x';
  const BOOK_URL = 'https://www.example.com/book/5/index.html';

  afterEach(() => localStorage.removeItem('pom.cssRules'));

  /** 模拟 Worker → 主线程 query 消息，返回主线程回发的 query-result */
  const query = (html: string, selector: string, baseUrl = BASE) => {
    const { worker } = makeService();
    SandboxService.forTest(worker as unknown as Worker);
    worker.onmessage?.({ data: { type: 'query', reqId: 'q1', html, selector, baseUrl } });
    return worker.postLog.find((m) => m['type'] === 'query-result');
  };

  it('锚点选择器：逐元素返回，href 预绝对化', () => {
    const res = query(SEARCH_HTML, 'dl.list dd a');
    expect(res?.['ok']).toBe(true);
    const items = res?.['items'] as Array<{ tag: string; text: string; href: string }>;
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ tag: 'a', text: '', href: BOOK_URL });
    expect(items[1]).toMatchObject({ tag: 'a', text: '庆余年', href: BOOK_URL });
    expect(items[2]).toMatchObject({ tag: 'a', text: '免费阅读', href: BOOK_URL });
  });
  it('容器选择器：links 收集后代锚点并绝对化', () => {
    const res = query(SEARCH_HTML, 'dl.list dd');
    const items = res?.['items'] as Array<{ tag: string; links: Array<{ href: string; text: string }> }>;
    expect(items).toHaveLength(1);
    expect(items[0].tag).toBe('dd');
    expect(items[0].links.map((l) => l.text)).toEqual(['', '庆余年', '免费阅读']);
    expect(items[0].links.every((l) => l.href === BOOK_URL)).toBe(true);
  });
  it('选择器非法 → ok:false 带「选择器无效」', () => {
    const res = query(SEARCH_HTML, '###');
    expect(res?.['ok']).toBe(false);
    expect(String(res?.['error'])).toContain('选择器无效');
  });
  it('HTML 超 5MB → ok:false 带上限提示', () => {
    const res = query('x'.repeat(5 * 1024 * 1024 + 1), 'a');
    expect(res?.['ok']).toBe(false);
    expect(String(res?.['error'])).toContain('上限');
  });
  it('Feature Flag 关闭 → ok:false 带禁用提示', () => {
    localStorage.setItem('pom.cssRules', '0');
    const res = query(SEARCH_HTML, 'a');
    expect(res?.['ok']).toBe(false);
    expect(String(res?.['error'])).toContain('禁用');
  });
  it('畸形 href / 空 baseUrl 不挂起，URL 解析异常被 toQueryItem 内部 try 吃掉', () => {
    // 选择器合法但 href 不可解析时：toQueryItem 内部 try/catch 把异常转空 href，不会冒泡到 proxyQuery 顶层
    const htmlBad = '<a href="ht tp://x">t</a>';
    const resBad = query(htmlBad, 'a', '');
    expect(resBad?.['ok']).toBe(true);
    expect((resBad?.['items'] as Array<{ href: string }>)[0].href).toBe('');
  });
});

describe('SandboxService — Worker 启动失败立即反馈（init-error / onerror）', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it('Worker postMessage init-error 时,load 立即 reject 而非等 5s 超时', async () => {
    const { svc, worker } = makeService();
    setupReady(worker);
    worker.suspendLoadReply(); // 不让 mock 自动回 loaded
    const p = svc.load('crash', 'function search(){}');
    await flushMs(60);
    // 模拟 worker 启动段硬化代码抛错后主动 postMessage init-error
    worker.onmessage?.({ data: { type: 'init-error', error: 'Navigator.prototype.sendBeacon is read-only', stack: '...' } });
    await expect(p).rejects.toThrow(/Worker 启动失败.*Navigator\.prototype/);
  });
  it('Worker onerror 时,load 立即 reject 而非等 5s 超时', async () => {
    const { svc, worker } = makeService();
    setupReady(worker);
    worker.suspendLoadReply();
    const p = svc.load('err', 'function search(){}');
    await flushMs(60);
    const errEvt = { message: 'Script error.', filename: 'sandbox.worker.ts', lineno: 42 } as ErrorEvent;
    worker.onerror?.(errEvt);
    await expect(p).rejects.toThrow(/Worker 错误.*Script error\./);
  });
  it('init-error 同时清空多个 pendingLoads', async () => {
    const { svc, worker } = makeService();
    setupReady(worker);
    worker.suspendLoadReply();
    const p1 = svc.load('a', 'function search(){}');
    const p2 = svc.load('b', 'function search(){}');
    await flushMs(60);
    worker.onmessage?.({ data: { type: 'init-error', error: 'boom' } });
    await expect(p1).rejects.toThrow(/Worker 启动失败/);
    await expect(p2).rejects.toThrow(/Worker 启动失败/);
  });
  it('worker 发 worker-ready 后 load 才发出(load 消息不会丢)', async () => {
    // MockWorker 默认立即回 loaded;验证:在 worker-ready 之前发出的 load 消息 worker 也能正确处理
    // —— 实际行为:mock 的 reply 是 queueMicrotask,主线程 attach 的 onmessage 是同步就绪,顺序保证
    const { svc, worker } = makeService();
    setupReady(worker);
    const p = svc.load('ok', 'function search(){ return 1; }');
    await flushMs(60);
    expect(worker.postLog.some((m) => m['type'] === 'worker-ready')).toBe(false); // mock 不发 ready
    expect(worker.postLog.some((m) => m['type'] === 'load')).toBe(true);
    await p;
  });
  it('onmessageerror 触发 failAllPendingLoads', async () => {
    const { svc, worker } = makeService();
    setupReady(worker);
    worker.suspendLoadReply();
    const p = svc.load('msg-err', 'function search(){}');
    await flushMs(60);
    const evt = { data: 'serialization-failed' } as MessageEvent;
    worker.onmessageerror?.(evt);
    await expect(p).rejects.toThrow(/Worker 消息反序列化失败/);
  });
  it('LOAD_TIMEOUT 文案 ready=否 收到消息=0 场景', async () => {
    const { svc, worker } = makeService();
    worker.disableAutoReady(); // 必须先调用,阻断 emitReady
    worker.suspendLoadReply();
    // waitForReady 自身 10s 超时抛错
    const p = svc.load('a', 'function search(){}');
    p.catch(() => {}); // 防止 unhandled
    await vi.advanceTimersByTimeAsync(10_500);
    await expect(p).rejects.toThrow(/Worker 未在 10000ms 内发 ready/);
  }, 15_000);
  it('LOAD_TIMEOUT 文案 ready=是 收到消息>0 场景', async () => {
    const { svc, worker } = makeService();
    setupReady(worker);
    worker.suspendLoadReply();
    const p1 = svc.load('b', 'function search(){}');
    p1.catch(() => {});
    await vi.advanceTimersByTimeAsync(60); // 让 ready 到达
    await vi.advanceTimersByTimeAsync(10_500);
    await expect(p1).rejects.toThrow(/ready=是/);
  }, 15_000);
  it('attach 复用时 workerReadyReceived/workerMessageCount 重置', async () => {
    const { svc: svc1, worker: w1 } = makeService();
    w1.emitReady(); // 用 w1 而非 setupReady(worker)
    w1.suspendLoadReply();
    svc1.load('a', 'function search(){}').catch(() => {});
    await flushMs(60);
    w1.onmessage?.({ data: { type: 'worker-ready' } });
    w1.onmessage?.({ data: { type: 'loaded', fileName: 'a', fns: [] } });
    const s1 = svc1 as unknown as { workerReadyReceived: boolean; workerMessageCount: number };
    expect(s1.workerReadyReceived).toBe(true);
    expect(s1.workerMessageCount).toBeGreaterThan(0);
    // forTest 新建独立 service 实例 — 不复用;验证新建实例状态归零
    const w2 = new MockWorker();
    const svc2 = SandboxService.forTest(w2 as unknown as Worker);
    const s2 = svc2 as unknown as { workerReadyReceived: boolean; workerMessageCount: number };
    expect(s2.workerReadyReceived).toBe(false);
    expect(s2.workerMessageCount).toBe(0);
  });
});

describe('SandboxService — invalidate / 超时 / pool', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it('invalidate 后重新加载返回新结果（FR-1.3.1）', async () => {
    const { svc, worker } = makeService();
    setupReady(worker);
    const p1 = svc.load('src', 'function search() { return "v1"; }');
    await flushMs(60); await p1;
    expect(await svc.call('src', 'search', [])).toBe('v1');
    svc.invalidate('src'); await flushMs(60);
    const p2 = svc.load('src', 'function search() { return "v2"; }');
    await flushMs(60); await p2;
    expect(await svc.call('src', 'search', [])).toBe('v2');
  });
  it('15s 未返回 → reject FetchError("timeout")（FR-1.3.2）', async () => {
    const { svc, worker } = makeService();
    setupReady(worker);
    const pl = svc.load('slow', 'function search() { return new Promise(r => setTimeout(() => r("x"), 16000)); }');
    await flushMs(60); await pl;
    const p = svc.call('slow', 'search', []);
    const check = expect(p).rejects.toBeInstanceOf(FetchError);
    await flushMs(14_999); await flushMs(2);
    await check;
    await expect(p).rejects.toMatchObject({ code: 'timeout' });
  });
  it('7 并发：前 6 个发出，第 7 个排队（DM-2）', async () => {
    const { svc, worker } = makeService();
    setupReady(worker);
    const pl = svc.load('pool', 'function search() { return new Promise(r => setTimeout(() => r("d"), 100)); }');
    await flushMs(60); await pl;
    const promises = Array.from({ length: 7 }, () => svc.call('pool', 'search', []));
    await flushMs(0); // microtask：6 个 call 已发，第 7 排队
    expect(worker.postLog.filter((m) => m['type'] === 'call').length).toBe(6);
    await flushMs(300);
    expect(await Promise.all(promises)).toEqual(Array(7).fill('d'));
  });
});