/**
 * 书源文件元数据解析 + 目录扫描（纯函数 / 纯 IO，无 IPC 依赖）
 *
 * - parseHeaderMeta: 扫 `// @key value` → BookSourceMeta（旧 `.js`，P4 删除）
 * - parseJsonMeta: 读 JSON 文档 → BookSourceMeta（新 `.json`）
 * - scanDir / scanJsonDir / scanAllSources: 目录扫描，两种后缀合并
 * - safeFileName / atomicWrite: 跨 handler 复用的工具
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

/** 旧 JS 书源后缀（迁移期并存，P4 整条链路删除） */
export const JS_EXT = '.js';
/** 新规则书源后缀（计划 §3.4 白名单） */
export const JSON_EXT = '.json';
/** 书源文档的 `format` 字段取值 */
export const JSON_SOURCE_FORMAT = 'pomreader.booksource';

/** fileName 校验：拒绝 `/` `\` `..` 空串（FR-1.5）
 *
 * 另禁**控制字符**（`[\u0000-\u001F\u007F]`）：它们在日志 / IPC 字符串 / 终端输出里
 * 不可见，能把日志断成两段，是"看得见的正常名字 + 看不见的尾巴"这类攻击的载体。
 * 另拒裸 `.`：`path.join(dir, '.')` 就等于 `dir`，`booksource-delete` 传 `.`
 * 会去 unlink 目录本身。
 *
 * 迁移期两种后缀都要过这里，故**不在此处**要求 `.json` 白名单 —— 那是 P4
 * （`.js` 通道删除后）才能收紧的前提。
 */
export function safeFileName(input: string): string | null {
  if (!input || input.includes('/') || input.includes('\\') || input.includes('..')) {
    return null;
  }
  if (input === '.') return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(input)) return null;
  return input;
}

/** 扩展名归一（小写，含点）；无点返回空串 */
export function extOf(fileName: string): string {
  return path.extname(fileName).toLowerCase();
}

export function isJsonSourceName(fileName: string): boolean {
  return extOf(fileName) === JSON_EXT;
}

export function isJsSourceName(fileName: string): boolean {
  return extOf(fileName) === JS_EXT;
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
    if (extOf(entry.name) !== JS_EXT) continue;
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
    // `.disabled` **优先于** `.enabled`：两个 marker 并存时（toggle 写成功但清理失败）
    // 判为禁用 —— "源还显示着、用户再点一次就好"胜过"源悄悄跑起来了"。
    if (fs.existsSync(disabled)) override = false;
    else if (fs.existsSync(enabled)) override = true;
    out.push(parseHeaderMeta(content, entry.name, dir, stat.size, stat.mtimeMs, override));
  }
  out.sort((a, b) => String(a.fileName).localeCompare(String(b.fileName)));
  return out;
}

// ── JSON 规则书源（计划 §3.4） ─────────────────────────────────────────

/** `rules` 里必须存在的键 —— 与生成模板的四个入口一一对应 */
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
 * JSON 文档**信封级**校验：返回错误原因，`null` 表示信封没问题
 *
 * ## 为什么不是 valibot schema（重要）
 *
 * 权威 schema 在 `src/app/core/models/book-source-doc.model.ts`（`BookSourceDocSchema`），
 * 而主进程**不能** import `src/`：`electron/tsconfig.electron.json` 的 `rootDir` 锁死
 * `electron/` 且 `exclude: ["../src"]`，import 会报 `TS6059`，且 tsc 会无视 `--noEmit`
 * 就地把被拉入的文件输出到 `src/`（落地污染）。故：
 *
 * - **主进程**（本函数）只做"能不能进列表"的粗筛，不追求字段级精确 —— 目的是让
 *   列表页能标出"这个源规则坏了"而不是整页崩掉；
 * - **权威校验 + 精确字段路径**在渲染端 `RuleEngineService.readDoc`（valibot 单一来源）。
 *
 * 复制一份 schema 到 electron/ 是明确拒绝的：两份 schema 会各自漂移，然后"列表页说合法、
 * 引擎说非法"这种最难查的现象就会出现。
 */
export function jsonEnvelopeError(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return '顶层不是对象';
  const doc = parsed as Record<string, unknown>;
  if (doc.format !== JSON_SOURCE_FORMAT) return `format 不是 ${JSON_SOURCE_FORMAT}`;
  if (doc.schemaVersion !== 1) return `不支持的 schemaVersion: ${String(doc.schemaVersion)}`;
  if (typeof doc.uuid !== 'string' || !doc.uuid) return 'uuid 缺失';
  if (typeof doc.homepage !== 'string' || !doc.homepage) return 'homepage 缺失';
  const rules = doc.rules;
  if (!rules || typeof rules !== 'object' || Array.isArray(rules)) return 'rules 不是对象';
  const r = rules as Record<string, unknown>;
  for (const key of REQUIRED_RULE_KEYS) {
    if (typeof r[key] !== 'string' || !(r[key] as string)) return `rules.${key} 缺失或非字符串`;
  }
  return null;
}

const JSON_SOURCE_TYPES = ['novel', 'comic', 'video', 'music', 'webpage'] as const;

/**
 * JSON 源的基础 meta（**所有键都在**）
 *
 * 单独抽出来的两个理由：
 * ① 形状一致 —— 坏文件 / 读失败也返回同一套键，渲染端读 `meta.homepage` 拿到 `''`
 *    而不是 `undefined`（"字段有时在有时不在"是最难测的形状不一致）；
 * ② 读失败路径不必伪造一个空串去走 `JSON.parse('')` 再把结果覆盖掉。
 */
