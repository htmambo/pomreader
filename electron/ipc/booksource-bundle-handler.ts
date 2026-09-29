/**
 * 书源导入/导出 bundle IPC handler（设计 §5.1/§5.2，Phase 1 备份还原）
 *
 * - pom:booksource-bundle-export(fileNames[])：读 booksources 目录 → buildBundle
 *   → showSaveDialog（默认 pomreader-sources-YYYY-MM-DD.json）→ atomicWrite
 *   → 返回 { path, count }；用户取消返回 null
 * - pom:booksource-bundle-open()：showOpenDialog → parseBundle（失败返回错误信息，
 *   不抛穿 IPC）→ diffBundle（无 baseline，本地导入不产 conflict）→ 返回
 *   { error: string | null, entries: DiffEntry[] }；取消返回 null
 * - pom:booksource-bundle-apply(decisions[])：写前全量预校验（safeJsonFileName +
 *   inspectBundleSource，任一项不过则整体拒绝不动笔，§8 取舍 1）→ 逐条 atomicWrite
 *   （enabled 内联在 content，无 marker）→ 失败项收集进 failed 报告（不回滚）
 *   → sender.send('pom:booksource-updated', { source: 'bundle-import', count })
 */
import { app, BrowserWindow, dialog, IpcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { atomicWrite, safeJsonFileName } from './booksource-meta';
import { resolveJsonPath } from './booksource-handler';
import {
  BUNDLE_MAX_BYTES,
  buildBundle,
  BundleSourceEntry,
  DiffEntry,
  diffBundle,
  inspectBundleSource,
  parseBundle,
  serializeBundle,
} from './booksource-bundle';
import {
  safeHandleWithMeta,
  BooksourceBundleApplyArgsSchema,
  BooksourceBundleExportArgsSchema,
  BooksourceBundleOpenArgsSchema,
} from './schema';

const UPDATED_CHANNEL = 'pom:booksource-updated';

export interface BundleExportResult {
  path: string;
  count: number;
}

export interface BundleOpenResult {
  error: string | null;
  entries: DiffEntry[];
}

export interface BundleApplyResult {
  written: string[];
  failed: { fileName: string; error: string }[];
}

function ymd(date: Date): string {
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${m}-${d}`;
}

/**
 * 读本地 booksources 目录现状（diff 的 local 侧）。uuid 口径与内核一致：
 * doc.uuid ?? 带扩展名 fileName；本地损坏文件 uuid 回退 fileName，仍参与 fileName 兜底匹配。
 */
function readLocalSources(dir: string): BundleSourceEntry[] {
  if (!fs.existsSync(dir)) return [];
  const out: BundleSourceEntry[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.json') continue;
    let content: string;
    try {
      content = fs.readFileSync(path.join(dir, entry.name), 'utf-8');
    } catch {
      continue;
    }
    let uuid = entry.name;
    try {
      const doc = JSON.parse(content) as Record<string, unknown>;
      if (typeof doc.uuid === 'string' && doc.uuid) uuid = doc.uuid;
    } catch {
      /* 本地损坏 JSON：uuid 回退 fileName */
    }
    out.push({ uuid, fileName: entry.name, content });
  }
  return out;
}

export function registerBookSourceBundleHandler(
  ipcMain: IpcMain,
  userData: string,
  getWindow: () => BrowserWindow | null,
): void {
  const sourcesDir = (): string => path.join(userData, 'booksources');

  safeHandleWithMeta(
    ipcMain,
    'pom:booksource-bundle-export',
    'BooksourceBundleExportArgs',
    BooksourceBundleExportArgsSchema,
    async (_e, [fileNames]) => {
      const items = fileNames.map((fileName) => {
        const p = resolveJsonPath(userData, fileName, null);
        if (!p) throw new Error(`非法 fileName: ${fileName}`);
        if (!fs.existsSync(p)) throw new Error(`书源文件不存在: ${fileName}`);
        return { fileName, content: fs.readFileSync(p, 'utf-8') };
      });
      const bundle = buildBundle(items, { app: app.getVersion() });
      const text = serializeBundle(bundle);
      if (Buffer.byteLength(text, 'utf-8') > BUNDLE_MAX_BYTES) {
        throw new Error('bundle 超过 20MB 上限，请分批导出');
      }
      const win = getWindow();
      if (!win) return null;
      const { canceled, filePath } = await dialog.showSaveDialog(win, {
        title: '导出书源',
        defaultPath: `pomreader-sources-${ymd(new Date())}.json`,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (canceled || !filePath) return null;
      atomicWrite(filePath, text);
      const result: BundleExportResult = { path: filePath, count: bundle.sources.length };
      return result;
    },
  );

  safeHandleWithMeta(
    ipcMain,
    'pom:booksource-bundle-open',
    'BooksourceBundleOpenArgs',
    BooksourceBundleOpenArgsSchema,
    async () => {
      const win = getWindow();
      if (!win) return null;
      const { canceled, filePaths } = await dialog.showOpenDialog(win, {
        title: '导入书源',
        filters: [{ name: 'JSON', extensions: ['json'] }],
        properties: ['openFile'],
      });
      if (canceled || filePaths.length === 0) return null;
      let text: string;
      try {
        text = fs.readFileSync(filePaths[0], 'utf-8');
      } catch (err) {
        return { error: `读取文件失败: ${(err as Error).message}`, entries: [] };
      }
      let sources: BundleSourceEntry[];
      try {
        sources = parseBundle(text).sources;
      } catch (err) {
        // 整体拒绝（§4.3）：原因带回渲染端提示，不抛穿 IPC
        return { error: (err as Error).message, entries: [] };
      }
      // 本地导入无 baseline：只产 new / identical / update（§5.3）
      const entries = diffBundle(sources, readLocalSources(sourcesDir()));
      const result: BundleOpenResult = { error: null, entries };
      return result;
    },
  );

  safeHandleWithMeta(
    ipcMain,
    'pom:booksource-bundle-apply',
    'BooksourceBundleApplyArgs',
    BooksourceBundleApplyArgsSchema,
    (e, [decisions]) => {
      // 写前全量预校验（§8 取舍 1）：safeJsonFileName + 结构探针任一项不过 →
      // 整体拒绝，不写任何文件
      for (const d of decisions) {
        const safe = safeJsonFileName(d.fileName);
        if (!safe) throw new Error(`非法 fileName（必须 .json 结尾）: ${d.fileName}`);
        inspectBundleSource(safe, d.content);
      }
      const dir = sourcesDir();
      fs.mkdirSync(dir, { recursive: true });
      const written: string[] = [];
      const failed: { fileName: string; error: string }[] = [];
      // 批量不原子（§8 取舍 1）：逐条 atomicWrite，失败项收集后报告，不回滚
      for (const d of decisions) {
        try {
          atomicWrite(path.join(dir, d.fileName), d.content);
          written.push(d.fileName);
        } catch (err) {
          failed.push({ fileName: d.fileName, error: (err as Error).message });
        }
      }
      if (written.length > 0) {
        const sender = e.sender;
        if (!sender.isDestroyed()) {
          try {
            sender.send(UPDATED_CHANNEL, { source: 'bundle-import', count: written.length });
          } catch {
            /* 窗口已销毁 */
          }
        }
      }
      const result: BundleApplyResult = { written, failed };
      return result;
    },
  );
}
