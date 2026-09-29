/**
 * 存量 JS 书源 → JSON（BookSourceDoc）启动迁移（方案 docs/Architecture/2026-09-29-BOOKSOURCE-JSON-RULES-PLAN.md §4.2）
 *
 * - 触发时机：主进程 `app.whenReady` 后、书源 handler 注册（首次 scanDir）前（main.ts 挂接）；
 *   `pom:booksource-convert` channel 供手动重触发。失败只告警不阻断启动。
 *   迁移不受 `pom.bookSource.engine` 运行时开关约束（§4.2 明示：一次性文件级转换）。
 * - 幂等（唯一口径）：`<同名>.json` 已存在且 uuid 相同 → 跳过整个文件（不动 .js 不覆盖 .json）；
 *   不做任何 mtime 比对。自然幂等来自已处理文件移出扫描集（.js 移入 booksources_legacy/）。
 * - 判定保守：宁可误归 needs-manual 不可错迁；legacy 文件永不删、可人工救回。
 * - 迁移报告写 `<userData>/booksource-migration-report.json`（⚠️ 在 booksources/ 之外，
 *   否则被 scanJsonDir 扫成幽灵源，R14），渲染端读后删。
 *
 * ⚠️ 跨 tsconfig 边界约束：electron/tsconfig.electron.json（rootDir:"." + exclude ../src）
 * 不能 import src/ 下的运行时代码（TS6059）。本文件内的规则抽取逻辑（extractRulesFromJs /
 * extractBaseUrl / extractHeaders）与 src/app/core/logic/rule-parse.ts **同源移植**，
 * 改动需双向同步；结构白名单（WHITELIST_FUNCTIONS/WHITELIST_CONSTS + isPureTemplate）与
 * scripts/audit-booksources.ts 同源移植，同样需双向同步。
 * 完整 valibot 校验同样不可达 —— 用 booksource-meta.ts 的 validateBookSourceDocStructure
 * 做结构探针校验（完整校验在渲染端 BookSourceDocSchema）。
 */
import type { IpcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { atomicWrite, parseHeaderMeta, validateBookSourceDocStructure } from './booksource-meta';

const PRIMARY_DIR = 'booksources';
const LEGACY_DIR = 'booksources_legacy';
const REPORT_FILE = 'booksource-migration-report.json';

/* ════════════════════════════════════════════════════════════════════════
 * 规则抽取（与 src/app/core/logic/rule-parse.ts 同源移植 —— 跨 tsconfig 边界
 * 不可 import，改动需双向同步）
 * ════════════════════════════════════════════════════════════════════════ */

type SearchMethod = 'GET' | 'POST' | 'POST_RAW';

interface SearchBodyParam {
  key: string;
  value: string;
}

interface ContentReplaceRule {
  rule: string;
  replace: string;
}

/** SourceRules 同构（7 必填 + 9 可选，F3；字段名一字不改） */
interface SourceRulesDoc {
  siteName: string;
  searchPath: string;
  searchItemPattern: string;
  bookTitlePattern: string;
  bookAuthorPattern: string;
  chapterItemPattern: string;
  contentPattern: string;
  searchMethod?: SearchMethod;
  searchBodyParams?: SearchBodyParam[];
  searchContentType?: string;
  searchRawBody?: string;
  searchAuthorPattern?: string;
  searchCategoryPattern?: string;
  contentReplaceRules?: ContentReplaceRule[];
  bookCategoryPattern?: string;
  coverUrlPattern?: string;
}

/** 7 个必填字段（F3）；任一解析为空 → needs-manual */
const REQUIRED_FIELDS = [
  'siteName',
  'searchPath',
  'searchItemPattern',
  'bookTitlePattern',
  'bookAuthorPattern',
  'chapterItemPattern',
  'contentPattern',
] as const;

/** 抽 `const NAME = <值>` 的原始值文本（去尾分号）；未命中返回 '' */
function extractRaw(source: string, name: string): string {
  const m = new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*(.+?)\\s*$`, 'm').exec(source);
  if (!m) return '';
  return m[1].trim().replace(/;$/, '').trim();
}

/** 字符串常量值：按 JSON.parse 语义解析；失败且为反引号 → 取内层；再失败 → 返回原文 */
function extractString(source: string, name: string): string {
  const raw = extractRaw(source, name);
  if (!raw) return '';
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'")) ||
    (raw.startsWith('`') && raw.endsWith('`'))
  ) {
    try {
      return JSON.parse(raw) as string;
    } catch {
      /* 反引号模板串不是合法 JSON：退化为取内层 */
    }
    if (raw.startsWith('`')) return raw.slice(1, -1);
  }
  return raw;
}

