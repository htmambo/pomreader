/**
 * 书源 JS 文件 IPC handler（CRUD + 流式列表 + HTTP 代理 + eval）
 *
 * - 主目录 `<userData>/booksources/`；草稿 `<userData>/booksources_drafts/`
 * - 流式列表：setImmediate 后台扫描 + `app.emit('pom:booksource-batch')` 分批推送
 * - 写文件走 `atomicWrite`（FR-1.5：写入失败时原文件不被截断）
 * - HTTP 代理走 `safeNetRequest`（含 isPrivateHost SSRF 防护）
 */
import { app, IpcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { atomicWrite, safeFileName, scanDir } from './booksource-meta';
import { isCfChallenge } from './cf-guard';
import { safeNetRequest } from './safe-net';
import { cfFetchHtmlHidden } from './render-handler';

const PRIMARY_DIR = 'booksources';
const DRAFTS_DIR = 'booksources_drafts';
const BATCH_SIZE = 50;
const HTTP_TIMEOUT_MS = 15000;

function primaryDir(userData: string): string {
  return path.join(userData, PRIMARY_DIR);
}

function draftsDir(userData: string): string {
  return path.join(userData, DRAFTS_DIR);
}

/** 解析书源文件绝对路径；sourceDir 必须绝对路径 */
function resolvePath(
  userData: string,
  fileName: string,
  sourceDir: string | null | undefined
): string | null {
  const safe = safeFileName(fileName);
  if (!safe) return null;
  if (sourceDir) {
    if (!path.isAbsolute(sourceDir)) return null;
    return path.join(sourceDir, safe);
  }
  return path.join(primaryDir(userData), safe);
}

/** 解析目录：sourceDir 必须绝对，主目录自动创建 */
function resolveDir(userData: string, sourceDir: string | null | undefined): string | null {
  if (sourceDir) {
    if (!path.isAbsolute(sourceDir)) return null;
    return sourceDir;
  }
  const dir = primaryDir(userData);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readFileOrFail(p: string): string {
  if (!fs.existsSync(p)) {
    throw new Error(`文件不存在: ${p}`);
  }
  return fs.readFileSync(p, 'utf-8');
}

export function registerBookSourceHandler(ipcMain: IpcMain, userData: string): void {
  fs.mkdirSync(primaryDir(userData), { recursive: true });
  fs.mkdirSync(draftsDir(userData), { recursive: true });

  ipcMain.handle('pom:booksource-list', () => scanDir(primaryDir(userData)));

  // 流式列表：立刻返回，setImmediate 后台扫描 + 分批推送到 renderer（ASSUMPTION-15）
  // Round 2 修复：app.emit 不能跨进程，必须用 event.sender.send + isDestroyed 检查
  ipcMain.handle('pom:booksource-list-streaming', (e, requestId: string) => {
    const dir = primaryDir(userData);
    const sender = e.sender;
    const send = (payload: Record<string, unknown>): void => {
      if (sender.isDestroyed()) return;
      try { sender.send('pom:booksource-batch', payload); } catch { /* 窗口已销毁 */ }
    };
    setImmediate(() => {
      try {
        const items = scanDir(dir);
        const total = items.length;
        for (let i = 0; i < items.length; i += BATCH_SIZE) {
          send({ requestId, items: items.slice(i, i + BATCH_SIZE), done: false, total });
        }
        send({ requestId, items: [], done: true, total });
      } catch (err) {
        send({
          requestId,
          items: [],
          done: true,
          total: 0,
          error: (err as Error).message,
        });
      }
    });
  });

  ipcMain.handle(
    'pom:booksource-read',
    (_e, fileName: string, sourceDir?: string) => {
      const p = resolvePath(userData, fileName, sourceDir);
      if (!p) throw new Error('非法 fileName');
      return readFileOrFail(p);
    }
  );

  ipcMain.handle(
    'pom:booksource-save',
    (_e, fileName: string, content: string, sourceDir?: string) => {
      const dir = resolveDir(userData, sourceDir);
      if (!dir) throw new Error('sourceDir 必须是绝对路径');
      const safe = safeFileName(fileName);
      if (!safe) throw new Error('非法 fileName');
      fs.mkdirSync(dir, { recursive: true });
      atomicWrite(path.join(dir, safe), content);
    }
  );

  ipcMain.handle(
    'pom:booksource-delete',
    (_e, fileName: string, sourceDir?: string) => {
      const p = resolvePath(userData, fileName, sourceDir);
      if (!p) throw new Error('非法 fileName');
      if (fs.existsSync(p)) fs.unlinkSync(p);
      for (const suffix of ['.enabled', '.disabled']) {
        const m = p + suffix;
        if (fs.existsSync(m)) fs.unlinkSync(m);
      }
    }
  );

  ipcMain.handle(
    'pom:booksource-toggle',
    (_e, fileName: string, enabled: boolean, sourceDir?: string) => {
      const dir = resolveDir(userData, sourceDir);
      if (!dir) throw new Error('sourceDir 必须是绝对路径');
      const safe = safeFileName(fileName);
      if (!safe) throw new Error('非法 fileName');
      const enabledMarker = path.join(dir, safe + '.enabled');
      const disabledMarker = path.join(dir, safe + '.disabled');
      if (fs.existsSync(enabledMarker)) fs.unlinkSync(enabledMarker);
      if (fs.existsSync(disabledMarker)) fs.unlinkSync(disabledMarker);
      atomicWrite(enabled ? enabledMarker : disabledMarker, '');
    }
  );

  ipcMain.handle(
    'pom:booksource-save-draft',
    (_e, fileName: string, content: string) => {
      const safe = safeFileName(fileName);
      if (!safe) throw new Error('非法 fileName');
      const dir = draftsDir(userData);
      fs.mkdirSync(dir, { recursive: true });
      atomicWrite(path.join(dir, safe), content);
    }
  );

  // 书源 HTTP 代理（沙箱 legado.http 走这里）
  ipcMain.handle(
    'pom:booksource-http-proxy',
    async (
      _e,
      request: {
        url: string;
        method?: string;
        headers?: Record<string, string>;
        body?: string | null;
      }
    ) => {
      const doRequest = () =>
        safeNetRequest(request.url, {
          method: request.method,
          headers: request.headers,
          body: request.body ?? null,
          timeoutMs: HTTP_TIMEOUT_MS,
          accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
        });
      let result = await doRequest();
      let challenged = isCfChallenge(result.status, result.headers, result.body.slice(0, 4096));
      // Tier 1：CF 挑战 → 隐藏窗口真实加载 + 提取 HTML（仅对 GET 类页面有意义；
      // POST 表单/带 body 的接口跳过，自动让 Tier 2 弹窗引导）
      if (
        challenged &&
        (!request.method || request.method === 'GET') &&
        !request.body
      ) {
        const html = await cfFetchHtmlHidden(request.url);
        if (html) {
          result = {
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
            body: html,
            bytes: Buffer.from(html, 'utf8'),
          };
          challenged = false;
        }
      }
      // 仍是挑战（交互式 Turnstile）：标记 cfChallenge，由渲染端引导用户人工过盾（Tier 2）
      return {
        status: result.status,
        headers: result.headers,
        body: result.body,
        ...(challenged ? { cfChallenge: true } : {}),
      };
    }
  );

  // eval（健康检测 / 调试）：主进程仅返回文件路径；实际沙箱执行在 Renderer Worker（T-002）
  ipcMain.handle('pom:booksource-eval', (_e, fileName: string, _code?: string) => {
    const p = resolvePath(userData, fileName, null);
    if (!p) throw new Error('非法 fileName');
    if (!fs.existsSync(p)) throw new Error(`书源文件不存在: ${fileName}`);
    return p;
  });
}