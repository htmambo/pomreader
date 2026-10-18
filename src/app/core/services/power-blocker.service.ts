import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import { SettingsService } from './settings.service';

/** 主进程 powerSaveBlocker 上报的幂等状态（与 electron/ipc/power-blocker.ts 的 PowerBlockerState 同构） */
export interface PowerBlockerState {
  /** 当前是否真正持有唤醒锁 */
  active: boolean;
  /** 平台是否接受该请求（非 systemd Linux 为 false） */
  supported: boolean;
  /** 展示用平台标签 */
  platform: string;
}

const NO_IPC: PowerBlockerState = { active: false, supported: false, platform: '' };

/**
 * PowerBlockerService — 阅读时阻止系统睡眠 / 息屏 / 自动锁屏
 *
 * 阅读页进入时 acquire()、离开时 release()；最终是否申请唤醒锁 = 阅读页激活 && 设置项开启。
 * 真正的主进程调用是幂等的（见 electron/ipc/power-blocker.ts），本 service 额外做：
 * - 串行化：sync 进行中到达的新目标排队重跑，避免 acquire/release 快速交替时竞态
 * - 期望态缓存：目标未变化直接短路，设置项 signal 变动不重复打 IPC
 * - 启动对账：渲染端重建（reload / 窗口重建）时以主进程实际状态纠正遗留持锁
 * - 浏览器降级：ng serve 下无 pomAPI 时静默失效，不抛错打断阅读
 */
@Injectable({ providedIn: 'root' })
export class PowerBlockerService {
  private readonly settingsService = inject(SettingsService);

  /** 是否正持有唤醒锁（与主进程状态同步，供 UI 展示） */
  readonly active = signal(false);
  /** 平台是否支持；false 时设置项仍可见但不生效 */
  readonly supported = signal(true);
  /** 平台展示名（Windows / macOS / Linux） */
  readonly platform = signal('');

  /** 阅读页当前是否激活 */
  private readerActive = false;
  /** 已下发给主进程的期望态，用于短路 */
  private desired = false;
  /** sync 重入保护 */
  private syncing = false;
  /** sync 期间产生的新目标，收尾时重跑一次 */
  private queued = false;
  /** 本地下发代数：sync 每驱动一次新期望态 +1；对账快照期间代数变化则快照作废 */
  private generation = 0;

  constructor() {
    // 阅读过程中切换设置项即时生效（无需退出重进阅读页）
    effect(() => {
      this.settingsService.settings().keepAwakeWhenReading;
      untracked(() => queueMicrotask(() => void this.sync()));
    });
    // 启动对账：渲染端可能因 reload / 窗口重建 / 崩溃恢复而新启，
    // 主进程却可能仍持有上一生命周期遗留的唤醒锁；以实际状态对齐 desired，
    // 与 target() 不一致时 sync 会下发一次纠正调用，一致时短路零开销。
    void this.reconcile();
  }

  /** 进入阅读页 */
  acquire(): void {
    this.readerActive = true;
    void this.sync();
  }

  /** 离开阅读页（幂等，可重复调用） */
  release(): void {
    this.readerActive = false;
    void this.sync();
  }

  /** 设置页 ngOnInit 用：读取平台能力，填充降级提示 */
  async refresh(): Promise<void> {
    const api = typeof window === 'undefined' ? undefined : window.pomAPI;
    if (!api?.powerBlockerGet) {
      this.supported.set(false);
      this.platform.set('');
      return;
    }
    try {
      this.apply(await api.powerBlockerGet());
    } catch {
      this.supported.set(false);
    }
  }

  /** 期望态 = 阅读页激活 && 设置开启 */
  private target(): boolean {
    return this.readerActive && this.settingsService.settings().keepAwakeWhenReading;
  }

  /** 启动对账：读主进程实际状态对齐 desired，渲染端重建时遗留的持锁由此释放 */
  private async reconcile(): Promise<void> {
    const api = typeof window === 'undefined' ? undefined : window.pomAPI;
    if (!api?.powerBlockerGet) return; // 浏览器调试：无对账对象，走 sync 的降级路径
    const gen = this.generation;
    try {
      const s = await api.powerBlockerGet();
      // 快照期间本地已驱动过状态（恰好进出阅读页）→ 旧快照作废，避免覆盖新期望态
      if (this.generation !== gen) return;
      this.apply(s);
      this.desired = s.active;
      void this.sync();
    } catch {
      // 对账失败不阻断启动；后续 acquire/release 仍会驱动状态
    }
  }

  private apply(s: PowerBlockerState): void {
    this.active.set(s.active);
    this.supported.set(s.supported);
    if (s.platform) this.platform.set(s.platform);
  }

  /** 串行化下发：并发调用排队，收尾时用最新目标重跑一次 */
  private async sync(): Promise<void> {
    if (this.syncing) {
      this.queued = true;
      return;
    }
    this.syncing = true;
    try {
      do {
        this.queued = false;
        const target = this.target();
        if (target === this.desired) return;
        this.desired = target;
        this.generation++;
        const api = typeof window === 'undefined' ? undefined : window.pomAPI;
        if (!api?.powerBlockerSet) {
          // 浏览器（ng serve）无主进程：记录期望态后静默失效，避免每次 effect 都重试
          this.supported.set(false);
          return;
        }
        try {
          this.apply(await api.powerBlockerSet(target));
        } catch {
          this.apply(NO_IPC);
        }
      } while (this.queued);
    } finally {
      this.syncing = false;
    }
  }
}