/** 对象数组常量；旧元组形态 [k, v] 命中时升级为对象（F15）；缺失/解析失败 → null */
function extractObjArray(
  source: string,
  name: string,
  upgrade: (item: unknown[]) => unknown,
): unknown[] | null {
  const raw = extractRaw(source, name);
  if (!raw) return null;
  let arr: unknown;
  try {
    arr = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(arr)) return null;
  return arr.map((item) => (Array.isArray(item) ? upgrade(item) : item));
}

/**
 * 从 JS 书源全文解析 15 个规则常量 + `// @name` 头 → SourceRules。
 * 任一必填字段为空 → null（调用方判 needs-manual）。
 * searchContentType 缺省回填按 method 区分（§4.2）：POST_RAW → application/json，其余 → form-urlencoded。
 */
function extractRulesFromJs(source: string): SourceRulesDoc | null {
  const siteName = /^\s*\/\/\s*@name\s+(.+?)\s*$/m.exec(source)?.[1] ?? '';

  const methodRaw = extractString(source, 'SEARCH_METHOD');
  const searchMethod: SearchMethod = (['GET', 'POST', 'POST_RAW'] as SearchMethod[]).includes(
    methodRaw as SearchMethod,
  )
    ? (methodRaw as SearchMethod)
    : 'GET';

  const searchContentType =
    extractString(source, 'SEARCH_CONTENT_TYPE') ||
    (searchMethod === 'POST_RAW' ? 'application/json' : 'application/x-www-form-urlencoded');

  const rules: SourceRulesDoc = {
    siteName,
    searchPath: extractString(source, 'SEARCH_PATH'),
    searchMethod,
    searchBodyParams: (extractObjArray(source, 'SEARCH_BODY_PARAMS', (t) => ({
      key: String(t[0] ?? ''),
      value: String(t[1] ?? ''),
    })) ?? []) as SearchBodyParam[],
    searchContentType,
    searchRawBody: extractString(source, 'SEARCH_RAW_BODY'),
    searchItemPattern: extractString(source, 'SEARCH_ITEM_RULE'),
    // 模板版本漂移的旧生成源可能没有这两个常量（F15）：缺省 '' = 不提取（向后兼容语义）
    searchAuthorPattern: extractString(source, 'SEARCH_AUTHOR_RULE'),
    searchCategoryPattern: extractString(source, 'SEARCH_CATEGORY_RULE'),
    bookTitlePattern: extractString(source, 'BOOK_TITLE_RULE'),
    bookAuthorPattern: extractString(source, 'BOOK_AUTHOR_RULE'),
    chapterItemPattern: extractString(source, 'CHAPTER_ITEM_RULE'),
    contentPattern: extractString(source, 'CONTENT_RULE'),
    contentReplaceRules: (extractObjArray(source, 'CONTENT_REPLACE_RULES', (t) => ({
      rule: String(t[0] ?? ''),
      replace: String(t[1] ?? ''),
    })) ?? []) as ContentReplaceRule[],
    bookCategoryPattern: extractString(source, 'BOOK_CATEGORY_RULE'),
    coverUrlPattern: extractString(source, 'COVER_RULE'),
  };

  for (const field of REQUIRED_FIELDS) {
    if (!rules[field]) return null;
  }
  return rules;
}

/**
 * 抽 `const HEADERS = {...}`（F7）。缺失 / JSON.parse 失败 / 非对象 → {}：
 * header 是增强项，写坏不应让整个迁移失败
 */
function extractHeaders(source: string): Record<string, string> {
  const raw = extractRaw(source, 'HEADERS');
  if (!raw) return {};
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = String(v);
  }
  return out;
}

/* ════════════════════════════════════════════════════════════════════════
 * 结构白名单判定（与 scripts/audit-booksources.ts 同源移植 —— 改动需双向同步；
 * 方案 §4.2 isPureTemplate，禁字节比对，D8/F14/F15）
 * ════════════════════════════════════════════════════════════════════════ */

