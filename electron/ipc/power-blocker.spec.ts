import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';

/**
 * power-blocker spec — 主进程防睡眠/防锁屏封装
 *
 * 覆盖：
 * - 幂等 start（重复 set(true) 不泄漏 blocker id）
 * - 幂等 stop（无 blocker 时 stop 为空操作）
 * - start 抛错（无 logind 的 Linux）→ supported=false 且不持有 id
 * - 系统单方面释放唤醒锁后 getState 能清理失效 id
 * - IPC 参数收敛：非 true 的真值（'false'/1）不应被当成开启
 * - stopBlockerOnQuit 显式释放
 * - watchWebContents：webContents destroyed / render-process-gone 时兜底释放
 */

/** start() 递增分配 id（与 Electron 实现一致：单调递增、不复用） */
let nextId = 0;
/** 当前处于 started 状态的 id 集合 */
const started = new Set<number>();
/** 让下一次 start 抛错，模拟无 logind 的 Linux */
let startShouldThrow = false;

vi.mock('electron', () => ({
  powerSaveBlocker: {
    start: vi.fn((_type: string) => {
      if (startShouldThrow) throw new Error('logind unavailable');
      const id = nextId++;
      started.add(id);
      return id;
    }),
    stop: vi.fn((id: number) => started.delete(id)),
    isStarted: vi.fn((id: number) => started.has(id)),
  },
}));

import { powerSaveBlocker } from 'electron';
import {
  __resetForTest,
  getState,
  registerPowerBlockerHandler,
  setActive,
  stopBlockerOnQuit,
  watchWebContents,
} from './power-blocker';

