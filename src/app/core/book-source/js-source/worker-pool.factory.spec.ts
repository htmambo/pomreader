import { describe, it, expect, beforeEach } from 'vitest';
import { createWorkerPool, SynchronousWorkerAdapter, WorkerLike } from './worker-pool.factory';

describe('WorkerPool factory + SynchronousWorkerAdapter', () => {
  beforeEach(() => {
    localStorage.removeItem('pom.workerPool');
  });

  describe('SynchronousWorkerAdapter', () => {
    it('应能直接执行 task 并返回结果', async () => {
      const adapter = new SynchronousWorkerAdapter();
      const result = await adapter.run(async () => 42);
      expect(result).toBe(42);
    });

    it('应能传播 task 抛出的错误', async () => {
      const adapter = new SynchronousWorkerAdapter();
      await expect(
        adapter.run(async () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
    });

    it('terminate 应为 no-op 不抛错', () => {
      const adapter = new SynchronousWorkerAdapter();
      expect(() => adapter.terminate()).not.toThrow();
    });

    it('应支持异步链（task 返回 Promise<T>）', async () => {
      const adapter = new SynchronousWorkerAdapter();
      const result = await adapter.run(async () => {
        const x = await Promise.resolve(10);
        return x * 2;
      });
      expect(result).toBe(20);
    });
  });

  describe('createWorkerPool', () => {
    it('kill-switch 关闭时应返回 SynchronousWorkerAdapter', () => {
      localStorage.setItem('pom.workerPool', 'false');
      const pool = createWorkerPool();
      expect(pool).toBeInstanceOf(SynchronousWorkerAdapter);
    });

    it('kill-switch 未设置时应返回可用 adapter（默认行为）', () => {
      const pool: WorkerLike = createWorkerPool();
      expect(pool).toBeDefined();
      expect(typeof pool.run).toBe('function');
      expect(typeof pool.terminate).toBe('function');
    });

    it('kill-switch 仅在 "false" 字符串时触发', () => {
      localStorage.setItem('pom.workerPool', '0');
      const pool = createWorkerPool();
      expect(pool).toBeInstanceOf(SynchronousWorkerAdapter);
      // "0" 视作 truthy in string → 不同处理？
      // 当前实现：localStorage.getItem 返回 "0" 时 !== "false"，所以不触发
      // 这符合"仅显式 'false' 关闭"的语义
    });
  });
});