export function baseJsonMeta(
  fileName: string,
  sourceDir: string,
  fileSize: number,
  modifiedAt: number,
): Record<string, unknown> {
  return {
    sourceKey: fileName,
    uuid: fileName,
    fileName,
    // name 回退**剥**扩展名，uuid 回退**保留**扩展名（命名空间），方向相反不可互证
    name: fileName.replace(/\.json$/i, ''),
    url: '',
    urls: [],
    homepage: '',
    author: null,
    logo: null,
    description: null,
    enabled: true,
    fileSize,
    modifiedAt,
    sourceDir,
    sourceType: 'novel',
    version: '',
    updateUrl: null,
    tags: [],
    minDelayMs: 0,
    requireUrls: [],
    format: 'json',
    rulesInvalid: null,
  };
}

/**
 * JSON 书源文档 → BookSourceMeta（形状与 `parseHeaderMeta` 一致，渲染端才不用改）
 *
 * `format: 'json'` 是**新增字段**，用来告诉渲染端"启停走文档内 enabled，不是 marker 文件"
 * —— 迁移期两种后缀并存，消费方靠它分派。
 */
export function parseJsonMeta(
  raw: string,
  fileName: string,
  sourceDir: string,
  fileSize: number,
  modifiedAt: number,
): Record<string, unknown> {
  const base = baseJsonMeta(fileName, sourceDir, fileSize, modifiedAt);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ...base, rulesInvalid: `JSON 解析失败: ${(e as Error).message}` };
  }

  const envelopeError = jsonEnvelopeError(parsed);
  if (envelopeError) {
    // 信封不过 → 仍返回一条 meta（列表页要能显示"这个源坏了"），uuid 退回文件名
    //（uuid 不可信时用 fileName 当 key，至少 delete / toggle 还找得到文件）
    return { ...base, rulesInvalid: envelopeError };
  }

  const doc = parsed as Record<string, unknown>;
  const urls = Array.isArray(doc.urls)
    ? doc.urls.filter((u): u is string => typeof u === 'string' && !!u)
    : [];
  const st = doc.sourceType;
  return {
    ...base,
    // uuid 走命名空间回退（带扩展名）：与 `parseHeaderMeta:142` 同构
    sourceKey: typeof doc.uuid === 'string' && doc.uuid ? doc.uuid : fileName,
    uuid: typeof doc.uuid === 'string' && doc.uuid ? doc.uuid : fileName,
    name: typeof doc.name === 'string' && doc.name ? doc.name : base.name,
    url: urls[0] || '',
    urls,
    // name 回退**剥**扩展名，与 uuid 回退**保留**扩展名方向相反，不可互证
    homepage: typeof doc.homepage === 'string' ? doc.homepage : '',
    author: typeof doc.author === 'string' && doc.author ? doc.author : null,
    logo: typeof doc.logo === 'string' && doc.logo ? doc.logo : null,
    description: typeof doc.description === 'string' && doc.description ? doc.description : null,
    enabled: doc.enabled !== false,
    sourceType: JSON_SOURCE_TYPES.includes(st as (typeof JSON_SOURCE_TYPES)[number]) ? st : 'novel',
    version: typeof doc.version === 'string' ? doc.version : '',
    updateUrl: typeof doc.updateUrl === 'string' && doc.updateUrl ? doc.updateUrl : null,
    tags: Array.isArray(doc.tags) ? doc.tags.filter((t): t is string => typeof t === 'string') : [],
    minDelayMs: typeof doc.minDelayMs === 'number' && doc.minDelayMs >= 0 ? doc.minDelayMs : 0,
    requireUrls: Array.isArray(doc.requireUrls)
      ? doc.requireUrls.filter((u): u is string => typeof u === 'string')
      : [],
  };
}

/** 扫描目录里的 `.json` 规则书源（按 fileName 排序） */
export function scanJsonDir(dir: string): Record<string, unknown>[] {
  if (!fs.existsSync(dir)) return [];
  const out: Record<string, unknown>[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (extOf(entry.name) !== JSON_EXT) continue;
    const full = path.join(dir, entry.name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    // 读文件本身失败（权限 / 占用）也要进列表，否则用户看到"书源不见了"而实际还在
    let raw: string;
    try {
      raw = fs.readFileSync(full, 'utf-8');
    } catch (e) {
      out.push({
        ...baseJsonMeta(entry.name, dir, stat.size, stat.mtimeMs),
        rulesInvalid: `文件读取失败: ${(e as Error).message}`,
      });
      continue;
    }
    out.push(parseJsonMeta(raw, entry.name, dir, stat.size, stat.mtimeMs));
  }
  out.sort((a, b) => String(a.fileName).localeCompare(String(b.fileName)));
  return out;
}

/**
 * 合并扫描 `.js` + `.json`（迁移期并存；P4 只保留 `scanJsonDir`）
 *
 * 合并而非分流的原因：渲染端 `BookSourceListStateService` / `import-via-source` 消费的是
 * 同一个 `BookSourceMeta[]`，分流就要改消费方。列表要一起看全，启停才按 `format` 分派。
 */
export function scanAllSources(dir: string): Record<string, unknown>[] {
  return [...scanDir(dir), ...scanJsonDir(dir)].sort((a, b) =>
    String(a.fileName).localeCompare(String(b.fileName)),
  );
}
