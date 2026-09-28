import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SandboxService } from './sandbox.service';
import { FetchError } from '../fetch-error';

// 沙箱硬化：jsdom 中 localStorage/window 来自原型 getter，需 defineProperty 屏蔽
const FORBIDDEN = ['window', 'document', 'localStorage', 'parent', 'top'] as const;
const SAVED = new Map<string, PropertyDescriptor | undefined>();
function applyHardening(): void {
  for (const k of FORBIDDEN) {
    SAVED.set(k, Object.getOwnPropertyDescriptor(globalThis, k));
    try {
      delete (globalThis as Record<string, unknown>)[k];
    } catch {
      /* ignore */
    }
    if (k === 'localStorage') {
      try {
        Object.defineProperty(globalThis, k, {
          get() {
            throw new ReferenceError(`${k} is not defined`);
          },
          set() {
            /* ignore */
          },
          configurable: true,
        });
      } catch {
        /* ignore */
      }
    } else {
      try {
        Object.defineProperty(globalThis, k, {
          value: undefined,
          configurable: true,
          writable: false,
        });
      } catch {
        /* ignore */
      }
    }
  }
  // 注：prototype 冻结会破坏 Vite source-map 等，真实 worker 由启动段强制冻结
}
function restoreHardening(): void {
  for (const k of FORBIDDEN) {
    try {
      delete (globalThis as Record<string, unknown>)[k];
    } catch {
      /* ignore */
    }
    const d = SAVED.get(k);
    if (d) {
      try {
        Object.defineProperty(globalThis, k, d);
      } catch {
        /* ignore */
      }
    }
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
  private suspendCall = false;
  private autoReadyEnabled = true;
  private readySent = false;
  enableHardening(): void {
    this.harden = true;
  }
  /** 测试用：收到 load 消息不自动回 loaded（让 init-error/onerror 先到达主线程） */
  suspendLoadReply(): void {
    this.suspendLoad = true;
  }
  /** 测试用：收到 call 消息不自动回 result（让主线程手动回消息验证 handleMessage 分支） */
  suspendCallReply(): void {
    this.suspendCall = true;
  }
  /** 测试用：不自动发 worker-ready（模拟硬化段抛错或 worker 整体未启动） */
  disableAutoReady(): void {
    this.autoReadyEnabled = false;
  }
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
  terminate(): void {
    this.terminated = true;
  }
  addEventListener(): void {
    /* no-op */
  }
  removeEventListener(): void {
    /* no-op */
  }
  dispatchEvent(): boolean {
    return true;
  }
  private reply(data: Record<string, unknown>): void {
    queueMicrotask(() => {
      if (!this.terminated) this.onmessage?.({ data });
    });
  }
  private handleLoad(fileName: string, source: string): void {
    if (this.suspendLoad) return; // 测试用：等待主线程主动发 init-error/onerror
    if (this.harden) applyHardening();
    try {
      const mod = new Function(
        'legado',
        `${source}\n;return { search: typeof search === "function" ? search : undefined,` +
          ` bookInfo: typeof bookInfo === "function" ? bookInfo : undefined,` +
          ` toc: typeof toc === "function" ? toc : undefined,` +
          ` chapterList: typeof chapterList === "function" ? chapterList : undefined,` +
          ` content: typeof content === "function" ? content : undefined,` +
          ` chapterContent: typeof chapterContent === "function" ? chapterContent : undefined,` +
          ` explore: typeof explore === "function" ? explore : undefined };`,
      )({ http: { get: () => '', post: () => '', request: () => '' } }) as ModFns;
      this.modules.set(fileName, mod);
      this.reply({
        type: 'loaded',
        fileName,
        fns: Object.entries(mod)
          .filter(([, v]) => typeof v === 'function')
          .map(([k]) => k),
      });
    } finally {
      if (this.harden) restoreHardening();
    }
  }
  private handleCall(data: Record<string, unknown>): void {
    if (this.suspendCall) return; // 测试用：等待主线程手动回 result
    if (this.harden) applyHardening();
    const fn = this.modules.get(data['fileName'] as string)?.[data['fn'] as string] as
      ((...a: unknown[]) => unknown) | undefined;
    if (typeof fn !== 'function') {
      this.reply({
        type: 'result',
        reqId: data['reqId'],
        ok: false,
        errorName: 'Error',
        error: 'fn 缺失',
      });
      return;
    }
    Promise.resolve()
      .then(() => fn(...(data['args'] as unknown[])))
      .then(
        (v) => this.reply({ type: 'result', reqId: data['reqId'], ok: true, value: v ?? null }),
        (err: unknown) =>
          this.reply({
            type: 'result',
            reqId: data['reqId'],
            ok: false,
            errorName: (err as Error)?.name ?? 'Error',
            error: String((err as Error)?.stack ?? (err as Error)?.message ?? err),
          }),
      )
      .finally(() => {
        if (this.harden) restoreHardening();
      });
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
    await flushMs(60);
    await p;
    expect(await svc.call<string>('ok', 'search', [])).toBe('ok');
  });
  it('已加载模块 cache 命中(同源码不重新发 load)', async () => {
    const { svc, worker } = makeService();
    setupReady(worker);
    const p1 = svc.load('cache', 'function search() { return 1; }');
    await flushMs(60);
    await p1;
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
    await flushMs(60);
    await p1;
    const before = worker.postLog.filter((m) => m['type'] === 'load').length;
    // 不同源码 —— 缓存失效,重新发 load
    const p2 = svc.load('cache', 'function search() { return 2; }');
    await flushMs(60);
    await p2;
    expect(worker.postLog.filter((m) => m['type'] === 'load').length).toBe(before + 1);
  });
});