/** 模板固定函数白名单（smart-rules.ts 生成代码段） */
const WHITELIST_FUNCTIONS = new Set([
  'isCssRule',
  'ruleSelector',
  'stripTags',
  'absUrl',
  'matchAll',
  'extractLinks',
  'extractSearchItems',
  'searchExtraRules',
  'extractText',
  'extractHtml',
  'extractAttr',
  'buildFormBody',
  'search',
  'bookInfo',
  'chapterList',
  'chapterContent',
]);

/** 模板常量白名单 = 15 规则常量 + BASE_URL / HEADERS / REGEX_HINT_CHARS / MAX_EXTRACT_LINKS（F1） */
const WHITELIST_CONSTS = new Set([
  'SEARCH_PATH',
  'SEARCH_METHOD',
  'SEARCH_BODY_PARAMS',
  'SEARCH_CONTENT_TYPE',
  'SEARCH_RAW_BODY',
  'SEARCH_ITEM_RULE',
  'SEARCH_AUTHOR_RULE',
  'SEARCH_CATEGORY_RULE',
  'BOOK_TITLE_RULE',
  'BOOK_AUTHOR_RULE',
  'CHAPTER_ITEM_RULE',
  'CONTENT_RULE',
  'CONTENT_REPLACE_RULES',
  'BOOK_CATEGORY_RULE',
  'COVER_RULE',
  'BASE_URL',
  'HEADERS',
  'REGEX_HINT_CHARS',
  'MAX_EXTRACT_LINKS',
]);

/** 剥离头部连续 `//` 注释块（含其间空行）—— isPureTemplate 第 1 步 */
function stripLeadingCommentBlock(content: string): string[] {
  const lines = content.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && (lines[i].trim() === '' || lines[i].trimStart().startsWith('//'))) {
    i++;
  }
  return lines.slice(i);
}

/**
 * 逐行扫**顶层语句**（行首无缩进）：function/const 声明名必须命中白名单，
 * 其余顶层语句一律判手改；缩进行视为函数体内语句不参与判定；顶层 JSDoc 块注释跳过。
 */
function findTemplateViolations(lines: string[]): string[] {
  const violations: string[] = [];
  let inBlockComment = false;
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (inBlockComment) {
      if (line.includes('*/')) inBlockComment = false;
      continue;
    }
    if (trimmed.startsWith('/*')) {
      if (!line.includes('*/')) inBlockComment = true;
      continue;
    }
    if (line.trim() === '' || trimmed.startsWith('//')) continue;
    if (/^\s/.test(line)) continue;
    const fn = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/.exec(line);
    if (fn) {
      if (!WHITELIST_FUNCTIONS.has(fn[1])) violations.push(`白名单外函数声明: ${fn[1]}`);
      continue;
    }
    const c = /^const\s+([A-Za-z_$][\w$]*)/.exec(line);
    if (c) {
      if (!WHITELIST_CONSTS.has(c[1])) violations.push(`白名单外常量声明: ${c[1]}`);
      continue;
    }
    if (/^}\s*;?\s*$/.test(line)) continue; // 顶层函数收尾大括号
    violations.push(`模板外顶层语句: ${line.trim().slice(0, 80)}`);
  }
  return violations;
}

/** 结构白名单判定：true = 纯模板生成源（可迁移） */
export function isPureTemplate(content: string): boolean {
  return findTemplateViolations(stripLeadingCommentBlock(content)).length === 0;
}

/* ════════════════════════════════════════════════════════════════════════
 * legado 骨架源识别（F8：stub 抛错函数 + 注释内嵌原始 JSON，
 * 特征与 scripts/audit-booksources.ts isSkeletonSource 一致）
 * ════════════════════════════════════════════════════════════════════════ */

function isSkeletonSource(content: string): boolean {
  return content.includes('此源由 legado 导入') && content.includes('原始 Legado JSON');
}

/**
 * 提取骨架源注释内嵌的原始 legado JSON：定位「原始 Legado JSON」标记行，
 * 收集后续 `// ` 前缀行（去前缀），遇空注释行（单独 `//`）或非注释行即止。
 * 提取不到 → ''（调用方判 needs-manual，保守）。
 */
