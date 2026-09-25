/**
 * 窗口状态持久化（位置 / 尺寸 / 最大化 / 最小化）
 * 存 userData/window-state.json；启动时校验尺寸合法性 + 显示器可见性后应用
 * 复用 booksource-meta 的 atomicWrite（tmp + rename，防截断）
 *
 * 注意：Wayland 下 x/y 由合成器控制，getBounds() 位置可能恒为 0 ——
 * 位置恢复在 X11/Windows/macOS 生效，Wayland 自动退化为仅尺寸/状态恢复
 */
import { BrowserWindow, screen } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { atomicWrite } from './ipc/booksource-meta';

export interface WindowState {
  width: number;
  height: number;
  x?: number;
  y?: number;
  isMaximized: boolean;
  isMinimized: boolean;
}

const FILE_NAME = 'window-state.json';
const DEFAULT_STATE: WindowState = {
  width: 1200,
  height: 800,
  isMaximized: false,
  isMinimized: false,
};
const MIN_WIDTH = 400;
const MIN_HEIGHT = 300;
const SAVE_DEBOUNCE_MS = 500;

/** 尺寸合法性：数值且在合理范围内 */
function validDim(v: unknown, min: number): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= 10000;
}

/** 保存的位置在当前任一显示器上至少有 100×100 可见（防拔显示器后窗口丢到屏外） */
function isVisibleOnSomeDisplay(x: number, y: number, width: number, height: number): boolean {
  return screen.getAllDisplays().some((d) => {
    const b = d.bounds;
    const overlapX = Math.min(x + width, b.x + b.width) - Math.max(x, b.x);
    const overlapY = Math.min(y + height, b.y + b.height) - Math.max(y, b.y);
    return overlapX >= 100 && overlapY >= 100;
  });
}

/** 读取持久化的窗口状态；文件缺失/损坏/位置不可见时回退默认值 */
export function loadWindowState(userData: string): WindowState {
  try {
    const raw = fs.readFileSync(path.join(userData, FILE_NAME), 'utf-8');
    const s = JSON.parse(raw) as Partial<WindowState>;
    const state: WindowState = {
      width: validDim(s.width, MIN_WIDTH) ? s.width : DEFAULT_STATE.width,
      height: validDim(s.height, MIN_HEIGHT) ? s.height : DEFAULT_STATE.height,
      isMaximized: s.isMaximized === true,
      isMinimized: s.isMinimized === true,
    };
    if (
      typeof s.x === 'number' &&
      typeof s.y === 'number' &&
      isVisibleOnSomeDisplay(s.x, s.y, state.width, state.height)
    ) {
      state.x = s.x;
      state.y = s.y;
    }
    return state;
  } catch {
    return { ...DEFAULT_STATE };
  }
}

/** 监听窗口事件并持久化状态；resize/move 防抖，close 时保底直写 */
export function trackWindowState(win: BrowserWindow, userData: string): void {
  const file = path.join(userData, FILE_NAME);
  let timer: NodeJS.Timeout | null = null;

  const save = (): void => {
    if (win.isDestroyed()) return;
    // 最大化/最小化时用 normal bounds（还原后的尺寸），避免把全屏尺寸存成普通尺寸
    const b = win.getNormalBounds();
    const state: WindowState = {
      width: b.width,
      height: b.height,
      x: b.x,
      y: b.y,
      isMaximized: win.isMaximized(),
      isMinimized: win.isMinimized(),
    };
    try {
      atomicWrite(file, JSON.stringify(state, null, 2));
    } catch {
      /* 写失败不影响主流程 */
    }
  };

  const debounced = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(save, SAVE_DEBOUNCE_MS);
  };

  win.on('resize', debounced);
  win.on('move', debounced);
  win.on('maximize', debounced);
  win.on('unmaximize', debounced);
  win.on('minimize', debounced);
  win.on('restore', debounced);
  win.on('close', () => {
    if (timer) clearTimeout(timer);
    save();
  });
}