describe('SandboxService — 沙箱隔离（NFR-2）', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it('localStorage.getItem 抛 ReferenceError', async () => {
    const { svc, worker } = makeService();
    worker.enableHardening();
    setupReady(worker);
    const p = svc.load('m1', 'function search() { return localStorage.getItem("x"); }');
    await flushMs(60);
    await p;
    await expect(svc.call('m1', 'search', [])).rejects.toBeInstanceOf(ReferenceError);
  });
  it('window.parent 抛 TypeError', async () => {
    const { svc, worker } = makeService();
    worker.enableHardening();
    setupReady(worker);
    const p = svc.load('m2', 'function search() { return window.parent.location; }');
    await flushMs(60);
    await p;
    await expect(svc.call('m2', 'search', [])).rejects.toBeInstanceOf(TypeError);
  });
  it('globalThis.localStorage 抛 ReferenceError', async () => {
    const { svc, worker } = makeService();
    worker.enableHardening();
    setupReady(worker);
    const p = svc.load('m3', 'function search() { return globalThis.localStorage.getItem("x"); }');
    await flushMs(60);
    await p;
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
    const items = res?.['items'] as Array<{
      tag: string;
      links: Array<{ href: string; text: string }>;
    }>;
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
    worker.onmessage?.({
      data: {
        type: 'init-error',
        error: 'Navigator.prototype.sendBeacon is read-only',
        stack: '...',
      },
    });
    await expect(p).rejects.toThrow(/Worker 启动失败.*Navigator\.prototype/);
  });
  it('Worker onerror 时,load 立即 reject 而非等 5s 超时', async () => {
    const { svc, worker } = makeService();
    setupReady(worker);
    worker.suspendLoadReply();
    const p = svc.load('err', 'function search(){}');
    await flushMs(60);
    const errEvt = {
      message: 'Script error.',
      filename: 'sandbox.worker.ts',
      lineno: 42,
    } as ErrorEvent;
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
    await flushMs(60);
    await p1;
    expect(await svc.call('src', 'search', [])).toBe('v1');
    svc.invalidate('src');
    await flushMs(60);
    const p2 = svc.load('src', 'function search() { return "v2"; }');
    await flushMs(60);
    await p2;
    expect(await svc.call('src', 'search', [])).toBe('v2');
  });
  it('15s 未返回 → reject FetchError("timeout")（FR-1.3.2）', async () => {
    const { svc, worker } = makeService();
    setupReady(worker);
    const pl = svc.load(
      'slow',
      'function search() { return new Promise(r => setTimeout(() => r("x"), 16000)); }',
    );
    await flushMs(60);
    await pl;
    const p = svc.call('slow', 'search', []);
    const check = expect(p).rejects.toBeInstanceOf(FetchError);
    await flushMs(14_999);
    await flushMs(2);
    await check;
    await expect(p).rejects.toMatchObject({ code: 'timeout' });
  });
  it('7 并发：前 6 个发出，第 7 个排队（DM-2）', async () => {
    const { svc, worker } = makeService();
    setupReady(worker);
    const pl = svc.load(
      'pool',
      'function search() { return new Promise(r => setTimeout(() => r("d"), 100)); }',
    );
    await flushMs(60);
    await pl;
    const promises = Array.from({ length: 7 }, () => svc.call('pool', 'search', []));
    await flushMs(0); // microtask：6 个 call 已发，第 7 排队
    expect(worker.postLog.filter((m) => m['type'] === 'call').length).toBe(6);
    await flushMs(300);
    expect(await Promise.all(promises)).toEqual(Array(7).fill('d'));
  });
});