function extractLegadoRaw(content: string): string {
  const lines = content.split(/\r?\n/);
  const markerIdx = lines.findIndex((l) => l.includes('原始 Legado JSON'));
  if (markerIdx === -1) return '';
  const out: string[] = [];
  for (let i = markerIdx + 1; i < lines.length; i++) {
    const t = lines[i].trimStart();
    if (!t.startsWith('//')) break;
    const body = t.replace(/^\/+\s?/, '');
    if (body.trim() === '') break; // 骨架注释块的收尾行（单独的 `//`）
    out.push(body);
  }
  return out.join('\n').trim();
}

/* ════════════════════════════════════════════════════════════════════════
 * 迁移主流程（纯函数分类 + IO 分离）
 * ════════════════════════════════════════════════════════════════════════ */

export type MigrationOutcome = 'migrated' | 'skeleton' | 'needs-manual' | 'skipped';

export interface MigrationEntry {
  fileName: string;
  uuid: string;
  outcome: MigrationOutcome;
  /** needs-manual 原因 / 迁移过程非阻断错误说明 */
  reason?: string;
  /** migrated/skeleton 路径的产出文件名（booksources/<同名>.json） */
  jsonFileName?: string;
}

export interface MigrationReport {
  generatedAt: string;
  /** legacy 目录绝对路径（渲染端 Modal 汇总展示用，§4.2） */
  legacyDir: string;
  totals: {
    total: number;
    migrated: number;
    skeleton: number;
    needsManual: number;
    skipped: number;
  };
  entries: MigrationEntry[];
}

export interface LegacyItem {
  fileName: string;
  /** 由 legacy 目录内 marker（<fileName>.enabled/.disabled）+ 头部 @enabled 得出 */
  enabled: boolean;
  /** 不可自动转换的原因（重新分类得出）；可转换/已正常归档的条目无此字段 */
  reason?: string;
}

/** BookSourceDoc 同构（渲染端 core/models/book-source-doc.model.ts 的镜像，跨边界不可 import） */
interface BookSourceDocShape {
  format: 'pomreader.booksource';
  schemaVersion: 1;
  uuid: string;
  name: string;
  author?: string;
  logo?: string;
  description?: string;
  homepage: string;
  urls: string[];
  enabled: boolean;
  sourceType: string;
  sourceVersion?: string;
  updateUrl?: string;
  tags: string[];
  minDelayMs: number;
  requireUrls: string[];
  headers: Record<string, string>;
  rules: SourceRulesDoc;
  legadoRaw?: string;
}

function strOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function strArr(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((i): i is string => typeof i === 'string') : [];
}

/** meta（parseHeaderMeta 输出）→ BookSourceDoc 骨架字段（rules/headers 由调用方填） */
function docFromMeta(meta: Record<string, unknown>): BookSourceDocShape {
  const urls = strArr(meta.urls);
  return {
    format: 'pomreader.booksource',
    schemaVersion: 1,
    uuid: String(meta.uuid),
    name: String(meta.name),
    author: strOrUndefined(meta.author),
    logo: strOrUndefined(meta.logo),
    description: strOrUndefined(meta.description),
    homepage: urls[0] || '',
    urls,
    enabled: meta.enabled === true,
    sourceType: typeof meta.sourceType === 'string' ? meta.sourceType : 'novel',
    sourceVersion: strOrUndefined(meta.version),
    updateUrl: strOrUndefined(meta.updateUrl),
    tags: strArr(meta.tags),
    minDelayMs:
      typeof meta.minDelayMs === 'number' && Number.isFinite(meta.minDelayMs) ? meta.minDelayMs : 0,
    requireUrls: strArr(meta.requireUrls),
    headers: {},
    rules: {
      siteName: '',
      searchPath: '',
      searchItemPattern: '',
      bookTitlePattern: '',
      bookAuthorPattern: '',
      chapterItemPattern: '',
      contentPattern: '',
    },
  };
}

/** 骨架源占位 rules（与 legado-translator.ts makeSkeleton 同款：css:body 无害占位） */
function skeletonRules(siteName: string): SourceRulesDoc {
  return {
    siteName,
    searchPath: '/search?keyword={keyword}',
    searchItemPattern: 'css:body',
    bookTitlePattern: 'css:body',
    bookAuthorPattern: 'css:body',
    chapterItemPattern: 'css:body',
    contentPattern: 'css:body',
  };
}

