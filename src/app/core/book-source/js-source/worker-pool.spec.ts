import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  WorkerPoolImpl,
  WorkerLikeInternal,
  WorkerPoolConfig,
  WorkerResult,
  WorkerTask,
  PoolFullError,
  WorkerCrashedError,
} from './worker-pool';

/** Mock Worker：手动驱动 postMessage / onmessage（jsdom 不支持真 Worker） */
function makeMockWorker(): {
  worker: WorkerLikeInternal;
  /** 推一条消息到 worker.onmessage */
  deliverResult: (reqId: string, result: WorkerResult) => void;
  /** 推一条错误到 worker.onerror */
  deliverError: (e: unknown) => void;
  /** 是否被 terminate */
  isTerminated: () => boolean;
} {
  let terminated = false;
  const w: WorkerLikeInternal = {
    postMessage: vi.fn(),
    terminate: vi.fn(() => {
      terminated = true;
    }),
    onmessage: null,
    onerror: null,
    onmessageerror: null,
  };
  return {
    worker: w,
    deliverResult: (reqId, result) => {
      if (!terminated && w.onmessage) w.onmessage({ data: { ...result, reqId } });
    },
    deliverError: (e) => {
      if (!terminated && w.onerror) w.onerror(e);
    },
    isTerminated: () => terminated,
  };
}

const fastConfig: Omit<WorkerPoolConfig, 'workerFactory'> = {
  size: 2,
  pendingCap: 4,
  timeoutMs: 100,
  lruMax: 5,
};