describe('SandboxService — 进度日志（log / clearProgress / worker-log）', () => {
  it('worker-log 消息按级别推入 progress；无 msg 的消息被忽略', () => {
    const { svc, worker } = makeService();
    worker.onmessage?.({ data: { type: 'worker-log', msg: '硬化完成' } });
    worker.onmessage?.({ data: { type: 'worker-log', msg: '警告x', level: 'warn' } });
    worker.onmessage?.({ data: { type: 'worker-log', msg: '错误y', level: 'error' } });
    worker.onmessage?.({ data: { type: 'worker-log' } }); // 无 msg → 不推入
    const lines = svc.progress();
    expect(lines).toHaveLength(3);
    expect(lines.some((l) => l.includes('硬化完成'))).toBe(true);
    expect(lines.some((l) => l.includes('警告x'))).toBe(true);
    expect(lines.some((l) => l.includes('错误y'))).toBe(true);
  });
  it('toLocaleTimeString 抛错时日志降级为 [??:??:??] 前缀（不递归抛错）', () => {
    const spy = vi.spyOn(Date.prototype, 'toLocaleTimeString').mockImplementation(() => {
      throw new Error('no-locale');
    });
    try {
      const { svc, worker } = makeService();
      worker.onmessage?.({ data: { type: 'worker-log', msg: '降级日志' } });
      expect(svc.progress()[0]).toMatch(/^\[\?\?:\?\?:\?\?\] 降级日志/);
    } finally {
      spy.mockRestore();
    }
  });
  it('clearProgress 清空进度日志', () => {
    const { svc, worker } = makeService();
    worker.onmessage?.({ data: { type: 'worker-log', msg: 'x' } });
    expect(svc.progress()).toHaveLength(1);
    svc.clearProgress();
    expect(svc.progress()).toEqual([]);
  });
});

