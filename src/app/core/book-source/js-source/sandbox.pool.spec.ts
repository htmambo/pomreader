import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SandboxService } from './sandbox.service';

// 模块级 reset hook —— 测试 teardown 释放 storage listener 让下一例可以重新注册
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function resetModuleStorageListener(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const svc: any = Object.create(SandboxService.prototype);
  svc.ngOnDestroy();
}

/**
 * EV-3 Worker Pool 渐进迁移专用单测（review_code Round 2 + Round 3 + Round 4）：
 *  - P0-1: setUsePool(true)→(false) 清理路径：pool===null，无悬挂 worker
 *  - P0-2: localStorage kill-switch `evo3.v1.workerPool.forceOff`：构造后 isUsingPool()===false
 *  - P1-A: forceDisablePool() 后 setUsePool(true) 应被忽略（立即生效）
 *  - P2-C: '1' / 'true' 两种写法均识别；SSR / 无 localStorage 兜底
 *  - P3-B: forceEnablePool() 应清除 kill-switch（localStorage + reload survival）
 *  - P3-C: storage 事件处理 key===null / 跨标签页同步
 *  - P3-A: localStorage mock 跨用例隔离（beforeEach/afterEach clear）
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
  return svc as SandboxService;
}

describe('SandboxService — EV-3 Worker Pool 渐进迁移', () => {
  let svc: SandboxService;

  beforeEach(() => {
    // P3-A: 跨用例隔离
    if (typeof localStorage !== 'undefined') {
      localStorage.clear();
    }
    svc = makeBareSvc();
  });

  afterEach(() => {
    if (typeof localStorage !== 'undefined') {
      localStorage.clear();
    }
    // 释放模块级 storage listener 让下一例 fresh 注册（避免 first-instance this 捕获）
    resetModuleStorageListener();
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

  it('P1-A semantic: setUsePool(false) 已启用 pool 时 terminate() 同步触发（无悬挂 worker）', () => {
    svc.setUsePool(true);
    const pool = (svc as unknown as { pool: { terminate: () => void } }).pool;
    let terminateCalled = false;
    pool.terminate = () => {
      terminateCalled = true;
    };
    svc.setUsePool(false);
    expect(terminateCalled).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((svc as any).pool).toBeNull();
  });

  it('P3-B: forceEnablePool() 解除 kill-switch（内存 + localStorage）', () => {
    svc.forceDisablePool();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((svc as any).forceOff).toBe(true);
    expect(svc.isUsingPool()).toBe(false);
    svc.forceEnablePool();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((svc as any).forceOff).toBe(false);
    if (typeof localStorage !== 'undefined') {
      expect(localStorage.getItem('evo3.v1.workerPool.forceOff')).toBeNull();
    }
    svc.setUsePool(true);
    expect(svc.isUsingPool()).toBe(true);
  });

  it('P0-3: forceEnablePool() 后 reload 新实例应保持 forceOff=false', () => {
    svc.forceDisablePool();
    if (typeof localStorage !== 'undefined') {
      expect(localStorage.getItem('evo3.v1.workerPool.forceOff')).toBe('1');
    }
    svc.forceEnablePool();
    // 模拟 reload：构造新实例
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const reloaded: any = new (SandboxService as any)();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(reloaded.forceOff).toBe(false);
  });

  it('P3-C: storage 事件 key===null（localStorage.clear()）应重置 forceOff=false', () => {
    svc.forceDisablePool();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((svc as any).forceOff).toBe(true);
    // 构造一个实例触发 storage 监听注册
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inst: any = new (SandboxService as any)();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(inst.forceOff).toBe(true);
    // 直接调用注册的 handler（模块级 MODULE_STORAGE_HANDLER）—— 无需 inst.storageHandler 字段
    // 通过 import 间接访问：getRegisteredHandler() 已在测试套件内部导出
    if (typeof window !== 'undefined') {
      const ev = new StorageEvent('storage', { key: null, newValue: null });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (SandboxService as any).__test_getStorageHandler?.();
      if (handler) handler(ev);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((inst as any).forceOff).toBe(false);
    }
  });

  it('P3-C: storage 事件跨标签页同步 forceOff=true（其它 tab 调用 forceDisablePool）', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inst: any = new (SandboxService as any)();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(inst.forceOff).toBe(false);
    inst.setUsePool(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(inst.forceOff).toBe(false);
    if (typeof window !== 'undefined') {
      const ev = new StorageEvent('storage', {
        key: 'evo3.v1.workerPool.forceOff',
        newValue: '1',
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (SandboxService as any).__test_getStorageHandler?.();
      if (handler) {
        handler(ev);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect((inst as any).forceOff).toBe(true);
        expect(inst.isUsingPool()).toBe(false);
      }
    }
  });

  it('P1-δ: storage 事件 e.newValue=null（其它 tab 调 removeItem）应解除 forceOff', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inst: any = new (SandboxService as any)();
    inst.forceDisablePool();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(inst.forceOff).toBe(true);
    if (typeof window !== 'undefined') {
      const ev = new StorageEvent('storage', {
        key: 'evo3.v1.workerPool.forceOff',
        newValue: null, // removeItem 触发
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (SandboxService as any).__test_getStorageHandler?.();
      if (handler) {
        handler(ev);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect((inst as any).forceOff).toBe(false);
      }
    }
  });

  it('forceDisablePool() 应写 localStorage kill-switch', () => {
    svc.forceDisablePool();
    expect(svc.isUsingPool()).toBe(false);
    if (typeof localStorage !== 'undefined') {
      expect(localStorage.getItem('evo3.v1.workerPool.forceOff')).toBe('1');
    }
  });
});