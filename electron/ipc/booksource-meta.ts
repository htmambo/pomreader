/**
 * 书源头部元数据解析 + 目录扫描（纯函数 / 纯 IO，无 IPC 依赖）
 *
 * - parseHeaderMeta: 扫 `// @key value` → BookSourceMeta（.js 链路，P4 删）
 * - scanDir: 遍历 `.js` 文件，叠加 marker 文件覆盖 enabled（.js 链路，P4 删）
 * - scanJsonDir: 遍历 `.json` 书源（BookSourceDoc），enabled 取文档内字段（方案 §3.4）
 * - safeFileName / safeJsonFileName / atomicWrite: 跨 handler 复用的工具
 *   （⚠️ 本文件不能整体删：electron/window-state.ts 依赖 atomicWrite）
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

/** fileName 校验：拒绝 `/` `\` `..` 空串 + 控制字符（FR-1.5） */
export function safeFileName(input: string): string | null {
  if (!input || input.includes('/') || input.includes('\\') || input.includes('..')) {
    return null;
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(input)) return null;
  return input;
}

/**
 * .json 书源专用 fileName 校验：safeFileName + `.json` 后缀约束。
 * ⚠️ 后缀约束不写进 safeFileName —— .js 链路 P4 前仍在用它（方案 §3.4）。
 */
export function safeJsonFileName(input: string): string | null {
  const safe = safeFileName(input);
  if (!safe || !/\.json$/i.test(safe)) return null;
  return safe;
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
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* 不存在 */
    }
    fs.writeFileSync(tmp, content, 'utf-8');
    fs.renameSync(tmp, target);
  } catch (err) {
    // 失败时清理残留 tmp（成功路径 tmp 已被 rename 移走，无残留）
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* noop */
    }
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
  enabledOverride: boolean | null,
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
    enabledOverride !== null ? enabledOverride : headerEnabled !== null ? headerEnabled : true;

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

/* ── JSON 书源（BookSourceDoc）扫描（方案 §3.4，P2 新增） ────────────────── */

const SOURCE_TYPES = new Set(['novel', 'comic', 'video', 'music', 'webpage']);

/** SourceRules 7 个必填字段（F3；渲染端 BookSourceDocSchema 同款清单） */
const REQUIRED_RULE_KEYS = [
  'siteName',
  'searchPath',
  'searchItemPattern',
  'bookTitlePattern',
  'bookAuthorPattern',
  'chapterItemPattern',
  'contentPattern',
] as const;

/**
 * BookSourceDoc 最小结构校验（主进程侧探针），返回 null = 通过，否则返回原因摘要。
 *
 * 决策记录（方案 §3.4 / R5 先松后紧）：完整 valibot 校验在渲染端
 * `src/app/core/models/book-source-doc.model.ts` 的 `BookSourceDocSchema`。
 * 主进程曾试选项①（tsconfig.electron.json 精准 include 该模型文件），但
 * `rootDir: "."` + `exclude: ["../src"]` 下 include 一个 ../src 文件触发 TS6059
 * （file not under rootDir），需连带改 rootDir/exclude/输出布局，远超 3 行 →
 * 退为选项②：主进程只做「结构探针 + 必填存在性检查」，完整校验留给渲染端。
 */
export function validateBookSourceDocStructure(doc: Record<string, unknown>): string | null {
  if (doc.schemaVersion !== 1) return 'schemaVersion 须为 1';
  if (typeof doc.uuid !== 'string' || !doc.uuid) return 'uuid 必填';
  if (typeof doc.name !== 'string' || !doc.name) return 'name 必填';
  if (typeof doc.homepage !== 'string' || !doc.homepage) return 'homepage 必填';
  if (!Array.isArray(doc.urls) || doc.urls.some((u) => typeof u !== 'string')) {
    return 'urls 须为字符串数组';
  }
  if (typeof doc.enabled !== 'boolean') return 'enabled 须为 boolean';
  if (typeof doc.sourceType !== 'string' || !SOURCE_TYPES.has(doc.sourceType)) {
    return 'sourceType 须为 novel/comic/video/music/webpage';
  }
  if (doc.tags !== undefined && !Array.isArray(doc.tags)) return 'tags 须为数组';
  if (doc.requireUrls !== undefined && !Array.isArray(doc.requireUrls)) {
    return 'requireUrls 须为数组';
  }
  if (doc.minDelayMs !== undefined && typeof doc.minDelayMs !== 'number') {
    return 'minDelayMs 须为 number';
  }
  if (doc.headers !== undefined && (typeof doc.headers !== 'object' || doc.headers === null)) {
    return 'headers 须为对象';
  }
  const rules = doc.rules;
  if (typeof rules !== 'object' || rules === null) return 'rules 必填';
  for (const key of REQUIRED_RULE_KEYS) {
    const value = (rules as Record<string, unknown>)[key];
    if (typeof value !== 'string' || !value) return `rules.${key} 必填`;
  }
  return null;
}