describe('SandboxService — handleMessage 边界分支', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  /** 取最后一条 call 消息的 reqId（suspendCallReply 模式下手动回 result 用） */
  const lastCallReqId = (worker: InstanceType<typeof MockWorker>): string => {
    const msg = [...worker.postLog].reverse().find((m) => m['type'] === 'call');
    return msg?.['reqId'] as string;
  };

  it('init-error 无 error 字段 → reject 「未知错误」', async () => {
    const { svc, worker } = makeService();
    setupReady(worker);
    worker.suspendLoadReply();
    const p = svc.load('x', 'function search(){}');
    await flushMs(60);
    worker.onmessage?.({ data: { type: 'init-error' } });
    await expect(p).rejects.toThrow(/Worker 启动失败：未知错误/);
  });
  it('init-error 在无 pendingLoads 时幂等（failAllPendingLoads 空守卫）', () => {
    const { svc, worker } = makeService();
    // init-error 会 reject workerReadyPromise —— 本用例无 load 等待它，手动挂 catch 防 unhandled
    (svc as unknown as { workerReadyPromise: Promise<void> }).workerReadyPromise.catch(() => {});
    expect(() => worker.onmessage?.({ data: { type: 'init-error', error: 'boom' } })).not.toThrow();
  });
  it('loaded 携带 error → load reject 「书源编译失败」（不缓存空模块）', async () => {
    const { svc, worker } = makeService();
    setupReady(worker);
    worker.suspendLoadReply();
    const p = svc.load('bad', 'function search(){');
    await flushMs(60);
    worker.onmessage?.({ data: { type: 'loaded', fileName: 'bad', error: 'Unexpected token' } });
    await expect(p).rejects.toThrow(/书源编译失败：Unexpected token/);
  });
  it('loaded 无 fns 字段 → 按空函数表缓存；缓存命中日志显示 (无)', async () => {
    const { svc, worker } = makeService();
    setupReady(worker);
    worker.suspendLoadReply();
    const p = svc.load('nofns', 'const x = 1;');
    await flushMs(60);
    worker.onmessage?.({ data: { type: 'loaded', fileName: 'nofns' } });
    expect((await p).fns).toEqual([]);
    const before = worker.postLog.filter((m) => m['type'] === 'load').length;
    const cached = await svc.load('nofns', 'const x = 1;');
    expect(cached.fns).toEqual([]);
    expect(worker.postLog.filter((m) => m['type'] === 'load').length).toBe(before);
    expect(svc.progress().some((l) => l.includes('(无)'))).toBe(true);
  });
  it('loaded 对应不到 pendingLoad → 静默忽略', () => {
    const { worker } = makeService();
    expect(() =>
      worker.onmessage?.({ data: { type: 'loaded', fileName: 'ghost', fns: [] } }),
    ).not.toThrow();
  });
  it('result reqId 未知 → 静默忽略', () => {
    const { worker } = makeService();
    expect(() =>
      worker.onmessage?.({ data: { type: 'result', reqId: 'ghost', ok: true, value: 1 } }),
    ).not.toThrow();
  });
  it('同一 reqId 重复 result：第二次被忽略（pool 不重复释放）', async () => {
    const { svc, worker } = makeService();
    setupReady(worker);
    worker.suspendCallReply();
    const p = svc.call<string>('m', 'search', []);
    await flushMs(0);
    const reqId = lastCallReqId(worker);
    worker.onmessage?.({ data: { type: 'result', reqId, ok: true, value: 'first' } });
    await expect(p).resolves.toBe('first');
    // 第二次同 reqId → entry 已删，提前 return，不再次 poolRelease
    worker.onmessage?.({ data: { type: 'result', reqId, ok: true, value: 'second' } });
    expect((svc as unknown as { poolActive: number }).poolActive).toBe(0);
  });
  it('result ok:false 无 errorName/error → 默认 Error + 「沙箱调用失败」', async () => {
    const { svc, worker } = makeService();
    setupReady(worker);
    worker.suspendCallReply();
    const p = svc.call('m', 'search', []);
    await flushMs(0);
    worker.onmessage?.({ data: { type: 'result', reqId: lastCallReqId(worker), ok: false } });
    await expect(p).rejects.toMatchObject({ name: 'Error', message: '沙箱调用失败' });
  });
  it('result ok:false errorName 非白名单 → 降级为 Error（防注入非 Error 构造器）', async () => {
    const { svc, worker } = makeService();
    setupReady(worker);
    worker.suspendCallReply();
    const p = svc.call('m', 'search', []);
    await flushMs(0);
    worker.onmessage?.({
      data: {
        type: 'result',
        reqId: lastCallReqId(worker),
        ok: false,
        errorName: 'EvalError',
        error: 'nope',
      },
    });
    const err = (await p.catch((e) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('Error');
    expect(err.message).toBe('nope');
  });
  it('result ok:false errorName=RangeError → 重建 RangeError 实例', async () => {
    const { svc, worker } = makeService();
    setupReady(worker);
    worker.suspendCallReply();
    const p = svc.call('m', 'search', []);
    await flushMs(0);
    worker.onmessage?.({
      data: {
        type: 'result',
        reqId: lastCallReqId(worker),
        ok: false,
        errorName: 'RangeError',
        error: '超出范围',
      },
    });
    await expect(p).rejects.toBeInstanceOf(RangeError);
  });
  it('result ok:true 无 value → resolve undefined（日志记 0 字节）', async () => {
    const { svc, worker } = makeService();
    setupReady(worker);
    worker.suspendCallReply();
    const p = svc.call('m', 'search', []);
    await flushMs(0);
    worker.onmessage?.({ data: { type: 'result', reqId: lastCallReqId(worker), ok: true } });
    await expect(p).resolves.toBeUndefined();
    expect(svc.progress().some((l) => l.includes('返回 (0 字节)'))).toBe(true);
  });
  it('call 参数日志：长字符串截断 + 非字符串 JSON 序列化', async () => {
    const { svc, worker } = makeService();
    setupReady(worker);
    const pl = svc.load(
      'args',
      'function search(a, b) { return String(a).length + JSON.stringify(b).length; }',
    );
    await flushMs(60);
    await pl;
    const r = await svc.call<number>('args', 'search', ['x'.repeat(100), { k: 1 }]);
    expect(r).toBe(100 + 7);
    expect(svc.progress().some((l) => l.includes('...') && l.includes('{"k":1}'))).toBe(true);
  });
});

describe('SandboxService — onerror / onmessageerror 变体', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it('onerror 携带完整 error 对象 → reject 含真实 message + filename:lineno', async () => {
    const { svc, worker } = makeService();
    setupReady(worker);
    worker.suspendLoadReply();
    const p = svc.load('e1', 'function search(){}');
    await flushMs(60);
    const ev = {
      error: new TypeError('cannot redefine'),
      message: 'uncaught',
      filename: 'sandbox.worker.js',
      lineno: 7,
      colno: 3,
    } as unknown as ErrorEvent;
    worker.onerror?.(ev);
    await expect(p).rejects.toThrow(/Worker 错误：cannot redefine（sandbox\.worker\.js:7）/);
  });
  it('onerror 无 error 对象且无 message → reject 「未知」', async () => {
    const { svc, worker } = makeService();
    setupReady(worker);
    worker.suspendLoadReply();
    const p = svc.load('e2', 'function search(){}');
    await flushMs(60);
    worker.onerror?.({} as ErrorEvent);
    await expect(p).rejects.toThrow(/Worker 错误：未知/);
  });
  it('onerror 的 error.stack getter 抛错 → 兜底链仍 reject pendingLoads', async () => {
    const { svc, worker } = makeService();
    setupReady(worker);
    worker.suspendLoadReply();
    const p = svc.load('e3', 'function search(){}');
    await flushMs(60);
    const evil = {
      name: 'Error',
      message: 'x',
      get stack(): string {
        throw new Error('stack-boom');
      },
    };
    worker.onerror?.({ error: evil, message: 'm' } as unknown as ErrorEvent);
    await expect(p).rejects.toThrow(/Worker 错误：未知/);
  });
  it('onmessageerror 无 data → reason 记 unknown', async () => {
    const { svc, worker } = makeService();
    setupReady(worker);
    worker.suspendLoadReply();
    const p = svc.load('e4', 'function search(){}');
    await flushMs(60);
    worker.onmessageerror?.({} as MessageEvent);
    await expect(p).rejects.toThrow(/Worker 消息反序列化失败：unknown/);
  });
});

