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
    it('kill-switch "false" 时应返回 SynchronousWorkerAdapter + warn log', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      localStorage.setItem('pom.workerPool', 'false');
      const pool = createWorkerPool();
      expect(pool).toBeInstanceOf(SynchronousWorkerAdapter);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('kill-switch'));
      warnSpy.mockRestore();
    });

    it('默认（无 kill-switch）应返回 SynchronousWorkerAdapter（Phase 4 P3 defer placeholder）', () => {
      const pool: WorkerLike = createWorkerPool();
      expect(pool).toBeDefined();
      expect(typeof pool.run).toBe('function');
      expect(typeof pool.terminate).toBe('function');
    });

    it('"0" / "true" 等非 "false" 值不应触发 kill-switch warn', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      localStorage.setItem('pom.workerPool', '0');
      const pool = createWorkerPool();
      expect(pool).toBeInstanceOf(SynchronousWorkerAdapter);
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });
});
