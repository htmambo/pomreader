import { IpcMain, WebContents, powerSaveBlocker } from 'electron';

/**
 * 防睡眠 / 防锁屏（Electron powerSaveBlocker 封装）
 *
 * 平台机制（Electron → Chromium device::mojom::WakeLock → OS 原生唤醒锁）：
 * - Windows：SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED)
 *   标志 thread-sticky，由 Chromium 常驻线程持有；同时重置屏保空闲计时器 → 自动锁屏被压制
 * - macOS：IOPMAssertionCreateWithName(kIOPMNoDisplaySleepAssertion)，合盖（硬件传感器）除外
 * - Linux：logind DBus org.freedesktop.login1.Manager.Inhibit(what=idle:sleep)；
 *   无 logind 的桌面环境调用失败 → supported=false，渲染端降级提示
 *
 * 选 prevent-display-sleep 而非 prevent-app-suspension：后者允许关屏，
 * 空闲屏保/锁屏仍会触发，达不到「阅读时不锁屏」的目标。
 */

/** 主进程单例 blocker id；null = 当前未持有唤醒锁 */
let blockerId: number | null = null;
/** start() 是否被系统接受；无 logind 的 Linux 会抛错 → false */
let supported = true;

export interface PowerBlockerState {
  /** 当前是否真正持有唤醒锁（幂等语义下由 getState 兜底校正） */
  active: boolean;
  /** 平台是否接受该请求；false 时设置项可见但不生效 */
  supported: boolean;
  /** 展示用平台标签 */
  platform: string;
}

/** 平台展示名（UI 文案直接用，避免渲染端再维护一份映射） */
function platformLabel(): string {
  switch (process.platform) {
    case 'win32':
      return 'Windows';
    case 'darwin':
      return 'macOS';
    case 'linux':
      return 'Linux';
    default:
      return process.platform;
  }
}

/** 查询当前状态；顺带清理被系统单方面释放的失效 id */
export function getState(): PowerBlockerState {
  if (blockerId !== null && !powerSaveBlocker.isStarted(blockerId)) blockerId = null;
  return { active: blockerId !== null, supported, platform: platformLabel() };
}

/** 申请唤醒锁；已持有时直接返回，不重复 start（否则每次调用泄漏一个 blocker id） */
function startBlocker(): PowerBlockerState {
  if (getState().active) return getState();
  try {
    blockerId = powerSaveBlocker.start('prevent-display-sleep');
    supported = true;
  } catch {
    blockerId = null;
    supported = false;
  }
  return getState();
}

/** 释放唤醒锁；未持有时为空操作。先清引用再 stop：stop 即使抛错也不会遗留失控 id */
function stopBlocker(): PowerBlockerState {
  if (blockerId !== null) {
    const id = blockerId;
    blockerId = null;
    powerSaveBlocker.stop(id);
  }
  return getState();
}

/**
 * 渲染端消失兜底：窗口关闭 / 渲染进程崩溃时 ngOnDestroy 不会执行，
 * 唤醒锁必须由主进程自己收回，否则机器保持常亮直到应用退出。
 * 普通 reload 不触发这两个事件，由渲染端启动对账（PowerBlockerService.reconcile）纠正。
 */
export function watchWebContents(wc: WebContents): void {
  wc.once('destroyed', stopBlocker);
  wc.on('render-process-gone', stopBlocker);
}

/** app 退出钩子调用：显式释放，避免系统停留在「被阻止休眠」状态 */
export function stopBlockerOnQuit(): void {
  stopBlocker();
}

/** 设置目标状态（幂等）；渲染端进入 / 离开阅读页调用 */
export function setActive(active: boolean): PowerBlockerState {
  return active ? startBlocker() : stopBlocker();
}

/** 单测用：重置模块级状态 */
export function __resetForTest(): void {
  blockerId = null;
  supported = true;
}

export function registerPowerBlockerHandler(ipcMain: IpcMain): void {
  ipcMain.handle('pom:power-blocker-get', () => getState());
  // 入参经 unknown 收敛后比较，避免渲染端传任意真值（如 'false' 字符串）被当成开启
  ipcMain.handle('pom:power-blocker-set', (_e, active: unknown) => setActive(active === true));
}