describe('SandboxService — ensureWorker / invalidate / storage 边界', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    localStorage.removeItem('evo3.v1.workerPool.forceOff');
  });
  it('未 attach 时 load 触发 ensureWorker：经全局 Worker 构造并跑通 load+call', async () => {
    const created: InstanceType<typeof MockWorker>[] = [];
    class GlobalMockWorker extends MockWorker {
      constructor(_url: string) {
        super();
        created.push(this);
      }
    }
    vi.stubGlobal('Worker', GlobalMockWorker);
    const svc = new SandboxService();
    const p = svc.load('gw', 'function search(){ return 7; }');
    // ensureWorker 在 waitForReady 之后的 microtask 才执行（load 先 await 再建 worker）
    await flushMs(0);
    expect(created).toHaveLength(1);
    created[0].emitReady();
    await flushMs(60);
    await p;
    expect(await svc.call<number>('gw', 'search', [])).toBe(7);
  });
  it('invalidate 在 worker 未创建时只清本地缓存（不抛错）', () => {
    const svc = new SandboxService();
    expect(() => svc.invalidate('ghost')).not.toThrow();
  });
  it('storage 事件 key 不匹配 kill-switch → 忽略（forceOff 不变）', () => {
    const svc = new SandboxService();
    const handler = SandboxService.__test_getStorageHandler();
    expect(handler).not.toBeNull();
    expect(() =>
      handler?.(new StorageEvent('storage', { key: 'unrelated.key', newValue: '1' })),
    ).not.toThrow();
    expect((svc as unknown as { forceOff: boolean }).forceOff).toBe(false);
  });
});

