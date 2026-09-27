import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SandboxService } from './sandbox.service';

/**
 * EV-3 Worker Pool 渐进迁移专用单测（review_code Round 2 要求补 3 个 case）：
 *  - setUsePool(true)→(false) 清理路径：pool===null，无悬挂 worker
 *  - localStorage kill-switch `evo3.workerPool.forceOff=1`：构造后 isUsingPool()===false
 *  - BookRepository 接口漂移：见上一节文件顶部 review notes（保留为 manual smoke，由 tsc 强制）
 *
 * 用 Object.create + 手动初始化绕开 constructor（不依赖 DI / 不调 forTest 的 attach(Worker)）。
 * 纯 pool 状态机测试 —— 不涉及沙箱消息路径。
 */
function makeBareSvc(): SandboxService {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const svc: any = Object.create(SandboxService.prototype);
  svc.progress = { set: () => undefined, update: () => undefined };
  svc.usePool = false;
  svc.pool = null;
  return svc as SandboxService;
}

describe('SandboxService — EV-3 Worker Pool 渐进迁移', () => {
  let svc: SandboxService;

  beforeEach(() => {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem('evo3.workerPool.forceOff');
    }
    svc = makeBareSvc();
  });

  afterEach(() => {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem('evo3.workerPool.forceOff');
    }
  });

  it('setUsePool(true)→(false) 后 pool 应被清空，无悬挂 worker', () => {
    expect(svc.isUsingPool()).toBe(false);
    svc.setUsePool(true);
    expect(svc.isUsingPool()).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((svc as any).pool).not.toBeNull();
    svc.setUsePool(false);
    expect(svc.isUsingPool()).toBe(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((svc as any).pool).toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((svc as any).usePool).toBe(false);
  });

  it('setUsePool(false) 在未启用时应幂等（无副作用）', () => {
    svc.setUsePool(false);
    expect(svc.isUsingPool()).toBe(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((svc as any).pool).toBeNull();
  });

  it('localStorage evo3.workerPool.forceOff=1 时构造后 isUsingPool()===false', () => {
    // 模拟 operator 提前写 kill-switch 后再构造实例
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('evo3.workerPool.forceOff', '1');
    }
    // 通过 `new` 触发真正的 constructor() —— 验证 kill-switch 逻辑
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fresh: any = new (SandboxService as any)();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(fresh.usePool).toBe(false);
    expect(fresh.isUsingPool()).toBe(false);
  });

  it('forceDisablePool() 应写 localStorage kill-switch', () => {
    svc.forceDisablePool();
    expect(svc.isUsingPool()).toBe(false);
    if (typeof localStorage !== 'undefined') {
      expect(localStorage.getItem('evo3.workerPool.forceOff')).toBe('1');
    }
  });
});