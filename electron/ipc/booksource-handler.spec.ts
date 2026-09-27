import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Mock electron BEFORE importing booksource-handler (handler uses electron, but
// resolvePath / resolveDir are pure path/fs helpers that don't depend on electron)
vi.mock('electron', () => ({
  app: {},
  IpcMain: class {},
}));

import { resolvePath, resolveDir, registerBookSourceHandler } from './booksource-handler';

/**
 * booksource-handler spec — IPC handler 内的 path/fs helper 导出测试
 *
 * 覆盖：
 * - resolvePath：safeFileName + sourceDir 校验 + 主目录 fallback
 * - resolveDir：sourceDir 绝对路径校验 + 主目录自动创建
 *
 * 覆盖 booksource-handler.ts:30-54 关键契约（FR-1.5 防路径穿越）
 */

describe('resolvePath', () => {
   
  let tmpUserData: any;

  beforeEach(() => {
    tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-path-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpUserData, { recursive: true, force: true });
  });

  it('合法 fileName + 无 sourceDir 应返回 userData/booksources/<name>', () => {
    const p = resolvePath(tmpUserData, 'legado.js', null);
    expect(p).toBe(path.join(tmpUserData, 'booksources', 'legado.js'));
  });

  it('合法 fileName + undefined sourceDir 同上', () => {
    const p = resolvePath(tmpUserData, 'legado.js', undefined);
    expect(p).toBe(path.join(tmpUserData, 'booksources', 'legado.js'));
  });

  it('非法 fileName（../evil）应返回 null（FR-1.5）', () => {
    expect(resolvePath(tmpUserData, '../evil.js', null)).toBeNull();
  });

  it('非法 fileName（含 /）应返回 null', () => {
    expect(resolvePath(tmpUserData, 'foo/bar.js', null)).toBeNull();
  });

  it('非法 fileName（含 \\）应返回 null（Windows 路径分隔符）', () => {
    expect(resolvePath(tmpUserData, 'foo\\bar.js', null)).toBeNull();
  });

  it('空 fileName 应返回 null', () => {
    expect(resolvePath(tmpUserData, '', null)).toBeNull();
  });

  it('绝对路径 sourceDir 应使用 sourceDir + fileName', () => {
    const customDir = path.join(tmpUserData, 'custom');
    fs.mkdirSync(customDir, { recursive: true });
    const p = resolvePath(tmpUserData, 'x.js', customDir);
    expect(p).toBe(path.join(customDir, 'x.js'));
  });

  it('相对路径 sourceDir 应返回 null（防目录穿越）', () => {
    expect(resolvePath(tmpUserData, 'x.js', './relative')).toBeNull();
    expect(resolvePath(tmpUserData, 'x.js', 'relative/path')).toBeNull();
  });
});

describe('resolveDir', () => {
   
  let tmpUserData: any;

  beforeEach(() => {
    tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-dir-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpUserData, { recursive: true, force: true });
  });

  it('无 sourceDir 应自动创建并返回 userData/booksources', () => {
    expect(fs.existsSync(path.join(tmpUserData, 'booksources'))).toBe(false);
    const d = resolveDir(tmpUserData, null);
    expect(d).toBe(path.join(tmpUserData, 'booksources'));
    expect(fs.existsSync(d)).toBe(true);
  });

  it('重复调用 resolveDir 应幂等（mkdirSync recursive）', () => {
    const d1 = resolveDir(tmpUserData, null);
    const d2 = resolveDir(tmpUserData, null);
    expect(d1).toBe(d2);
    expect(fs.existsSync(d2)).toBe(true);
  });

  it('绝对路径 sourceDir 应原样返回（不 mkdir）', () => {
    const customDir = path.join(tmpUserData, 'external');
    const d = resolveDir(tmpUserData, customDir);
    expect(d).toBe(customDir);
    expect(fs.existsSync(customDir)).toBe(false); // 未自动创建
  });

  it('相对路径 sourceDir 应返回 null', () => {
    expect(resolveDir(tmpUserData, 'relative')).toBeNull();
    expect(resolveDir(tmpUserData, '../escape')).toBeNull();
  });
});

describe('pom:booksource-save — .bak 备份与删除清理', () => {
  let tmpUserData: string;

  beforeEach(() => {
    tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'pom-booksource-save-'));
  });

  afterEach(() => {
    fs.rmSync(tmpUserData, { recursive: true, force: true });
  });

  type Handler = (e: null, ...args: unknown[]) => unknown;

  /** 注册 handler 并捕获 ipcMain.handle 回调表 */
  function register(): Map<string, Handler> {
    const handlers = new Map<string, Handler>();
    const ipcMain = {
      handle: (channel: string, fn: Handler) => {
        handlers.set(channel, fn);
      },
    };
    registerBookSourceHandler(ipcMain as never, tmpUserData);
    return handlers;
  }

  it('覆盖保存前把旧内容留为 .bak；首次保存不产生 .bak', () => {
    const handlers = register();
    const save = handlers.get('pom:booksource-save')!;
    const dir = path.join(tmpUserData, 'booksources');
    save(null, 'a.js', 'v1', undefined);
    expect(fs.existsSync(path.join(dir, 'a.js.bak'))).toBe(false);
    save(null, 'a.js', 'v2', undefined);
    expect(fs.readFileSync(path.join(dir, 'a.js'), 'utf-8')).toBe('v2');
    expect(fs.readFileSync(path.join(dir, 'a.js.bak'), 'utf-8')).toBe('v1');
  });

  it('删除书源时连同 .bak 一起清理', () => {
    const handlers = register();
    const save = handlers.get('pom:booksource-save')!;
    const del = handlers.get('pom:booksource-delete')!;
    const dir = path.join(tmpUserData, 'booksources');
    save(null, 'a.js', 'v1', undefined);
    save(null, 'a.js', 'v2', undefined);
    expect(fs.existsSync(path.join(dir, 'a.js.bak'))).toBe(true);
    del(null, 'a.js', undefined);
    expect(fs.existsSync(path.join(dir, 'a.js'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'a.js.bak'))).toBe(false);
  });
});