describe('SandboxService — legado.http 主线程代理', () => {
  type PomWindow = { pomAPI?: { booksourceHttpProxy?: (req: unknown) => Promise<unknown> } };
  const flushMicro = () => new Promise<void>((r) => setTimeout(r, 0));
  const sendHttp = (worker: InstanceType<typeof MockWorker>, request: Record<string, unknown>) =>
    worker.onmessage?.({ data: { type: 'http', reqId: 'h1', request } });
  const lastHttpResult = (worker: InstanceType<typeof MockWorker>) =>
    [...worker.postLog].reverse().find((m) => m['type'] === 'http-result');

  afterEach(() => {
    delete (window as unknown as PomWindow).pomAPI;
    vi.unstubAllGlobals();
    SandboxService.cfChallengeHook = null;
  });

  it('pomAPI 代理成功 → http-result 回传 status/headers/body', async () => {
    const proxy = vi.fn().mockResolvedValue({ status: 200, headers: { 'x-a': '1' }, body: 'html' });
    (window as unknown as PomWindow).pomAPI = { booksourceHttpProxy: proxy };
    const { worker } = makeService();
    const request = { url: 'https://a.test/x' };
    sendHttp(worker, request);
    await flushMicro();
    expect(proxy).toHaveBeenCalledWith(request);
    expect(lastHttpResult(worker)).toMatchObject({
      reqId: 'h1',
      status: 200,
      headers: { 'x-a': '1' },
      body: 'html',
    });
  });
  it('pomAPI 返回 cfChallenge → 触发 cfChallengeHook(url)', async () => {
    const hook = vi.fn();
    SandboxService.cfChallengeHook = hook;
    (window as unknown as PomWindow).pomAPI = {
      booksourceHttpProxy: vi
        .fn()
        .mockResolvedValue({ status: 403, headers: {}, body: '', cfChallenge: true }),
    };
    const { worker } = makeService();
    sendHttp(worker, { url: 'https://cf.test/' });
    await flushMicro();
    expect(hook).toHaveBeenCalledWith('https://cf.test/');
    expect(lastHttpResult(worker)).toMatchObject({ status: 403 });
  });
  it('pomAPI 代理抛错 → http-result status 599 + 错误日志', async () => {
    (window as unknown as PomWindow).pomAPI = {
      booksourceHttpProxy: vi.fn().mockRejectedValue(new Error('proxy-down')),
    };
    const { svc, worker } = makeService();
    sendHttp(worker, { url: 'https://a.test/x' });
    await flushMicro();
    expect(lastHttpResult(worker)).toMatchObject({ reqId: 'h1', status: 599, body: '' });
    expect(svc.progress().some((l) => l.includes('主进程代理失败: proxy-down'))).toBe(true);
  });
  it('无 pomAPI → renderer fetch 降级成功（method/headers/body 走默认值）', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 201,
      headers: {
        forEach: (cb: (v: string, k: string) => void) => cb('text/html', 'content-type'),
      },
      text: () => Promise.resolve('<p>ok</p>'),
    });
    vi.stubGlobal('fetch', fetchMock);
    const { worker } = makeService();
    sendHttp(worker, { url: 'https://a.test/x' });
    await flushMicro();
    expect(fetchMock).toHaveBeenCalledWith('https://a.test/x', {
      method: 'GET',
      headers: {},
      body: undefined,
    });
    expect(lastHttpResult(worker)).toMatchObject({
      status: 201,
      headers: { 'content-type': 'text/html' },
      body: '<p>ok</p>',
    });
  });
  it('fetch 失败（Failed to fetch）→ 599 + 网络/CORS/DNS 提示日志', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const { svc, worker } = makeService();
    sendHttp(worker, { url: 'https://a.test/x' });
    await flushMicro();
    expect(lastHttpResult(worker)).toMatchObject({ status: 599 });
    expect(svc.progress().some((l) => l.includes('网络/CORS/DNS 失败'))).toBe(true);
  });
  it('fetch 失败（其它错误）→ 599 且无网络提示', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')));
    const { svc, worker } = makeService();
    sendHttp(worker, { url: 'https://a.test/x' });
    await flushMicro();
    expect(lastHttpResult(worker)).toMatchObject({ status: 599 });
    expect(svc.progress().some((l) => l.includes('网络/CORS/DNS 失败'))).toBe(false);
    expect(svc.progress().some((l) => l.includes('legado.http fetch 失败: boom'))).toBe(true);
  });
});