/**
 * 迁移单个 .js 的纯判定（无 IO）：
 * 返回 'skeleton'（带 legadoRaw）/ 'ok'（带 rules+headers）/ 'needs-manual'（带原因）。
 */
function classifyContent(
  content: string,
  meta: Record<string, unknown>,
):
  | { kind: 'skeleton'; legadoRaw: string }
  | { kind: 'ok'; rules: SourceRulesDoc; headers: Record<string, string> }
  | { kind: 'needs-manual'; reason: string } {
  if (isSkeletonSource(content)) {
    const legadoRaw = extractLegadoRaw(content);
    if (!legadoRaw) {
      return { kind: 'needs-manual', reason: 'legado 骨架源内嵌原始 JSON 提取失败' };
    }
    return { kind: 'skeleton', legadoRaw };
  }
  const violations = findTemplateViolations(stripLeadingCommentBlock(content));
  if (violations.length > 0) {
    return { kind: 'needs-manual', reason: `含模板外语句（${violations.join('；')}）` };
  }
  const rules = extractRulesFromJs(content);
  if (!rules) {
    return {
      kind: 'needs-manual',
      reason: '必填规则缺失或为空（siteName/searchPath/条目/详情/目录/正文）',
    };
  }
  if (strArr(meta.urls).length === 0) {
    return { kind: 'needs-manual', reason: 'meta.urls 为空（缺 @url 头）' };
  }
  return { kind: 'ok', rules, headers: extractHeaders(content) };
}

/** 读目录内 marker 覆盖（<fileName>.disabled 优先于 .enabled） */
function markerOverride(dir: string, fileName: string): boolean | null {
  if (fs.existsSync(path.join(dir, fileName + '.disabled'))) return false;
  if (fs.existsSync(path.join(dir, fileName + '.enabled'))) return true;
  return null;
}

