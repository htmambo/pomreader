/**
 * 扩展系统 IPC handler（CRUD + UserScript 头部解析 + eval stub）
 *
 * - 主目录 `<userData>/extensions/`
 * - 头部：扫 `// ==UserScript==` 到 `// ==/UserScript==` 块（前 100 行）
 * - v1 `extensionEval` 仅返回元数据，args 不实际执行（DM-4 推迟 UI hooks）
 */
import { IpcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

const EXTS_DIR = 'extensions';

function extsDir(userData: string): string {
  return path.join(userData, EXTS_DIR);
}

/** fileName 校验 */
function safeFileName(input: string): string | null {
  if (!input || input.includes('/') || input.includes('\\') || input.includes('..')) {
    return null;
  }
  return input;
}

/** 原子写 */
function atomicWrite(target: string, content: string): void {
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, content, 'utf-8');
  fs.renameSync(tmp, target);
}

/** 扫描前 100 行找 `// ==UserScript==` 块 */
function parseUserScriptHeader(content: string): Record<string, string | string[]> {
  const lines = content.split(/\r?\n/).slice(0, 100);
  const out: Record<string, string | string[]> = {};

  // @key 多值（match / grant / require）
  const multi: Record<string, string[]> = {
    match: [],
    grant: [],
    require: [],
  };

  let inBlock = false;
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith('//')) continue;
    const body = trimmed.replace(/^\/+/, '').trimStart();
    if (body === '==UserScript==') {
      inBlock = true;
      continue;
    }
    if (body === '==/UserScript==') {
      inBlock = false;
      continue;
    }
    if (!inBlock) continue;
    if (!body.startsWith('@')) continue;
    const rest = body.slice(1);
    const ws = rest.search(/\s/);
    const key = (ws === -1 ? rest : rest.slice(0, ws)).toLowerCase();
    const value = (ws === -1 ? '' : rest.slice(ws + 1)).trim();
    if (!key) continue;
    if (key in multi) {
      if (value) multi[key].push(value);
    } else if (value) {
      if (!(key in out)) out[key] = value;
    }
  }
  for (const k of Object.keys(multi)) {
    if (multi[k].length) out[k] = multi[k];
  }
  return out;
}

/** 文件扫描 */
function scanExtensions(dir: string): Record<string, unknown>[] {
  if (!fs.existsSync(dir)) return [];
  const out: Record<string, unknown>[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (path.extname(entry.name).toLowerCase() !== '.js') continue;
    const full = path.join(dir, entry.name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    const content = fs.readFileSync(full, 'utf-8');
    const header = parseUserScriptHeader(content);
    const disabled = path.join(dir, entry.name + '.disabled');
    const enabled = path.join(dir, entry.name + '.enabled');
    let override: boolean | null = null;
    if (fs.existsSync(disabled)) override = false;
    else if (fs.existsSync(enabled)) override = true;

    const matchPatterns = Array.isArray(header['match']) ? header['match'] : [];
    const grants = Array.isArray(header['grant']) ? header['grant'] : [];

    out.push({
      fileName: entry.name,
      name: typeof header['name'] === 'string' ? header['name'] : entry.name.replace(/\.js$/i, ''),
      namespace: typeof header['namespace'] === 'string' ? header['namespace'] : '',
      version: typeof header['version'] === 'string' ? header['version'] : '',
      description: typeof header['description'] === 'string' ? header['description'] : '',
      author: typeof header['author'] === 'string' ? header['author'] : '',
      matchPatterns,
      grants,
      runAt: typeof header['run-at'] === 'string' ? header['run-at'] : 'document-idle',
      category: typeof header['category'] === 'string' ? header['category'] : '',
      enabled: override !== null ? override : true,
      fileSize: stat.size,
      modifiedAt: stat.mtimeMs,
    });
  }
  out.sort((a, b) => String(a.fileName).localeCompare(String(b.fileName)));
  return out;
}

export function registerExtensionHandler(ipcMain: IpcMain, userData: string): void {
  fs.mkdirSync(extsDir(userData), { recursive: true });

  ipcMain.handle('pom:extension-list', () => scanExtensions(extsDir(userData)));

  ipcMain.handle('pom:extension-read', (_e, fileName: string) => {
    const safe = safeFileName(fileName);
    if (!safe) throw new Error('非法 fileName');
    const p = path.join(extsDir(userData), safe);
    if (!fs.existsSync(p)) throw new Error(`扩展文件不存在: ${fileName}`);
    return fs.readFileSync(p, 'utf-8');
  });

  ipcMain.handle('pom:extension-save', (_e, fileName: string, content: string) => {
    const safe = safeFileName(fileName);
    if (!safe) throw new Error('非法 fileName');
    const dir = extsDir(userData);
    fs.mkdirSync(dir, { recursive: true });
    atomicWrite(path.join(dir, safe), content);
  });

  ipcMain.handle('pom:extension-delete', (_e, fileName: string) => {
    const safe = safeFileName(fileName);
    if (!safe) throw new Error('非法 fileName');
    const p = path.join(extsDir(userData), safe);
    if (fs.existsSync(p)) fs.unlinkSync(p);
    for (const suffix of ['.enabled', '.disabled']) {
      const m = p + suffix;
      if (fs.existsSync(m)) fs.unlinkSync(m);
    }
  });

  // eval(args)：v1 仅返回元数据 + 文件路径，args 不实际执行
  // （实际沙箱执行由 Renderer 端 SandboxService 承担；UI hooks 推迟到 v2）
  ipcMain.handle('pom:extension-eval', (_e, fileName: string, _args: unknown[]) => {
    const safe = safeFileName(fileName);
    if (!safe) throw new Error('非法 fileName');
    const p = path.join(extsDir(userData), safe);
    if (!fs.existsSync(p)) throw new Error(`扩展文件不存在: ${fileName}`);
    const content = fs.readFileSync(p, 'utf-8');
    const header = parseUserScriptHeader(content);
    const meta = scanExtensions(extsDir(userData)).find((m) => m.fileName === fileName);
    return {
      filePath: p,
      meta,
      headerKeys: Object.keys(header),
      evaluated: false, // v1 stub：Renderer 拿到此值后知道需自行 sandbox.eval
    };
  });
}