describe('SandboxService — legado.query 边界分支', () => {
  const queryRaw = (data: Record<string, unknown>) => {
    const { worker } = makeService();
    worker.onmessage?.({ data: { type: 'query', reqId: 'q9', ...data } });
    return worker.postLog.find((m) => m['type'] === 'query-result');
  };

  it('空白选择器 → ok:false 带书源规则提示', () => {
    const res = queryRaw({ html: '<a>t</a>', selector: '   ', baseUrl: '' });
    expect(res?.['ok']).toBe(false);
    expect(String(res?.['error'])).toContain('选择器为空');
  });
  it('query 消息缺 html/selector/baseUrl 字段 → 按空串处理（选择器为空）', () => {
    const res = queryRaw({});
    expect(res?.['ok']).toBe(false);
    expect(String(res?.['error'])).toContain('选择器为空');
  });
  it('无 href 的锚点 → href 为空串且 links 为空', () => {
    const res = queryRaw({ html: '<a>纯文本</a>', selector: 'a', baseUrl: 'https://x.test/' });
    expect(res?.['ok']).toBe(true);
    const items = res?.['items'] as Array<{ href: string; links: unknown[] }>;
    expect(items[0].href).toBe('');
    expect(items[0].links).toEqual([]);
  });
  it('后代锚点 href 全部不可解析 → links 被过滤为空；attrs 收集元素属性（小写 key）', () => {
    const res = queryRaw({
      html: '<dd data-x="1"><a href="">空</a><a href="/ok">好</a></dd>',
      selector: 'dd',
      baseUrl: '',
    });
    expect(res?.['ok']).toBe(true);
    const items = res?.['items'] as Array<{
      links: unknown[];
      attrs: Record<string, string>;
    }>;
    expect(items[0].links).toEqual([]);
    expect(items[0].attrs).toEqual({ 'data-x': '1' });
  });
});