/** 搬一个文件到 legacy 目录（同名）；返回 null = 成功，否则错误消息 */
function moveToLegacy(legacyDir: string, srcPath: string, fileName: string): string | null {
  try {
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.renameSync(srcPath, path.join(legacyDir, fileName));
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

/**
 * 迁移主流程：扫描 <userData>/booksources/*.js，逐文件按 §4.2 流程处理，
 * 有条目时把报告写到 <userData>/booksource-migration-report.json（目录外，R14）。
 * 无任何 .js 时不写报告（全新安装每次启动不该产噪音）。
 */
export function migrateBookSources(userData: string): MigrationReport {
  const dir = path.join(userData, PRIMARY_DIR);
  const legacyDir = path.join(userData, LEGACY_DIR);
  const entries: MigrationEntry[] = [];

  const fileNames = fs.existsSync(dir)
    ? fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile() && path.extname(e.name).toLowerCase() === '.js')
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b))
    : [];

  for (const fileName of fileNames) {
    const jsPath = path.join(dir, fileName);
    let content: string;
    let stat: fs.Stats;
    try {
      content = fs.readFileSync(jsPath, 'utf-8');
      stat = fs.statSync(jsPath);
    } catch (err) {
      entries.push({
        fileName,
        uuid: fileName,
        outcome: 'needs-manual',
        reason: `读取失败: ${(err as Error).message}`,
      });
      continue;
    }

    // marker 覆盖优先进 meta.enabled（迁移时 marker 仍覆盖一次后删除，§3.4）
    const meta = parseHeaderMeta(
      content,
      fileName,
      dir,
      stat.size,
      stat.mtimeMs,
      markerOverride(dir, fileName),
    );
    // 头缺 @uuid 时 parseHeaderMeta 已回退为 fileName（带扩展名，booksource-meta.ts:142，D6 硬验收前提）
    const uuid = String(meta.uuid);
    const jsonFileName = fileName.replace(/\.js$/i, '.json');
    const jsonPath = path.join(dir, jsonFileName);

    // 幂等（唯一口径）：.json 已存在且 uuid 相同 → 跳过整个文件（不动 .js 也不覆盖 .json）
    if (fs.existsSync(jsonPath)) {
      let existingUuid: string | null = null;
      try {
        const existing = JSON.parse(fs.readFileSync(jsonPath, 'utf-8')) as Record<string, unknown>;
        if (existing && existing.format === 'pomreader.booksource') {
          existingUuid = typeof existing.uuid === 'string' ? existing.uuid : null;
        }
      } catch {
        /* 无法解析按不一致处理 */
      }
      if (existingUuid === uuid) {
        entries.push({ fileName, uuid, outcome: 'skipped', jsonFileName });
        continue;
      }
      // 同名 JSON 被占（uuid 不一致/无法解析）：保守归 needs-manual，保留现有 JSON，
      // .js 连带 marker 搬入 legacy（留原地会每次启动重复报警）
      const moveErr = moveToLegacy(legacyDir, jsPath, fileName);
      const markerErr = moveMarkersToLegacy(legacyDir, dir, fileName);
      entries.push({
        fileName,
        uuid,
        outcome: 'needs-manual',
        reason:
          '同名 .json 已存在且 uuid 不一致或无法解析（保留现有 JSON）' +
          [moveErr, markerErr]
            .filter(Boolean)
            .map((e) => `；移动失败: ${e}`)
            .join(''),
      });
      continue;
    }

    const classified = classifyContent(content, meta);

    if (classified.kind === 'needs-manual') {
      // 三条 needs-manual 分支统一：移 .js + 连带搬 marker 到 legacy（不产 JSON，§4.2/E4）
      const moveErr = moveToLegacy(legacyDir, jsPath, fileName);
      const markerErr = moveMarkersToLegacy(legacyDir, dir, fileName);
      entries.push({
        fileName,
        uuid,
        outcome: 'needs-manual',
        reason:
          classified.reason +
          [moveErr, markerErr]
            .filter(Boolean)
            .map((e) => `；移动失败: ${e}`)
            .join(''),
      });
      continue;
    }

    const doc = docFromMeta(meta);
    if (classified.kind === 'skeleton') {
      // 骨架源不是 needs-manual（F8）：enabled:false + legadoRaw + 无害占位 rules
      doc.enabled = false;
      doc.rules = skeletonRules(String(meta.name));
      doc.legadoRaw = classified.legadoRaw;
      const note =
        'legado 骨架源迁移：rules 为占位（css:body），请补全规则后再启用；原始 legado JSON 见 legadoRaw 字段。';
      doc.description = doc.description ? `${doc.description}\n${note}` : note;
    } else {
      doc.rules = classified.rules;
      doc.headers = classified.headers;
    }

    // 结构校验（完整 valibot 在渲染端，跨边界不可达 → 用结构探针，§3.4/R5）
    const invalid = validateBookSourceDocStructure(doc as unknown as Record<string, unknown>);
    if (invalid) {
      const moveErr = moveToLegacy(legacyDir, jsPath, fileName);
      const markerErr = moveMarkersToLegacy(legacyDir, dir, fileName);
      entries.push({
        fileName,
        uuid,
        outcome: 'needs-manual',
        reason:
          `结构校验失败: ${invalid}` +
          [moveErr, markerErr]
            .filter(Boolean)
            .map((e) => `；移动失败: ${e}`)
            .join(''),
      });
      continue;
    }

    // 成功路径：写 .json（atomicWrite）→ 移 .js 到 legacy（失败只记录不阻断）→ 删 marker
    //（enabled 已并入 doc.enabled，marker 不搬只删）
    atomicWrite(jsonPath, JSON.stringify(doc, null, 2));
    const moveErr = moveToLegacy(legacyDir, jsPath, fileName);
    deleteMarkers(dir, fileName);
    entries.push({
      fileName,
      uuid,
      outcome: classified.kind === 'skeleton' ? 'skeleton' : 'migrated',
      jsonFileName,
      ...(moveErr ? { reason: `.js 移入 legacy 失败（不阻断）: ${moveErr}` } : {}),
    });
  }

  const report: MigrationReport = {
    generatedAt: new Date().toISOString(),
    legacyDir,
    totals: {
      total: entries.length,
      migrated: entries.filter((e) => e.outcome === 'migrated').length,
      skeleton: entries.filter((e) => e.outcome === 'skeleton').length,
      needsManual: entries.filter((e) => e.outcome === 'needs-manual').length,
      skipped: entries.filter((e) => e.outcome === 'skipped').length,
    },
    entries,
  };

  if (entries.length > 0) {
    try {
      atomicWrite(path.join(userData, REPORT_FILE), JSON.stringify(report, null, 2));
    } catch (err) {
      // 报告写失败不阻断迁移结果（main.ts 只 console.warn）
      console.warn('[booksource-migrate] 迁移报告写入失败:', (err as Error).message);
    }
  }
  return report;
}

