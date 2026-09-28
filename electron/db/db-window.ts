/**
 * DB 隐藏窗口管理 + IPC 中继（主进程侧）
 *
 * 链路：渲染端 pomAPI.dbRequest(op, args)
 *   → ipcMain.handle('pom:db-request')（本模块）
 *   → 分配 id 转发 'pom:db-exec' 给 DB 隐藏窗口
 *   ← 'pom:db-result' 按 id 匹配，resolve 渲染端的 invoke
 *
 * DB 窗口懒创建；崩溃/关闭时在途请求全部 reject，下一次请求自动重建。
 */
import { BrowserWindow, IpcMain } from 'electron';
import * as path from 'path';

/** bulkDocs 可能携带整本书正文（数十 MB 序列化），超时给足余量 */
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

interface DbResultPayload {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: { status?: number; name?: string; message?: string };
}

interface PendingRequest {
  resolve: (v: { ok: boolean; result?: unknown; error?: unknown }) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

let dbWindow: BrowserWindow | null = null;
let readyResolve: (() => void) | null = null;
let readyPromise: Promise<void> = new Promise((r) => {
  readyResolve = r;
});
let seq = 0;
const pending = new Map<number, PendingRequest>();

function createDbWindow(): void {
  dbWindow = new BrowserWindow({
    show: false,
    width: 400,
    height: 300,
    webPreferences: {
      // 本地静态页（无远程内容），需要 require('electron') 访问 ipcRenderer
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
      // 隐藏窗口默认被 Chromium 降频（定时器 1Hz），DB 操作必须保持全速
      backgroundThrottling: false,
    },
  });
  // 必须 file:// 加载：Chromium 把 file:// 的 IndexedDB 归入单一 origin 桶，
  // 与 dev:file / 打包版主窗口共享同一份书库存储
  // （__dirname = dist-electron/db/，html 与 db-renderer.js 位于上一级）
  void dbWindow.loadFile(path.join(__dirname, '..', 'db-window.html'));
  dbWindow.on('closed', () => {
    dbWindow = null;
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error('db window closed unexpectedly'));
    }
    pending.clear();
    // 重置 ready：下次 pom:db-request 会重建窗口并等待新的 ready
    readyPromise = new Promise((r) => {
      readyResolve = r;
    });
  });
}

export function registerDbHandler(ipcMain: IpcMain): void {
  ipcMain.on('pom:db-ready', (event) => {
    if (event.sender !== dbWindow?.webContents) return;
    readyResolve?.();
  });

  ipcMain.on('pom:db-result', (event, payload: DbResultPayload) => {
    if (event.sender !== dbWindow?.webContents) return;
    const p = pending.get(payload.id);
    if (!p) return;
    pending.delete(payload.id);
    clearTimeout(p.timer);
    p.resolve(
      payload.ok ? { ok: true, result: payload.result } : { ok: false, error: payload.error },
    );
  });

  ipcMain.handle('pom:db-request', async (_event, op: string, args: unknown[]) => {
    if (!dbWindow) createDbWindow();
    await readyPromise;
    const id = ++seq;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`db request timeout: ${op}`));
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      dbWindow?.webContents.send('pom:db-exec', { id, op, args });
    });
  });
}