/** ipcMain.handle 收集器：复刻 Electron 的 (event, ...args) 展开语义 */
function makeIpcMainMock(): {
  handle: ReturnType<typeof vi.fn>;
  invoke: (channel: string, ...args: unknown[]) => unknown;
} {
  const handlers = new Map<string, (e: unknown, ...rest: unknown[]) => unknown>();
  return {
    handle: vi.fn((channel: string, handler: (e: unknown, ...rest: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
    invoke: (channel, ...args) => {
      const h = handlers.get(channel);
      if (!h) throw new Error(`no handler: ${channel}`);
      return h({}, ...args);
    },
  };
}

beforeEach(() => {
  nextId = 0;
  started.clear();
  startShouldThrow = false;
  __resetForTest();
  vi.mocked(powerSaveBlocker.start).mockClear();
  vi.mocked(powerSaveBlocker.stop).mockClear();
});

describe('setActive（幂等语义）', () => {
  it('未持有时 getState 应为 inactive', () => {
    expect(getState().active).toBe(false);
    expect(powerSaveBlocker.start).not.toHaveBeenCalled();
  });

  it('set(true) 应以 prevent-display-sleep 申请唤醒锁', () => {
    const s = setActive(true);
    expect(s.active).toBe(true);
    expect(s.supported).toBe(true);
    expect(powerSaveBlocker.start).toHaveBeenCalledWith('prevent-display-sleep');
  });

  it('重复 set(true) 不得重复 start（否则每次调用泄漏一个 blocker id）', () => {
    setActive(true);
    setActive(true);
    setActive(true);
    expect(powerSaveBlocker.start).toHaveBeenCalledTimes(1);
    expect(started.size).toBe(1);
  });

  it('set(false) 应释放唤醒锁', () => {
    setActive(true);
    const s = setActive(false);
    expect(s.active).toBe(false);
    expect(powerSaveBlocker.stop).toHaveBeenCalledTimes(1);
    expect(started.size).toBe(0);
  });

  it('未持有时 set(false) 应为空操作（不调 stop）', () => {
    setActive(false);
    expect(powerSaveBlocker.stop).not.toHaveBeenCalled();
    expect(getState().active).toBe(false);
  });

  it('反复开关后残留 blocker 数为 0', () => {
    setActive(true);
    setActive(false);
    setActive(true);
    setActive(false);
    expect(started.size).toBe(0);
  });
});

describe('平台不支持时的降级', () => {
  it('start 抛错应标记 supported=false 且不持有 id', () => {
    startShouldThrow = true;
    const s = setActive(true);
    expect(s.active).toBe(false);
    expect(s.supported).toBe(false);
    expect(started.size).toBe(0);
  });

  it('平台恢复后应能重新申请并清除 supported=false', () => {
    startShouldThrow = true;
    setActive(true);
    expect(getState().supported).toBe(false);

    startShouldThrow = false;
    __resetForTest();
    expect(setActive(true).supported).toBe(true);
  });
});

describe('系统单方面释放唤醒锁', () => {
  it('isStarted 转 false 后 getState 应清理失效 id', () => {
    setActive(true);
    // 模拟 OS / 驱动单方面释放：id 还在 started 里被外部移除
    started.clear();
    const s = getState();
    expect(s.active).toBe(false);
    // 清理后再次开启应分配新 id，而不是复用已失效的旧 id
    setActive(true);
    expect(powerSaveBlocker.start).toHaveBeenCalledTimes(2);
  });
});

describe('stopBlockerOnQuit（退出释放）', () => {
  it('应用退出时应释放已持有的唤醒锁', () => {
    setActive(true);
    stopBlockerOnQuit();
    expect(started.size).toBe(0);
    expect(getState().active).toBe(false);
  });

  it('未持有时退出释放应为空操作', () => {
    stopBlockerOnQuit();
    expect(powerSaveBlocker.stop).not.toHaveBeenCalled();
  });
});

describe('watchWebContents（渲染端消失兜底）', () => {
  /** WebContents 是 EventEmitter：用真 EventEmitter 复刻其事件语义 */
  function fakeWebContents(): EventEmitter {
    return new EventEmitter();
  }
  type Wc = Parameters<typeof watchWebContents>[0];

  it('webContents destroyed 应释放已持有的唤醒锁', () => {
    setActive(true);
    const wc = fakeWebContents();
    watchWebContents(wc as unknown as Wc);
    wc.emit('destroyed');
    expect(started.size).toBe(0);
    expect(getState().active).toBe(false);
  });

  it('render-process-gone（渲染进程崩溃）应释放已持有的唤醒锁', () => {
    setActive(true);
    const wc = fakeWebContents();
    watchWebContents(wc as unknown as Wc);
    wc.emit('render-process-gone');
    expect(started.size).toBe(0);
    expect(getState().active).toBe(false);
  });

  it('destroyed 只应释放一次（once 语义）', () => {
    setActive(true);
    const wc = fakeWebContents();
    watchWebContents(wc as unknown as Wc);
    wc.emit('destroyed');
    wc.emit('destroyed');
    expect(powerSaveBlocker.stop).toHaveBeenCalledTimes(1);
  });

  it('未持有时 destroyed 应为空操作', () => {
    const wc = fakeWebContents();
    watchWebContents(wc as unknown as Wc);
    wc.emit('destroyed');
    expect(powerSaveBlocker.stop).not.toHaveBeenCalled();
  });
});

describe('IPC 注册与参数收敛', () => {
  it('应注册 get / set 两个 channel', () => {
    const ipc = makeIpcMainMock();
    registerPowerBlockerHandler(
      ipc as unknown as Parameters<typeof registerPowerBlockerHandler>[0],
    );
    expect(ipc.handle).toHaveBeenCalledWith('pom:power-blocker-get', expect.any(Function));
    expect(ipc.handle).toHaveBeenCalledWith('pom:power-blocker-set', expect.any(Function));
  });

  it('get 应回传 active/supported/platform 三字段', () => {
    const ipc = makeIpcMainMock();
    registerPowerBlockerHandler(
      ipc as unknown as Parameters<typeof registerPowerBlockerHandler>[0],
    );
    const s = ipc.invoke('pom:power-blocker-get') as { platform: string };
    expect(Object.keys(s).sort()).toEqual(['active', 'platform', 'supported']);
    expect(typeof s.platform).toBe('string');
  });

  it('set(true) 应生效，set(false) 应停止', () => {
    const ipc = makeIpcMainMock();
    registerPowerBlockerHandler(
      ipc as unknown as Parameters<typeof registerPowerBlockerHandler>[0],
    );
    expect((ipc.invoke('pom:power-blocker-set', true) as { active: boolean }).active).toBe(true);
    expect((ipc.invoke('pom:power-blocker-set', false) as { active: boolean }).active).toBe(false);
  });

  it('非 boolean 的真值（字符串/数字/对象）不应被当成开启', () => {
    const ipc = makeIpcMainMock();
    registerPowerBlockerHandler(
      ipc as unknown as Parameters<typeof registerPowerBlockerHandler>[0],
    );
    for (const v of ['false', 1, {}, [], null, undefined]) {
      expect((ipc.invoke('pom:power-blocker-set', v) as { active: boolean }).active).toBe(false);
    }
    expect(powerSaveBlocker.start).not.toHaveBeenCalled();
  });
});