/** 连带搬 marker 到 legacy 同名（foo.js.enabled → legacy/foo.js.enabled）；返回首个错误消息或 null */
function moveMarkersToLegacy(legacyDir: string, dir: string, fileName: string): string | null {
  for (const suffix of ['.enabled', '.disabled']) {
    const marker = path.join(dir, fileName + suffix);
    if (!fs.existsSync(marker)) continue;
    const err = moveToLegacy(legacyDir, marker, fileName + suffix);
    if (err) return err;
  }
  return null;
}

/** 删除 booksources/ 内的 marker（成功路径：enabled 已并入 doc.enabled） */
function deleteMarkers(dir: string, fileName: string): void {
  for (const suffix of ['.enabled', '.disabled']) {
    const marker = path.join(dir, fileName + suffix);
    try {
      if (fs.existsSync(marker)) fs.unlinkSync(marker);
    } catch {
      /* 删 marker 失败不阻断（下次启动 json 已存在 → 自然跳过） */
    }
  }
}

/**
 * 读一次性迁移报告（pom:booksource-migration-report），**读后删**；
 * 无报告 / 解析失败 → null（解析失败同样删除，避免坏文件每次启动反复读）
 */
export function readMigrationReportOnce(userData: string): MigrationReport | null {
  const p = path.join(userData, REPORT_FILE);
  if (!fs.existsSync(p)) return null;
  let report: MigrationReport | null = null;
  try {
    report = JSON.parse(fs.readFileSync(p, 'utf-8')) as MigrationReport;
  } catch {
    report = null;
  }
  try {
    fs.unlinkSync(p);
  } catch {
    /* noop */
  }
  return report;
}

/**
 * 常驻扫描 booksources_legacy/（pom:booksource-legacy-list，§4.3 行内状态数据源）。
 * enabled 由 legacy 目录内 marker + 头部 @enabled 得出；reason 用同一套分类逻辑重新判定
 * （纯模板可转换/已正常归档的条目无 reason）。
 */
export function scanLegacyDir(userData: string): LegacyItem[] {
  const legacyDir = path.join(userData, LEGACY_DIR);
  if (!fs.existsSync(legacyDir)) return [];
  const out: LegacyItem[] = [];
  for (const entry of fs.readdirSync(legacyDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (path.extname(entry.name).toLowerCase() !== '.js') continue;
    const full = path.join(legacyDir, entry.name);
    let content: string;
    let stat: fs.Stats;
    try {
      content = fs.readFileSync(full, 'utf-8');
      stat = fs.statSync(full);
    } catch {
      out.push({ fileName: entry.name, enabled: false, reason: '读取失败' });
      continue;
    }
    const meta = parseHeaderMeta(
      content,
      entry.name,
      legacyDir,
      stat.size,
      stat.mtimeMs,
      markerOverride(legacyDir, entry.name),
    );
    const classified = classifyContent(content, meta);
    out.push({
      fileName: entry.name,
      enabled: meta.enabled === true,
      ...(classified.kind === 'needs-manual' ? { reason: classified.reason } : {}),
      ...(classified.kind === 'skeleton'
        ? { reason: 'legado 骨架源（已转换为禁用的 JSON 书源）' }
        : {}),
    });
  }
  out.sort((a, b) => a.fileName.localeCompare(b.fileName));
  return out;
}

/**
 * 注册迁移相关 IPC channel（§3.4 新增 3 个）：
 * - pom:booksource-convert：手动批量重触发迁移（主进程内完成，原子写），返回报告
 * - pom:booksource-migration-report：读一次性迁移报告（读后删），无报告返回 null
 * - pom:booksource-legacy-list：常驻扫描 booksources_legacy/
 */
export function registerBookSourceMigrationHandlers(ipcMain: IpcMain, userData: string): void {
  ipcMain.handle('pom:booksource-convert', () => migrateBookSources(userData));
  ipcMain.handle('pom:booksource-migration-report', () => readMigrationReportOnce(userData));
  ipcMain.handle('pom:booksource-legacy-list', () => scanLegacyDir(userData));
}
