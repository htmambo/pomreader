/**
 * DB 隐藏窗口页面脚本（esbuild 打包为 dist-electron/db-renderer.js，不走 Angular 构建）
 *
 * 本窗口以 file:// 加载，持有全应用唯一的 PouchDB(IndexedDB) 实例：
 * - Chromium 把所有 file:// 页面的 IndexedDB 归入同一 origin 桶，
 *   因此 dev:file 主窗口、打包版主窗口与本窗口天然共享同一份历史书库；
 * - HMR 主窗口（http://localhost:4200）通过 IPC 把 DB 操作委托到本窗口，
 *   从而三种运行方式读写同一份数据。
 *
 * 协议：主进程转发 { id, op, args }（pom:db-exec）→ 执行 PouchDB 调用
 * → 回送 { id, ok, result|error }（pom:db-result）。
 */
import { ipcRenderer } from 'electron';
import PouchDB from 'pouchdb-browser';

const DB_NAME = 'pomreader';

/** 允许渲染端调用的 PouchDB 方法白名单（渲染端 DbService 只用这 5 个） */
const ALLOWED_OPS = new Set(['allDocs', 'get', 'put', 'bulkDocs', 'destroy']);

interface DbExecPayload {
  id: number;
  op: string;
  args: unknown[];
}

const db = new PouchDB(DB_NAME);

ipcRenderer.on('pom:db-exec', async (_event, payload: DbExecPayload) => {
  const { id, op, args } = payload;
  if (!ALLOWED_OPS.has(op)) {
    ipcRenderer.send('pom:db-result', {
      id,
      ok: false,
      error: { name: 'forbidden', message: `db op not allowed: ${op}` },
    });
    return;
  }
  try {
    const fn = (db as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[op];
    const result = await fn.apply(db, args);
    ipcRenderer.send('pom:db-result', { id, ok: true, result: result ?? null });
  } catch (e) {
    // PouchDB 错误 {status, name, message} 需原样传回：渲染端靠 status 判定 404/409
    const err = e as { status?: number; name?: string; message?: string };
    ipcRenderer.send('pom:db-result', {
      id,
      ok: false,
      error: {
        status: err?.status,
        name: err?.name ?? 'error',
        message: err?.message ?? String(e),
      },
    });
  }
});

// 监听器注册完毕后通知主进程（pom:db-request 在 ready 前会排队等待）
ipcRenderer.send('pom:db-ready');
