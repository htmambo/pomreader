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
  terminated = false;
  postLog: Array<Record<string, unknown>> = [];
  private readonly modules = new Map<string, ModFns>();
  private harden = false;
  enableHardening(): void { this.harden = true; }
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
const flushMs = (ms: number) => vi.advanceTimersByTimeAsync(ms);

describe('SandboxService — 模块加载 + 调用', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it('load 后 call 返回正常结果', async () => {
    const { svc } = makeService();
    const p = svc.load('ok', 'function search() { return "ok"; }');
    await flushMs(60); await p;
    expect(await svc.call<string>('ok', 'search', [])).toBe('ok');
  });
  it('已加载模块 cache 命中，不重新发 load 消息', async () => {
    const { svc, worker } = makeService();
    const p1 = svc.load('cache', 'function search() { return 1; }');
    await flushMs(60); await p1;
    await svc.call('cache', 'search', []);
    const before = worker.postLog.filter((m) => m['type'] === 'load').length;
    await svc.load('cache', 'function search() { return 2; }');
    expect(worker.postLog.filter((m) => m['type'] === 'load').length).toBe(before);
  });
});

describe('SandboxService — 沙箱隔离（NFR-2）', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it('localStorage.getItem 抛 ReferenceError', async () => {
    const { svc, worker } = makeService(); worker.enableHardening();
    const p = svc.load('m1', 'function search() { return localStorage.getItem("x"); }');
    await flushMs(60); await p;
    await expect(svc.call('m1', 'search', [])).rejects.toBeInstanceOf(ReferenceError);
  });
  it('window.parent 抛 TypeError', async () => {
    const { svc, worker } = makeService(); worker.enableHardening();
    const p = svc.load('m2', 'function search() { return window.parent.location; }');
    await flushMs(60); await p;
    await expect(svc.call('m2', 'search', [])).rejects.toBeInstanceOf(TypeError);
  });
  it('globalThis.localStorage 抛 ReferenceError', async () => {
    const { svc, worker } = makeService(); worker.enableHardening();
    const p = svc.load('m3', 'function search() { return globalThis.localStorage.getItem("x"); }');
    await flushMs(60); await p;
    await expect(svc.call('m3', 'search', [])).rejects.toBeInstanceOf(ReferenceError);
  });
});

describe('SandboxService — invalidate / 超时 / pool', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it('invalidate 后重新加载返回新结果（FR-1.3.1）', async () => {
    const { svc } = makeService();
    const p1 = svc.load('src', 'function search() { return "v1"; }');
    await flushMs(60); await p1;
    expect(await svc.call('src', 'search', [])).toBe('v1');
    svc.invalidate('src'); await flushMs(60);
    const p2 = svc.load('src', 'function search() { return "v2"; }');
    await flushMs(60); await p2;
    expect(await svc.call('src', 'search', [])).toBe('v2');
  });
  it('15s 未返回 → reject FetchError("timeout")（FR-1.3.2）', async () => {
    const { svc } = makeService();
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
    const pl = svc.load('pool', 'function search() { return new Promise(r => setTimeout(() => r("d"), 100)); }');
    await flushMs(60); await pl;
    const promises = Array.from({ length: 7 }, () => svc.call('pool', 'search', []));
    await flushMs(0); // microtask：6 个 call 已发，第 7 排队
    expect(worker.postLog.filter((m) => m['type'] === 'call').length).toBe(6);
    await flushMs(300);
    expect(await Promise.all(promises)).toEqual(Array(7).fill('d'));
  });
});