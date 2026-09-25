/**
 * 书源 JS 头部元数据解析 + 目录扫描（纯函数 / 纯 IO，无 IPC 依赖）
 *
 * - parseHeaderMeta: 扫 `// @key value` → BookSourceMeta
 * - scanDir: 遍历 `.js` 文件，叠加 marker 文件覆盖 enabled
 * - safeFileName / atomicWrite: 跨 handler 复用的工具
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

/** fileName 校验：拒绝 `/` `\` `..` 空串（FR-1.5） */
export function safeFileName(input: string): string | null {
  if (!input || input.includes('/') || input.includes('\\') || input.includes('..')) {
    return null;
  }
  return input;
}

/**
 * 原子写：写 `.tmp` 后 rename；写入失败时原文件不被截断（FR-1.5）
 * Round 5 hardening（简化）：
 * - 随机 tmp 后缀防并发覆盖
 * - tmp 与 target 同目录 → fs.renameSync 是原子（同文件系统）
 * - 失败路径 finally 清理残留 tmp（成功路径 rename 后 tmp 已移走）
 * - EPERM/EBUSY 直接抛错（v1 不做重试）
 * ⚠️ 已删除 EXDEV 分支：tmp 与 target 同目录不可能触发 EXDEV（跨卷错误），旧代码为死代码
 */
export function atomicWrite(target: string, content: string): void {
  const tmp = `${target}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`;
  try {
    try { fs.unlinkSync(tmp); } catch { /* 不存在 */ }
    fs.writeFileSync(tmp, content, 'utf-8');
    fs.renameSync(tmp, target);
  } catch (err) {
    // 失败时清理残留 tmp（成功路径 tmp 已被 rename 移走，无残留）
    try { fs.unlinkSync(tmp); } catch { /* noop */ }
    throw err;
  }
}

/** 解析书源 JS 头部注释（`// @key value`），纯函数 */
export function parseHeaderMeta(
  content: string,
  fileName: string,
  sourceDir: string,
  fileSize: number,
  modifiedAt: number,
  enabledOverride: boolean | null
): Record<string, unknown> {
  let name: string | null = null;
  let author: string | null = null;
  let logo: string | null = null;
  const descriptions: string[] = [];
  const urls: string[] = [];
  const tags: string[] = [];
  let version = '';
  let updateUrl: string | null = null;
  let uuid: string | null = null;
  let sourceType = 'novel';
  let headerEnabled: boolean | null = null;
  let minDelayMs = 0;
  const requireUrls: string[] = [];

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith('//')) continue;
    const body = trimmed.replace(/^\/+/, '').trimStart();
    if (!body.startsWith('@')) continue;
    const rest = body.slice(1);
    const ws = rest.search(/\s/);
    const key = ws === -1 ? rest : rest.slice(0, ws);
    const value = (ws === -1 ? '' : rest.slice(ws + 1)).trim();
    if (!key) continue;
    switch (key) {
      case 'name':
        if (!name && value) name = value;
        break;
      case 'author':
        if (!author && value) author = value;
        break;
      case 'logo':
        if (!logo && value) logo = value;
        break;
      case 'description':
        descriptions.push(value);
        break;
      case 'url':
        if (value) urls.push(value);
        break;
      case 'tags':
        for (const t of value.split(/[,，]/)) {
          const s = t.trim();
          if (s && !tags.includes(s)) tags.push(s);
        }
        break;
      case 'version':
        if (!version && value) version = value;
        break;
      case 'updateUrl':
        if (!updateUrl && value) updateUrl = value;
        break;
      case 'uuid':
        if (!uuid && value) uuid = value;
        break;
      case 'type':
        if (
          value === 'novel' ||
          value === 'comic' ||
          value === 'video' ||
          value === 'music' ||
          value === 'webpage'
        ) {
          sourceType = value;
        }
        break;
      case 'enabled':
        if (headerEnabled === null) {
          headerEnabled = !(value === 'false' || value === '0' || value === 'no');
        }
        break;
      case 'minDelayMs':
      case 'minDelay': {
        const n = parseInt(value, 10);
        if (Number.isFinite(n) && n >= 0) minDelayMs = n;
        break;
      }
      case 'require':
        if (value) requireUrls.push(value);
        break;
    }
  }

  const finalUuid = uuid || fileName;
  const enabled =
    enabledOverride !== null
      ? enabledOverride
      : headerEnabled !== null
      ? headerEnabled
      : true;

  return {
    sourceKey: finalUuid,
    uuid: finalUuid,
    fileName,
    name: name || fileName.replace(/\.js$/i, ''),
    url: urls[0] || '',
    urls,
    author,
    logo,
    description: descriptions.length ? descriptions.join('\n') : null,
    enabled,
    fileSize,
    modifiedAt,
    sourceDir,
    sourceType,
    version,
    updateUrl,
    tags,
    minDelayMs,
    requireUrls,
  };
}

/** 扫描目录，返回 BookSourceMeta[]（按 fileName 排序） */
export function scanDir(dir: string): Record<string, unknown>[] {
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
    const disabled = path.join(dir, entry.name + '.disabled');
    const enabled = path.join(dir, entry.name + '.enabled');
    let override: boolean | null = null;
    if (fs.existsSync(disabled)) override = false;
    else if (fs.existsSync(enabled)) override = true;
    out.push(parseHeaderMeta(content, entry.name, dir, stat.size, stat.mtimeMs, override));
  }
  out.sort((a, b) => String(a.fileName).localeCompare(String(b.fileName)));
  return out;
}