/** 非 null 字符串取值 */
function strOrNull(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

/** 字符串数组取值（逐项过滤非字符串） */
function strArr(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((i): i is string => typeof i === 'string') : [];
}

/**
 * 由 BookSourceDoc 生成 BookSourceMeta 同构对象（字段与 parseHeaderMeta 输出对齐）。
 * rulesInvalid 非空时条目仍返回（列表页红标用，方案 §3.4），enabled 按文档值或 false。
 */
function jsonDocToMeta(
  doc: Record<string, unknown>,
  fileName: string,
  sourceDir: string,
  fileSize: number,
  modifiedAt: number,
  rulesInvalid?: string,
): Record<string, unknown> {
  // ⚠️ 两条回退方向相反（方案 §3.1/§4.2 硬约束，对照 booksource-meta.ts 上方 :142 vs :150）：
  // uuid 缺省回退**带扩展名**的文件名（`foo.json`，uuid 一致性是 D6 硬验收前提）；
  // name 缺省回退**剥掉** `.json` 的文件名。两者不可互相佐证。
  const uuid = strOrNull(doc.uuid) ?? fileName;
  const name = strOrNull(doc.name) ?? fileName.replace(/\.json$/i, '');
  const urls = strArr(doc.urls);
  return {
    sourceKey: uuid,
    uuid,
    fileName,
    name,
    url: urls[0] || strOrNull(doc.homepage) || '',
    urls,
    author: strOrNull(doc.author),
    logo: strOrNull(doc.logo),
    description: strOrNull(doc.description),
    enabled: typeof doc.enabled === 'boolean' ? doc.enabled : false,
    fileSize,
    modifiedAt,
    sourceDir,
    sourceType:
      typeof doc.sourceType === 'string' && SOURCE_TYPES.has(doc.sourceType)
        ? doc.sourceType
        : 'novel',
    version: strOrNull(doc.sourceVersion) ?? '',
    updateUrl: strOrNull(doc.updateUrl),
    tags: strArr(doc.tags),
    minDelayMs:
      typeof doc.minDelayMs === 'number' && Number.isFinite(doc.minDelayMs) && doc.minDelayMs >= 0
        ? doc.minDelayMs
        : 0,
    requireUrls: strArr(doc.requireUrls),
    ...(rulesInvalid ? { rulesInvalid } : {}),
  };
}

/**
 * 扫描目录中的 `.json` 书源（BookSourceDoc），返回 BookSourceMeta[]（按 fileName 排序）。
 *
 * - enabled 直接取文档内 `enabled` 字段（JSON 源不用 `.enabled/.disabled` marker）
 * - 非书源 JSON 跳过：用 `format === 'pomreader.booksource'` 探针
 *   （与渲染端模型 isBookSourceDocLike 同款逻辑；迁移报告等文件虽不放这目录，防御仍要，R14）
 * - JSON.parse 失败 / 结构校验失败 / 必填规则为空 → 条目仍返回，置 rulesInvalid 原因摘要
 */
export function scanJsonDir(dir: string): Record<string, unknown>[] {
  if (!fs.existsSync(dir)) return [];
  const out: Record<string, unknown>[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (path.extname(entry.name).toLowerCase() !== '.json') continue;
    const full = path.join(dir, entry.name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    const content = fs.readFileSync(full, 'utf-8');
    let doc: unknown;
    try {
      doc = JSON.parse(content);
    } catch (err) {
      out.push(
        jsonDocToMeta(
          {},
          entry.name,
          dir,
          stat.size,
          stat.mtimeMs,
          `JSON 解析失败: ${(err as Error).message}`,
        ),
      );
      continue;
    }
    if (
      typeof doc !== 'object' ||
      doc === null ||
      (doc as { format?: unknown }).format !== 'pomreader.booksource'
    ) {
      continue; // 非书源 JSON（探针不命中）不进列表
    }
    const d = doc as Record<string, unknown>;
    // 先套用 uuid/name 回退再校验：uuid/name 缺省不算 invalid（回退规则见 jsonDocToMeta）
    const normalized: Record<string, unknown> = {
      ...d,
      uuid: strOrNull(d.uuid) ?? entry.name,
      name: strOrNull(d.name) ?? entry.name.replace(/\.json$/i, ''),
    };
    const reason = validateBookSourceDocStructure(normalized);
    out.push(jsonDocToMeta(d, entry.name, dir, stat.size, stat.mtimeMs, reason ?? undefined));
  }
  out.sort((a, b) => String(a.fileName).localeCompare(String(b.fileName)));
  return out;
}
