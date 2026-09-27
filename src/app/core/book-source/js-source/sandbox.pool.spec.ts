import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SandboxService } from './sandbox.service';

/**
 * EV-3 Worker Pool 渐进迁移专用单测（review_code Round 2 + Round 3）：
 *  - P0-1: setUsePool(true)→(false) 清理路径：pool===null，无悬挂 worker
 *  - P0-2: localStorage kill-switch `evo3.v1.workerPool.forceOff`：构造后 isUsingPool()===false
 *  - P1-A: forceDisablePool() 后 setUsePool(true) 应被忽略（立即生效）
 *  - P2-C: '1' / 'true' 两种写法均识别；SSR / 无 localStorage 兜底
 *  - P3-B: forceEnablePool() 应清除 kill-switch
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
  svc.forceOff = false;
  svc.storageHandler = null;
  return svc as SandboxService;
}

describe('SandboxService — EV-3 Worker Pool 渐进迁移', () => {
  let svc: SandboxService;

  beforeEach(() => {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem('evo3.v1.workerPool.forceOff');
    }
    svc = makeBareSvc();
  });

  afterEach(() => {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem('evo3.v1.workerPool.forceOff');
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

  it('localStorage evo3.v1.workerPool.forceOff=1 时构造后 isUsingPool()===false', () => {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('evo3.v1.workerPool.forceOff', '1');
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fresh: any = new (SandboxService as any)();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(fresh.forceOff).toBe(true);
    expect(fresh.isUsingPool()).toBe(false);
  });

  it('P2-C: localStorage kill-switch 接受 "true" 写法', () => {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('evo3.v1.workerPool.forceOff', 'true');
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fresh: any = new (SandboxService as any)();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(fresh.forceOff).toBe(true);
  });

  it('P2-C: localStorage kill-switch 拒绝 "0" / "false" 等非触发值', () => {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('evo3.v1.workerPool.forceOff', '0');
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fresh1: any = new (SandboxService as any)();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(fresh1.forceOff).toBe(false);

    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('evo3.v1.workerPool.forceOff', 'false');
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fresh2: any = new (SandboxService as any)();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(fresh2.forceOff).toBe(false);
  });

  it('P1-A: forceDisablePool() 后 setUsePool(true) 应被忽略（立即生效）', () => {
    svc.forceDisablePool();
    expect(svc.isUsingPool()).toBe(false);
    svc.setUsePool(true);
    // forceOff 锁死 → 仍为 false
    expect(svc.isUsingPool()).toBe(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((svc as any).pool).toBeNull();
  });

  it('P3-B: forceEnablePool() 解除 kill-switch', () => {
    svc.forceDisablePool();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((svc as any).forceOff).toBe(true);
    svc.forceEnablePool();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((svc as any).forceOff).toBe(false);
    svc.setUsePool(true);
    expect(svc.isUsingPool()).toBe(true);
  });

  it('forceDisablePool() 应写 localStorage kill-switch', () => {
    svc.forceDisablePool();
    expect(svc.isUsingPool()).toBe(false);
    if (typeof localStorage !== 'undefined') {
      expect(localStorage.getItem('evo3.v1.workerPool.forceOff')).toBe('1');
    }
  });
});