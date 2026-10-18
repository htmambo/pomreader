/**
 * PowerBlockerService 测试 — 阅读时阻止系统睡眠/锁屏的渲染端编排
 *
 * 覆盖：
 * - 设置开启 + 进入阅读页 → 下发 set(true)
 * - 离开阅读页 → 下发 set(false)
 * - 设置关闭 → 进入阅读页也不下发（期望态短路）
 * - 无 pomAPI（浏览器 ng serve）→ 静默降级不抛错
 * - IPC 抛错 → 降级 supported=false，不影响阅读
 * - acquire/release 快速交替 → 最终态收敛，不残留
 * - refresh() 读取平台能力填充提示
 * - 启动对账：渲染端重建（reload/窗口重建）时纠正主进程遗留持锁
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import 'zone.js';
import { TestBed } from '@angular/core/testing';
import {
  BrowserDynamicTestingModule,
  platformBrowserDynamicTesting,
} from '@angular/platform-browser-dynamic/testing';
import { PowerBlockerService } from './power-blocker.service';
import { SettingsService } from './settings.service';

beforeAll(() => {
  TestBed.initTestEnvironment(BrowserDynamicTestingModule, platformBrowserDynamicTesting());
});

/** 记录 IPC 收到的目标序列，末尾值即「当前生效状态」 */
let calls: boolean[] = [];
/** 让下一次 powerBlockerSet 抛错，模拟主进程不可用 */
let setShouldThrow = false;

function stubApi(opts: { withGet?: boolean; getActive?: boolean } = {}): void {
  calls = [];
  (globalThis as unknown as { window: Window }).window = {
    pomAPI: {
      ...(opts.withGet === false
        ? {}
        : {
            powerBlockerGet: vi.fn(async () => ({
              active: opts.getActive === true,
              supported: true,
              platform: 'Linux',
            })),
          }),
      powerBlockerSet: vi.fn(async (active: boolean) => {
        if (setShouldThrow) throw new Error('ipc down');
        calls.push(active);
        return { active, supported: true, platform: 'Linux' };
      }),
    },
  } as unknown as Window;
}

/** 让 pending 的 microtask / effect 回调跑完 */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function makeService(): { power: PowerBlockerService; settings: SettingsService } {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [PowerBlockerService, SettingsService] });
  const power = TestBed.inject(PowerBlockerService);
  const settings = TestBed.inject(SettingsService);
  return { power, settings };
}

beforeEach(() => {
  localStorage.clear();
  setShouldThrow = false;
  stubApi();
});

describe('PowerBlockerService（阅读页生命周期）', () => {
  it('默认设置开启，进入阅读页应下发 set(true)', async () => {
    const { power, settings } = makeService();
    expect(settings.settings().keepAwakeWhenReading).toBe(true);

    // 同时是对账竞态的回归钉：acquire 抢在 reconcile 的 get 快照返回前驱动本地态，
    // 快照必须被 generation 守卫作废，否则此处会观察到重复的 set(true)
    power.acquire();
    await flush();

    expect(calls).toEqual([true]);
    expect(power.active()).toBe(true);
  });

  it('离开阅读页应下发 set(false)', async () => {
    const { power } = makeService();
    power.acquire();
    await flush();
    power.release();
    await flush();

    expect(calls).toEqual([true, false]);
    expect(power.active()).toBe(false);
  });

  it('设置关闭时进入阅读页不应申请唤醒锁', async () => {
    const { power, settings } = makeService();
    settings.update('keepAwakeWhenReading', false);

    power.acquire();
    await flush();

    expect(calls).toEqual([]);
    expect(power.active()).toBe(false);
  });

  it('设置已在阅读中关闭时，离开阅读页不应再产生多余 IPC 调用', async () => {
    const { power, settings } = makeService();
    power.acquire();
    await flush();
    // 阅读中关闭设置应立即释放（此时期望态已落到 false）
    settings.update('keepAwakeWhenReading', false);
    await flush();
    expect(calls).toEqual([true, false]);

    // release 后期望态未变 → 短路，不再打 IPC
    power.release();
    await flush();
    expect(calls).toEqual([true, false]);
    expect(power.active()).toBe(false);
  });

  it('阅读中切换设置项应即时下发（无需退出重进）', async () => {
    const { power, settings } = makeService();
    power.acquire();
    await flush();

    settings.update('keepAwakeWhenReading', false);
    await flush();
    expect(calls).toEqual([true, false]);

    settings.update('keepAwakeWhenReading', true);
    await flush();
    expect(calls).toEqual([true, false, true]);
  });

  it('反复 acquire/release 应收敛且不残留 blocker', async () => {
    const { power } = makeService();
    for (let i = 0; i < 3; i++) {
      power.acquire();
      await flush();
      power.release();
      await flush();
    }
    expect(calls).toEqual([true, false, true, false, true, false]);
    expect(power.active()).toBe(false);
  });

  it('release 幂等：未 acquire 直接 release 不应下发', async () => {
    const { power } = makeService();
    power.release();
    power.release();
    await flush();
    expect(calls).toEqual([]);
  });
});

describe('PowerBlockerService（启动对账）', () => {
  it('主进程无遗留持锁时，启动不应产生任何 IPC', async () => {
    makeService();
    await flush();
    expect(calls).toEqual([]);
  });

  it('渲染端重建（reload/窗口重建）时主进程仍持锁 → 应下发纠正 set(false)', async () => {
    stubApi({ getActive: true });
    const { power } = makeService();
    await flush();

    expect(calls).toEqual([false]);
    expect(power.active()).toBe(false);
  });

  it('对账释放遗留锁后，进入阅读页仍应正常申请', async () => {
    stubApi({ getActive: true });
    const { power } = makeService();
    await flush();
    expect(calls).toEqual([false]);

    power.acquire();
    await flush();
    expect(calls).toEqual([false, true]);
    expect(power.active()).toBe(true);
  });
});

describe('PowerBlockerService（降级）', () => {
  it('无 pomAPI（浏览器调试）应静默失效不抛错', async () => {
    (globalThis as unknown as { window: Window }).window = {} as Window;
    const { power } = makeService();

    expect(() => {
      power.acquire();
      power.release();
    }).not.toThrow();
    await flush();
    expect(power.supported()).toBe(false);
    expect(power.active()).toBe(false);
  });

  it('IPC 抛错应降级 supported=false，不影响阅读流程', async () => {
    setShouldThrow = true;
    const { power } = makeService();
    power.acquire();
    await flush();
    expect(power.supported()).toBe(false);
    expect(power.active()).toBe(false);
  });

  it('refresh 应读取平台能力用于提示文案', async () => {
    const { power } = makeService();
    await power.refresh();
    expect(power.supported()).toBe(true);
    expect(power.platform()).toBe('Linux');
  });

  it('无 powerBlockerGet 时 refresh 应标记不支持', async () => {
    stubApi({ withGet: false });
    const { power } = makeService();
    await power.refresh();
    expect(power.supported()).toBe(false);
  });
});
