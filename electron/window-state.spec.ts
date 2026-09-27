import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Mock electron BEFORE importing window-state
vi.mock('electron', () => ({
  screen: {
    getAllDisplays: vi.fn(() => [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }]),
  },
}));

import { loadWindowState } from './window-state';

/**
 * window-state spec — 窗口状态持久化（loadWindowState 纯函数）
 *
 * 覆盖：
 * - 文件缺失/损坏 → DEFAULT_STATE
 * - 数值越界（width/height < MIN 或 > 10000） → fallback 默认
 * - x/y 缺省 / 不可见 → 不写入 state.x/y
 * - isMaximized / isMinimized 仅接受严格 boolean
 * - 显示器可见性（≥100×100 重叠）
 */

describe('loadWindowState', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tmpDir: any;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'window-state-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('文件缺失应返回 DEFAULT_STATE', () => {
    const s = loadWindowState(tmpDir);
    expect(s.width).toBe(1200);
    expect(s.height).toBe(800);
    expect(s.isMaximized).toBe(false);
    expect(s.isMinimized).toBe(false);
    expect(s.x).toBeUndefined();
    expect(s.y).toBeUndefined();
  });

  it('合法 JSON 应正确解析', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'window-state.json'),
      JSON.stringify({
        width: 1400,
        height: 900,
        x: 100,
        y: 200,
        isMaximized: true,
        isMinimized: false,
      }),
    );
    const s = loadWindowState(tmpDir);
    expect(s.width).toBe(1400);
    expect(s.height).toBe(900);
    expect(s.isMaximized).toBe(true);
    expect(s.isMinimized).toBe(false);
  });

  it('损坏 JSON 应 fallback DEFAULT_STATE', () => {
    fs.writeFileSync(path.join(tmpDir, 'window-state.json'), '{broken json');
    const s = loadWindowState(tmpDir);
    expect(s.width).toBe(1200);
    expect(s.height).toBe(800);
  });

  it('width < MIN_WIDTH(400) 应 fallback 默认 width', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'window-state.json'),
      JSON.stringify({ width: 100, height: 800 }),
    );
    const s = loadWindowState(tmpDir);
    expect(s.width).toBe(1200); // default fallback
  });

  it('height < MIN_HEIGHT(300) 应 fallback 默认 height', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'window-state.json'),
      JSON.stringify({ width: 1200, height: 100 }),
    );
    const s = loadWindowState(tmpDir);
    expect(s.height).toBe(800); // default fallback
  });

  it('width > 10000 应 fallback 默认 width（防极端值）', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'window-state.json'),
      JSON.stringify({ width: 99999, height: 800 }),
    );
    const s = loadWindowState(tmpDir);
    expect(s.width).toBe(1200);
  });

  it('height 非有限数（NaN）应 fallback', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'window-state.json'),
      JSON.stringify({ width: 1200, height: 'not a number' }),
    );
    const s = loadWindowState(tmpDir);
    expect(s.height).toBe(800);
  });

  it('isMaximized / isMinimized 非 boolean 应严格判定 false', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'window-state.json'),
      JSON.stringify({
        width: 1200,
        height: 800,
        isMaximized: 'true', // 字符串而非 boolean
        isMinimized: 1, // 数字而非 boolean
      }),
    );
    const s = loadWindowState(tmpDir);
    expect(s.isMaximized).toBe(false); // 仅 === true 才 true
    expect(s.isMinimized).toBe(false);
  });

  it('x/y 缺省时不应写入（走默认仅尺寸）', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'window-state.json'),
      JSON.stringify({ width: 1200, height: 800 }),
    );
    const s = loadWindowState(tmpDir);
    expect(s.x).toBeUndefined();
    expect(s.y).toBeUndefined();
  });

  it('x/y 不可见时（屏外）应忽略', () => {
    // 显示器在 (0,0)-(1920,1080) → x=100000 屏外
    fs.writeFileSync(
      path.join(tmpDir, 'window-state.json'),
      JSON.stringify({ width: 1200, height: 800, x: 100000, y: 100000 }),
    );
    const s = loadWindowState(tmpDir);
    expect(s.x).toBeUndefined();
    expect(s.y).toBeUndefined();
  });

  it('x/y 可见时（与显示器重叠 ≥100×100）应保留', () => {
    // 默认 mock 显示器 (0,0)-(1920,1080)；窗口 (100,100) 1400x900 → 重叠 ≥100×100
    fs.writeFileSync(
      path.join(tmpDir, 'window-state.json'),
      JSON.stringify({ width: 1400, height: 900, x: 100, y: 100 }),
    );
    const s = loadWindowState(tmpDir);
    expect(s.x).toBe(100);
    expect(s.y).toBe(100);
  });

  it('x/y 类型错误（非 number）应忽略', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'window-state.json'),
      JSON.stringify({ width: 1200, height: 800, x: '100', y: '200' }),
    );
    const s = loadWindowState(tmpDir);
    expect(s.x).toBeUndefined();
    expect(s.y).toBeUndefined();
  });
});