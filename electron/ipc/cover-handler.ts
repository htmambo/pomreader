/**
 * 封面下载 + 缓存 IPC handler
 *
 * - 缓存目录 `<userData>/covers/`
 * - key = sha256(url) 前 16 hex（ASSUMPTION-4）
 * - 命中：扫 [jpg,png,gif,webp,svg,avif,bmp,bin] 扩展名
 * - 未命中：safeNetRequest 下载（带 Referer 透传）→ 按 Content-Type 推断扩展名 → 写缓存
 */
import * as crypto from 'crypto';
import { IpcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { safeNetRequest } from './safe-net';

const COVERS_DIR = 'covers';
const EXT_LIST = ['jpg', 'png', 'gif', 'webp', 'svg', 'avif', 'bmp', 'bin'];

function coversDir(userData: string): string {
  return path.join(userData, COVERS_DIR);
}

/** sha256(url) 前 16 hex */
function urlKey(url: string): string {
  return crypto.createHash('sha256').update(url).digest('hex').slice(0, 16);
}

/** Content-Type → 扩展名 */
function extFromMime(mime: string): string {
  const main = mime.split(';')[0].trim().toLowerCase();
  switch (main) {
    case 'image/png': return 'png';
    case 'image/gif': return 'gif';
    case 'image/webp': return 'webp';
    case 'image/svg+xml': return 'svg';
    case 'image/avif': return 'avif';
    case 'image/bmp': return 'bmp';
    default: return 'jpg';
  }
}

/** 查找已缓存的封面文件（任一扩展名） */
function findCached(dir: string, key: string): string | null {
  for (const ext of EXT_LIST) {
    const p = path.join(dir, `${key}.${ext}`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** data: URL base64 解码 */
function base64Decode(input: string): Buffer {
  return Buffer.from(input.replace(/[\r\n]/g, ''), 'base64');
}

/** data: URL percent 解码 */
function percentDecode(input: string): Buffer {
  try {
    return Buffer.from(decodeURIComponent(input), 'binary');
  } catch {
    const bytes = Buffer.from(input, 'binary');
    const out: number[] = [];
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] === 0x25 && i + 2 < bytes.length) {
        const hex = bytes.subarray(i + 1, i + 3).toString('ascii');
        const n = parseInt(hex, 16);
        if (Number.isFinite(n)) {
          out.push(n);
          i += 2;
          continue;
        }
      }
      out.push(bytes[i]);
    }
    return Buffer.from(out);
  }
}

/** data: URL → 字节；非法抛错 */
function decodeDataUrl(url: string): { mime: string; bytes: Buffer } {
  const rest = url.slice('data:'.length);
  const comma = rest.indexOf(',');
  if (comma < 0) throw new Error('非法 data: URL');
  const meta = rest.slice(0, comma);
  const payload = rest.slice(comma + 1);
  const isBase64 = meta.trimEnd().endsWith(';base64');
  const mime = (isBase64 ? meta.trimEnd().slice(0, -7) : meta).trim() || 'image/png';
  const bytes = isBase64 ? base64Decode(payload) : percentDecode(payload);
  return { mime, bytes };
}

/** 写缓存文件 */
function writeCache(dir: string, key: string, bytes: Buffer, mime: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${key}.${extFromMime(mime)}`);
  fs.writeFileSync(target, bytes);
  return target;
}

/** 递归统计目录总字节 */
function dirSize(p: string): number {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(p);
  } catch {
    return 0;
  }
  if (stat.isFile()) return stat.size;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(p, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    const child = path.join(p, entry.name);
    if (entry.isDirectory()) total += dirSize(child);
    else {
      try { total += fs.statSync(child).size; } catch { /* noop */ }
    }
  }
  return total;
}

export function registerCoverHandler(ipcMain: IpcMain, userData: string): void {
  fs.mkdirSync(coversDir(userData), { recursive: true });

  ipcMain.handle(
    'pom:cover-resolve-cache',
    async (
      _e,
      request: { url: string; referer?: string; headers?: Record<string, string> }
    ) => {
      const dir = coversDir(userData);
      const key = urlKey(request.url);

      // data: URL：解码后直接写缓存
      // Round 2 hardening: 长度限制 2MB 防 OOM（base64 膨胀约 4/3）
      if (request.url.startsWith('data:')) {
        if (request.url.length > 2 * 1024 * 1024) {
          throw new Error('data-url-too-large');
        }
        const { mime, bytes } = decodeDataUrl(request.url);
        const filePath = writeCache(dir, key, bytes, mime);
        return { localPath: filePath, localRef: 'local://' + filePath };
      }

      // 缓存命中
      const cached = findCached(dir, key);
      if (cached) {
        return { localPath: cached, localRef: 'local://' + cached };
      }

      // 未命中：下载
      if (!request.url.startsWith('http://') && !request.url.startsWith('https://')) {
        throw new Error('不支持的封面 URL');
      }
      const headers: Record<string, string> = { ...(request.headers ?? {}) };
      if (request.referer) headers['referer'] = request.referer;
      const result = await safeNetRequest(request.url, {
        headers,
        accept: 'image/*,*/*;q=0.8',
      });
      if (result.status < 200 || result.status >= 300) {
        throw new Error(`封面下载 HTTP ${result.status}`);
      }
      const mime = result.headers['content-type'] ?? 'image/jpeg';
      const filePath = writeCache(dir, key, result.bytes, mime);
      return { localPath: filePath, localRef: 'local://' + filePath };
    }
  );

  ipcMain.handle('pom:cover-cache-size', () => {
    const dir = coversDir(userData);
    if (!fs.existsSync(dir)) return 0;
    return dirSize(dir);
  });

  ipcMain.handle('pom:cover-cache-clear', () => {
    const dir = coversDir(userData);
    if (!fs.existsSync(dir)) return 0;
    const freed = dirSize(dir);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    return freed;
  });
}