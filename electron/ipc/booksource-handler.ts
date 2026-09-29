/**
 * 书源 JS 文件 IPC handler（CRUD + 流式列表 + HTTP 代理 + eval）
 *
 * - 主目录 `<userData>/booksources/`；草稿 `<userData>/booksources_drafts/`
 * - 流式列表：setImmediate 后台扫描 + `app.emit('pom:booksource-batch')` 分批推送
 * - 写文件走 `atomicWrite`（FR-1.5：写入失败时原文件不被截断）
 * - HTTP 代理走 `safeNetRequest`（含 isPrivateHost SSRF 防护）
 */
import { IpcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import {
  atomicWrite,
  safeFileName,
  safeJsonFileName,
  scanDir,
  scanJsonDir,
  validateBookSourceDocStructure,
} from './booksource-meta';
import { isCfChallenge } from './cf-guard';
import { safeNetRequest } from './safe-net';
import { cfFetchHtmlHidden } from './render-handler';
import {
  safeHandleWithMeta,
  BooksourceDeleteJsonArgsSchema,
  BooksourceListJsonArgsSchema,
  BooksourceListJsonStreamingArgsSchema,
  BooksourceSaveJsonArgsSchema,
  BooksourceToggleJsonArgsSchema,
} from './schema';

const PRIMARY_DIR = 'booksources';
const DRAFTS_DIR = 'booksources_drafts';
const BATCH_SIZE = 50;
const HTTP_TIMEOUT_MS = 15000;
/** JSON 书源流式列表的批次事件 channel（与 .js 的 'pom:booksource-batch' 隔离） */
const JSON_BATCH_CHANNEL = 'pom:booksource-json-batch';

function primaryDir(userData: string): string {
  return path.join(userData, PRIMARY_DIR);
}

function draftsDir(userData: string): string {
  return path.join(userData, DRAFTS_DIR);
}

/** 解析书源文件绝对路径；sourceDir 必须绝对路径 */
export function resolvePath(
  userData: string,
  fileName: string,
  sourceDir: string | null | undefined,
): string | null {
  const safe = safeFileName(fileName);
  if (!safe) return null;
  if (sourceDir) {
    if (!path.isAbsolute(sourceDir)) return null;
    return path.join(sourceDir, safe);
  }
  return path.join(primaryDir(userData), safe);
}

/** 同 resolvePath，但 fileName 必须 `.json` 结尾（JSON 书源链路专用） */
export function resolveJsonPath(
  userData: string,
  fileName: string,
  sourceDir: string | null | undefined,
): string | null {
  const safe = safeJsonFileName(fileName);
  if (!safe) return null;
  if (sourceDir) {
    if (!path.isAbsolute(sourceDir)) return null;
    return path.join(sourceDir, safe);
  }
  return path.join(primaryDir(userData), safe);
}

/** 解析目录：sourceDir 必须绝对，主目录自动创建 */
export function resolveDir(userData: string, sourceDir: string | null | undefined): string | null {
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
      try {
        sender.send('pom:booksource-batch', payload);
      } catch {
        /* 窗口已销毁 */
      }
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

  ipcMain.handle('pom:booksource-read', (_e, fileName: string, sourceDir?: string) => {
    const p = resolvePath(userData, fileName, sourceDir);
    if (!p) throw new Error('非法 fileName');
    return readFileOrFail(p);
  });

  /* ── JSON 书源（BookSourceDoc）channel（方案 §3.4，P2 新增；旧 .js channel 不动） ──
   * read 复用 pom:booksource-read（按 fileName 读任意文件，.json 天然可用）；
   * 草稿复用 pom:booksource-save-draft（同样按 fileName 通用），均不新增。 */

  safeHandleWithMeta(
    ipcMain,
    'pom:booksource-list-json',
    'BooksourceListJsonArgs',
    BooksourceListJsonArgsSchema,
    () => scanJsonDir(primaryDir(userData)),
  );

  // JSON 流式列表：镜像 pom:booksource-list-streaming，批次事件走独立 channel
  safeHandleWithMeta(
    ipcMain,
    'pom:booksource-list-json-streaming',
    'BooksourceListJsonStreamingArgs',
    BooksourceListJsonStreamingArgsSchema,
    (e, [requestId]) => {
      const dir = primaryDir(userData);
      const sender = e.sender;
      const send = (payload: Record<string, unknown>): void => {
        if (sender.isDestroyed()) return;
        try {
          sender.send(JSON_BATCH_CHANNEL, payload);
        } catch {
          /* 窗口已销毁 */
        }
      };
      setImmediate(() => {
        try {
          const items = scanJsonDir(dir);
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
    },
  );

  // 保存 JSON 书源：入参过 valibot（探针）+ 结构校验（必填存在性），内容 JSON.stringify(doc, null, 2)
  safeHandleWithMeta(
    ipcMain,
    'pom:booksource-save-json',
    'BooksourceSaveJsonArgs',
    BooksourceSaveJsonArgsSchema,
    (_e, [fileName, doc, sourceDir]) => {
      const dir = resolveDir(userData, sourceDir);
      if (!dir) throw new Error('sourceDir 必须是绝对路径');
      const safe = safeJsonFileName(fileName);
      if (!safe) throw new Error('非法 fileName（必须 .json 结尾）');
      const reason = validateBookSourceDocStructure(doc);
      if (reason) throw new Error(`书源文档结构非法: ${reason}`);
      fs.mkdirSync(dir, { recursive: true });
      atomicWrite(path.join(dir, safe), JSON.stringify(doc, null, 2));
    },
  );

  // 启停：读 → 改文档内 enabled 字段 → atomicWrite 回写（JSON 源不再用 marker 文件）
  safeHandleWithMeta(
    ipcMain,
    'pom:booksource-toggle-json',
    'BooksourceToggleJsonArgs',
    BooksourceToggleJsonArgsSchema,
    (_e, [fileName, enabled, sourceDir]) => {
      const p = resolveJsonPath(userData, fileName, sourceDir);
      if (!p) throw new Error('非法 fileName（必须 .json 结尾）');
      const doc = JSON.parse(readFileOrFail(p)) as Record<string, unknown>;
      doc.enabled = enabled;
      atomicWrite(p, JSON.stringify(doc, null, 2));
    },
  );

  // 删除：只删 .json 本体（JSON 源没有 marker，无 marker 清理）
  safeHandleWithMeta(
    ipcMain,
    'pom:booksource-delete-json',
    'BooksourceDeleteJsonArgs',
    BooksourceDeleteJsonArgsSchema,
    (_e, [fileName, sourceDir]) => {
      const p = resolveJsonPath(userData, fileName, sourceDir);
      if (!p) throw new Error('非法 fileName（必须 .json 结尾）');
      if (fs.existsSync(p)) fs.unlinkSync(p);
    },
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
    },
  );

  ipcMain.handle('pom:booksource-delete', (_e, fileName: string, sourceDir?: string) => {
    const p = resolvePath(userData, fileName, sourceDir);
    if (!p) throw new Error('非法 fileName');
    if (fs.existsSync(p)) fs.unlinkSync(p);
    for (const suffix of ['.enabled', '.disabled']) {
      const m = p + suffix;
      if (fs.existsSync(m)) fs.unlinkSync(m);
    }
  });

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
    },
  );

  ipcMain.handle('pom:booksource-save-draft', (_e, fileName: string, content: string) => {
    const safe = safeFileName(fileName);
    if (!safe) throw new Error('非法 fileName');
    const dir = draftsDir(userData);
    fs.mkdirSync(dir, { recursive: true });
    atomicWrite(path.join(dir, safe), content);
  });

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
      },
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
      if (challenged && (!request.method || request.method === 'GET') && !request.body) {
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
    },
  );

  // eval（健康检测 / 调试）：主进程仅返回文件路径；实际沙箱执行在 Renderer Worker（T-002）
  ipcMain.handle('pom:booksource-eval', (_e, fileName: string, _code?: string) => {
    const p = resolvePath(userData, fileName, null);
    if (!p) throw new Error('非法 fileName');
    if (!fs.existsSync(p)) throw new Error(`书源文件不存在: ${fileName}`);
    return p;
  });
}