describe('WorkerPoolImpl', () => {
  let mocks: ReturnType<typeof makeMockWorker>[];
  let pools: WorkerPoolImpl[];

  beforeEach(() => {
    mocks = [];
    pools = [];
  });

  // 用例结束后统一 terminate：清掉 pending 条目的超时定时器，
  // 否则定时器会在用例之外触发 reject → unhandled rejection
  afterEach(() => {
    for (const p of pools) p.terminate();
    pools = [];
  });

  function makePool(overrides: Partial<WorkerPoolConfig> = {}): WorkerPoolImpl {
    const factory = () => {
      const m = makeMockWorker();
      mocks.push(m);
      return m.worker;
    };
    const pool = new WorkerPoolImpl({ ...fastConfig, ...overrides, workerFactory: factory });
    pools.push(pool);
    return pool;
  }

  describe('基础调度', () => {
    it('schedule 应把 task 转发到第一个 worker', async () => {
      const pool = makePool();
      const task: WorkerTask = { type: 'load', fileName: 'f1', source: 's', reqId: 'r1' };
      const promise = pool.schedule(task);
      // postMessage 已发送
      expect(mocks[0].worker.postMessage).toHaveBeenCalledWith(task);
      // 模拟 worker 返回
      mocks[0].deliverResult('r1', { ok: true, value: { fns: ['search'] } });
      const result = await promise;
      expect(result.ok).toBe(true);
    });

    it('多 task 串行：worker 上一次只能跑一个', async () => {
      const pool = makePool();
      const t1: WorkerTask = { type: 'load', fileName: 'a', source: '', reqId: 'r1' };
      const t2: WorkerTask = { type: 'load', fileName: 'b', source: '', reqId: 'r2' };
      const p1 = pool.schedule(t1);
      // 第一个已发出
      expect(mocks[0].worker.postMessage).toHaveBeenCalledWith(t1);
      // 第二个应排队（worker busy），派到另一个空闲 worker
      const p2 = pool.schedule(t2);
      expect(mocks[1].worker.postMessage).toHaveBeenCalledWith(t2);
      // 返回两个 worker 的结果
      mocks[0].deliverResult('r1', { ok: true });
      await p1;
      mocks[1].deliverResult('r2', { ok: true });
      await p2;
    });
  });

  describe('反压 + PoolFullError', () => {
    it('超出 pendingCap 应抛 PoolFullError', async () => {
      const pool = makePool({ pendingCap: 2 });
      // 第 1 + 第 2 排队（故意不 resolve：挂 catch 收尾，由 afterEach 的 terminate 拒绝）
      pool.schedule({ type: 'load', fileName: 'a', source: '', reqId: 'r1' }).catch(() => {});
      pool.schedule({ type: 'load', fileName: 'b', source: '', reqId: 'r2' }).catch(() => {});
      // 第 3 应抛 PoolFullError
      await expect(
        pool.schedule({ type: 'load', fileName: 'c', source: '', reqId: 'r3' }),
      ).rejects.toBeInstanceOf(PoolFullError);
    });
  });

  describe('超时 + terminate-before-reject', () => {
    it('30s 内未返回应 terminate worker 再 reject', async () => {
      vi.useFakeTimers();
      try {
        const pool = makePool({ timeoutMs: 100 });
        const promise = pool.schedule({
          type: 'load',
          fileName: 'a',
          source: '',
          reqId: 'r1',
        });
        // attach catch 避免 unhandled rejection
        const caught = promise.catch((e) => e);
        // 推进时间到 timeout
        vi.advanceTimersByTime(150);
        // worker 应被 terminate
        expect(mocks[0].isTerminated()).toBe(true);
        // 等待 reject 触发
        const err = await caught;
        expect((err as Error).message).toMatch(/timeout/);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('worker crash + refill', () => {
    it('worker.onerror 应 reject in-flight + spawn 新 worker', async () => {
      const pool = makePool({ size: 1 });
      const promise = pool.schedule({
        type: 'load',
        fileName: 'a',
        source: '',
        reqId: 'r1',
      });
      // 模拟 worker 崩溃
      mocks[0].deliverError(new Error('boom'));
      await expect(promise).rejects.toBeInstanceOf(WorkerCrashedError);
      // 旧 worker 已 terminate
      expect(mocks[0].isTerminated()).toBe(true);
      // 新 worker 已被 spawn
      expect(mocks.length).toBeGreaterThan(1);
    });
  });

  describe('LRU 模块缓存', () => {
    it('cacheModule 超出 lruMax 应淘汰最旧条目', () => {
      const pool = makePool({ lruMax: 2 });
      pool.cacheModule('a', 1);
      pool.cacheModule('b', 2);
      pool.cacheModule('c', 3); // 淘汰 a
      expect(pool.getCachedModule('a')).toBeUndefined();
      expect(pool.getCachedModule('b')).toBe(2);
      expect(pool.getCachedModule('c')).toBe(3);
    });

    it('getCachedModule 命中应移到末尾（LRU 更新）', () => {
      const pool = makePool({ lruMax: 2 });
      pool.cacheModule('a', 1);
      pool.cacheModule('b', 2);
      // 访问 a → 移到末尾
      pool.getCachedModule('a');
      // 新增 c → 应淘汰 b（最旧）
      pool.cacheModule('c', 3);
      expect(pool.getCachedModule('b')).toBeUndefined();
      expect(pool.getCachedModule('a')).toBe(1);
      expect(pool.getCachedModule('c')).toBe(3);
    });
  });

  describe('消息处理边界', () => {
    it('无 pending 时收到 result 静默忽略（不抛错）', () => {
      const pool = makePool();
      expect(pool).toBeDefined();
      expect(() => mocks[0].deliverResult('ghost', { ok: true })).not.toThrow();
    });

    it('worker 返回 ok:false → reject Error(msg.error)', async () => {
      const pool = makePool();
      const promise = pool.schedule({ type: 'load', fileName: 'a', source: '', reqId: 'r1' });
      mocks[0].deliverResult('r1', { ok: false, error: 'compile-fail' });
      await expect(promise).rejects.toThrow('compile-fail');
    });

    it('worker 返回 ok:false 且无 error 字段 → reject Error(unknown)', async () => {
      const pool = makePool();
      const promise = pool.schedule({ type: 'load', fileName: 'a', source: '', reqId: 'r1' });
      mocks[0].deliverResult('r1', { ok: false });
      await expect(promise).rejects.toThrow('unknown');
    });

    it('前一个任务完成后自动派发同 worker 队列里的下一个任务', async () => {
      const pool = makePool({ size: 1 });
      const t1: WorkerTask = { type: 'load', fileName: 'a', source: '', reqId: 'r1' };
      const t2: WorkerTask = { type: 'load', fileName: 'b', source: '', reqId: 'r2' };
      const p1 = pool.schedule(t1);
      const p2 = pool.schedule(t2);
      // 第二个任务排队中，未派发
      expect(mocks[0].worker.postMessage).toHaveBeenCalledTimes(1);
      mocks[0].deliverResult('r1', { ok: true });
      await p1;
      // r1 完成后 r2 被自动派发
      expect(mocks[0].worker.postMessage).toHaveBeenCalledTimes(2);
      expect(mocks[0].worker.postMessage).toHaveBeenLastCalledWith(t2);
      mocks[0].deliverResult('r2', { ok: true });
      await p2;
    });
  });

  describe('负载均衡', () => {
    it('各 worker 队列等长时新任务派到首个 worker（len < minLen 不成立）', async () => {
      const pool = makePool({ size: 2, pendingCap: 8 });
      const p1 = pool.schedule({ type: 'load', fileName: 'a', source: '', reqId: 'r1' });
      const p2 = pool.schedule({ type: 'load', fileName: 'b', source: '', reqId: 'r2' });
      // w0 队列长度 1，w1 队列长度 1 → 第三个任务 len(1) < minLen(1) 为 false → 留在 w0
      const p3 = pool.schedule({ type: 'load', fileName: 'c', source: '', reqId: 'r3' });
      p3.catch(() => {});
      expect(mocks[0].worker.postMessage).toHaveBeenCalledTimes(1);
      expect(mocks[1].worker.postMessage).toHaveBeenCalledTimes(1);
      // r1 完成后 r3 在 w0 上被派发
      mocks[0].deliverResult('r1', { ok: true });
      await p1;
      expect(mocks[0].worker.postMessage).toHaveBeenCalledTimes(2);
      mocks[0].deliverResult('r3', { ok: true });
      await p3;
      mocks[1].deliverResult('r2', { ok: true });
      await p2;
    });
  });

  describe('worker crash 边界', () => {
    it('worker.onmessageerror 同样触发 crash + refill', async () => {
      const pool = makePool({ size: 1 });
      const promise = pool.schedule({ type: 'load', fileName: 'a', source: '', reqId: 'r1' });
      const w = mocks[0].worker;
      w.onmessageerror?.(new Error('bad-msg'));
      await expect(promise).rejects.toBeInstanceOf(WorkerCrashedError);
      expect(mocks[0].isTerminated()).toBe(true);
      expect(mocks.length).toBeGreaterThan(1);
    });

    it('crash 事件无 message → WorkerCrashedError(unknown)', async () => {
      const pool = makePool({ size: 1 });
      const promise = pool.schedule({ type: 'load', fileName: 'a', source: '', reqId: 'r1' });
      mocks[0].deliverError({});
      await expect(promise).rejects.toThrow(/Worker crashed: unknown/);
    });

    it('terminate 后迟到的 error 事件：不 respawn、不抛错', () => {
      const pool = makePool({ size: 1 });
      const lateHandler = mocks[0].worker.onerror;
      pool.terminate();
      expect(() => lateHandler?.(new Error('late'))).not.toThrow();
      // terminated → 不 refill
      expect(mocks.length).toBe(1);
    });
  });

  describe('LRU 边界', () => {
    it('cacheModule 同 key 覆盖旧值并移到末尾', () => {
      const pool = makePool({ lruMax: 2 });
      pool.cacheModule('a', 1);
      pool.cacheModule('b', 2);
      pool.cacheModule('a', 10); // 覆盖 + 移到末尾
      pool.cacheModule('c', 3); // 淘汰 b（a 刚被刷新）
      expect(pool.getCachedModule('a')).toBe(10);
      expect(pool.getCachedModule('b')).toBeUndefined();
      expect(pool.getCachedModule('c')).toBe(3);
    });
  });

  describe('terminate 关闭', () => {
    it('terminate 应拒绝所有 pending tasks', async () => {
      const pool = makePool();
      const p1 = pool.schedule({ type: 'load', fileName: 'a', source: '', reqId: 'r1' });
      const p2 = pool.schedule({ type: 'load', fileName: 'b', source: '', reqId: 'r2' });
      pool.terminate();
      await expect(p1).rejects.toThrow(/terminated/i);
      await expect(p2).rejects.toThrow(/terminated/i);
    });

    it('terminate 后再 schedule 应 reject', async () => {
      const pool = makePool();
      pool.terminate();
      await expect(
        pool.schedule({ type: 'load', fileName: 'x', source: '', reqId: 'r1' }),
      ).rejects.toThrow(/terminated/i);
    });
  });
});
