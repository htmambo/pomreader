#!/usr/bin/env node
/**
 * P0 书源存量盘点（只读）—— 扫描 userData/booksources 下的存量 JS 书源并产出报告。
 * 方案依据：docs/Architecture/2026-09-29-BOOKSOURCE-JSON-RULES-PLAN.md §4.1（盘点项）/ §4.2（白名单判定）
 *
 * 用法：
 *   node scripts/audit-booksources.ts [书源目录] [--out report.json]
 *   书源目录缺省时自动探测 <userData>/booksources（Linux: ~/.config/pomreader|白虎阅读/booksources）
 *
 * ⚠️ 自包含约束：本脚本用 node 原生 type stripping 直接运行（Node ≥ 22.18），
 * 不得 import src/ 下的 Angular 文件（装饰器链跑不动）。所需常量清单在下方复制并注明来源行号。
 * ⚠️ 只读：严禁修改 / 移动 / 删除任何书源文件，本脚本只调用 readFileSync / readdirSync / existsSync。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ── 常量清单（复制自源码，勿 import；来源行号随版本漂移时以文件内容为准）────────────────

/** 15 个规则常量 —— smart-rules.ts:506-520（generateSourceCode 模板常量段） */
const RULE_CONSTS = [
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
] as const;

/**
 * 必填规则常量（6 个）—— 方案 §3.1 对照表（7 必填中 siteName 对应 `// @name`，单独判定）：
 * searchPath / searchItemPattern / bookTitlePattern / bookAuthorPattern / chapterItemPattern / contentPattern
 */
const REQUIRED_RULE_CONSTS = [
  'SEARCH_PATH',
  'SEARCH_ITEM_RULE',
  'BOOK_TITLE_RULE',
  'BOOK_AUTHOR_RULE',
  'CHAPTER_ITEM_RULE',
  'CONTENT_RULE',
] as const;

/** 模板固定函数白名单 —— smart-rules.ts:524-748 生成代码段（与方案 §4.2 WHITELIST_FUNCTIONS 一致） */
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

/**
 * 模板常量白名单 = 15 规则常量 + BASE_URL / HEADERS / REGEX_HINT_CHARS / MAX_EXTRACT_LINKS
 * —— smart-rules.ts:502-503,523,539（F1：模板内 const 共 19 个）
 */
const WHITELIST_CONSTS = new Set([
  ...RULE_CONSTS,
  'BASE_URL',
  'HEADERS',
  'REGEX_HINT_CHARS',
  'MAX_EXTRACT_LINKS',
]);

/** 规则串长度上限 —— 方案 §3.2 guard.ts 表（≤ 512 字符） */
const RULE_MAX_LEN = 512;

// ── 类型 ────────────────────────────────────────────────────────────────

interface HeaderInfo {
  uuid: string | null;
  name: string | null;
  enabled: boolean | null;
}

interface PatternHit {
  fileName: string;
  constName: string;
  detail?: string;
}

interface SourceAudit {
  fileName: string;
  /** uuid 回退规则同 booksource-meta.ts:142：`@uuid || fileName`（带扩展名，不剥 .js） */
  uuid: string;
  /** name 回退规则同 booksource-meta.ts:150：剥掉 .js */
  name: string;
  enabled: boolean;
  enabledBy: 'marker-disabled' | 'marker-enabled' | 'header' | 'default';
  isSkeleton: boolean;
  missingRuleConsts: string[];
  /** 必填缺失：6 个必填常量或 `// @name` */
  missingRequired: string[];
  templateViolations: string[];
  handEdited: boolean;
}

interface AuditReport {
  generatedAt: string;
  dir: string;
  readOnly: true;
  totals: {
    sources: number;
    enabled: number;
    disabled: number;
    skeletons: number;
    handEdited: number;
    pureTemplate: number;
    missingRequired: number;
  };
  /** 15 个规则常量各自的缺失源数量（字段完整度） */
  fieldCompleteness: Record<string, number>;
  handEditedSources: { fileName: string; violations: string[] }[];
  skeletonSources: string[];
  missingRequiredSources: { fileName: string; missing: string[] }[];
  specialPatterns: {
    nestedQuantifierRegex: PatternHit[];
    doubleBrace: PatternHit[];
    jsonpath: PatternHit[];
    overlongRules: PatternHit[];
  };
  uuidReferences: { status: 'ok' | 'skipped'; reason?: string; byUuid?: Record<string, number> };
  sources: SourceAudit[];
}

// ── 解析（镜像 electron/ipc/booksource-meta.ts 的子集，纯函数）─────────────────────────

/**
 * 头部 `// @key value` 解析（只取盘点需要的 uuid / name / enabled 三键，
 * 语义对齐 booksource-meta.ts:51-139：扫全部行、同键取首个非空值）。
 */
function parseHeader(content: string): HeaderInfo {
  let uuid: string | null = null;
  let name: string | null = null;
  let enabled: boolean | null = null;
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith('//')) continue;
    const body = trimmed.replace(/^\/+/, '').trimStart();
    if (!body.startsWith('@')) continue;
    const rest = body.slice(1);
    const ws = rest.search(/\s/);
    const key = ws === -1 ? rest : rest.slice(0, ws);
    const value = (ws === -1 ? '' : rest.slice(ws + 1)).trim();
    if (key === 'uuid' && !uuid && value) uuid = value;
    else if (key === 'name' && !name && value) name = value;
    else if (key === 'enabled' && enabled === null) {
      enabled = !(value === 'false' || value === '0' || value === 'no');
    }
  }
  return { uuid, name, enabled };
}

/**
 * 启停判定（对齐 booksource-meta.ts:184-188 / booksource-handler.ts:137-138）：
 * marker 文件优先（`<fileName>.disabled` > `<fileName>.enabled`，fileName 带扩展名），
 * 其次头部 `@enabled`，缺省 true。
 */
function resolveEnabled(
  dir: string,
  fileName: string,
  headerEnabled: boolean | null,
): { enabled: boolean; enabledBy: SourceAudit['enabledBy'] } {
  if (fs.existsSync(path.join(dir, fileName + '.disabled'))) {
    return { enabled: false, enabledBy: 'marker-disabled' };
  }
  if (fs.existsSync(path.join(dir, fileName + '.enabled'))) {
    return { enabled: true, enabledBy: 'marker-enabled' };
  }
  if (headerEnabled !== null) return { enabled: headerEnabled, enabledBy: 'header' };
  return { enabled: true, enabledBy: 'default' };
}

/** legado 骨架源特征（F8，legado-translator.ts:126-166 makeSkeleton）：stub 抛错 + 注释内嵌原始 JSON */
function isSkeletonSource(content: string): boolean {
  return content.includes('此源由 legado 导入') && content.includes('原始 Legado JSON');
}

/** 剥离头部连续 `//` 注释块（含其间空行）—— 方案 §4.2 isPureTemplate 第 1 步 */
function stripLeadingCommentBlock(content: string): string[] {
  const lines = content.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && (lines[i].trim() === '' || lines[i].trimStart().startsWith('//'))) {
    i++;
  }
  return lines.slice(i);
}

/**
 * 手改检测（方案 §4.2 isPureTemplate，结构白名单，禁字节比对）：
 * 剥头部注释后逐行扫**顶层语句**（行首无缩进）——
 * `function` 声明名必须命中 WHITELIST_FUNCTIONS，`const` 声明名必须命中 WHITELIST_CONSTS，
 * 其余顶层语句（赋值 / 调用 / let / var / class / export 等）一律判手改。
 * 缩进行视为函数体内语句，不参与判定（模板函数体内有 `let m` / `const out` 等局部声明）。
 * 顶层 JSDoc 块注释（星号斜杠包裹、可跨行）跳过 —— 模板在函数间大量存在（smart-rules.ts:531,561 等）。
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

/** 取 `const NAME = <rhs>` 的 RHS 原始文本（单行；模板产出的常量均为单行） */
function extractConstRhs(content: string, name: string): string | null {
  const m = new RegExp(`^const\\s+${name}\\s*=\\s*(.+?)\\s*;?\\s*$`, 'm').exec(content);
  return m ? m[1] : null;
}

/** RHS 若为字符串字面量（'...' / "..." / `...`）则返回去引号后的文本，否则返回 null */
function stringLiteralValue(rhs: string): string | null {
  const q = rhs[0];
  if ((q === "'" || q === '"' || q === '`') && rhs.length >= 2 && rhs.endsWith(q)) {
    return rhs.slice(1, -1);
  }
  return null;
}

/** 嵌套量词形态（(a+)+ / (a*)*）：含量词的组后紧跟量词 —— 方案 §3.2 guard 表 */
const NESTED_QUANTIFIER_RE = /\([^()]*[+*][^()]*\)\s*[+*?]/;

// ── 目录探测 ────────────────────────────────────────────────────────────

/**
 * 自动探测 <userData>/booksources。
 * userData = appData/<name>：dev 用 package.json name（pomreader），打包后用 productName（白虎阅读）。
 */
function probeBooksourcesDir(): string | null {
  const appDataDirs: string[] = [];
  if (process.platform === 'darwin') {
    appDataDirs.push(path.join(os.homedir(), 'Library', 'Application Support'));
  } else if (process.platform === 'win32') {
    if (process.env.APPDATA) appDataDirs.push(process.env.APPDATA);
  } else {
    appDataDirs.push(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'));
  }
  for (const base of appDataDirs) {
    for (const appName of ['pomreader', '白虎阅读']) {
      const dir = path.join(base, appName, 'booksources');
      if (fs.existsSync(dir)) return dir;
    }
  }
  return null;
}

// ── 主流程 ──────────────────────────────────────────────────────────────

function printUsage(): void {
  console.log(`用法: node scripts/audit-booksources.ts [书源目录] [--out report.json]

P0 书源存量盘点（只读）：扫描存量 JS 书源，产出总数/启停/字段完整度/手改检测/
特殊模式命中/uuid 引用统计报告。方案：docs/Architecture/2026-09-29-BOOKSOURCE-JSON-RULES-PLAN.md §4.1

参数:
  [书源目录]     booksources 目录路径；缺省自动探测 <userData>/booksources
  --out <file>   同时把完整报告写成 JSON 文件（缺省只打印人类可读报告到 stdout）
  --help, -h     打印本说明

示例:
  node scripts/audit-booksources.ts
  node scripts/audit-booksources.ts ~/.config/pomreader/booksources --out /tmp/audit.json`);
}

function auditDir(dir: string): AuditReport {
  const fileNames = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && path.extname(e.name).toLowerCase() === '.js')
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));

  const sources: SourceAudit[] = [];
  const fieldCompleteness: Record<string, number> = Object.fromEntries(
    RULE_CONSTS.map((c) => [c, 0]),
  );
  const specialPatterns: AuditReport['specialPatterns'] = {
    nestedQuantifierRegex: [],
    doubleBrace: [],
    jsonpath: [],
    overlongRules: [],
  };

  for (const fileName of fileNames) {
    const content = fs.readFileSync(path.join(dir, fileName), 'utf-8');
    const header = parseHeader(content);
    const { enabled, enabledBy } = resolveEnabled(dir, fileName, header.enabled);
    const skeleton = isSkeletonSource(content);
    const bodyLines = stripLeadingCommentBlock(content);
    const violations = skeleton ? [] : findTemplateViolations(bodyLines);

    const missingRuleConsts = RULE_CONSTS.filter((c) => extractConstRhs(content, c) === null);
    // 骨架源按迁移算法走独立分支（enabled:false + legadoRaw，§4.2），不进字段完整度/必填缺失统计
    if (!skeleton) for (const c of missingRuleConsts) fieldCompleteness[c]++;
    const missingRequired = skeleton
      ? []
      : [
          ...REQUIRED_RULE_CONSTS.filter((c) => missingRuleConsts.includes(c)),
          ...(header.name ? [] : ['// @name']),
        ];

    // 特殊模式：只扫规则常量 RHS（不扫全文，避免骨架源注释内嵌的原始 JSON 误命中）
    for (const c of RULE_CONSTS) {
      const rhs = extractConstRhs(content, c);
      if (rhs === null) continue;
      if (NESTED_QUANTIFIER_RE.test(rhs)) {
        specialPatterns.nestedQuantifierRegex.push({ fileName, constName: c });
      }
      if (rhs.includes('{{')) specialPatterns.doubleBrace.push({ fileName, constName: c });
      if (/\$\.[A-Za-z]/.test(rhs)) specialPatterns.jsonpath.push({ fileName, constName: c });
      const strVal = stringLiteralValue(rhs);
      if (strVal !== null && strVal.length > RULE_MAX_LEN) {
        specialPatterns.overlongRules.push({
          fileName,
          constName: c,
          detail: `${strVal.length} 字符`,
        });
      }
    }

    sources.push({
      fileName,
      uuid: header.uuid || fileName,
      name: header.name || fileName.replace(/\.js$/i, ''),
      enabled,
      enabledBy,
      isSkeleton: skeleton,
      missingRuleConsts,
      missingRequired,
      templateViolations: violations,
      handEdited: violations.length > 0,
    });
  }

  // Book.bookSourceUuid 引用统计：书籍存于隐藏窗口的 PouchDB(IndexedDB)
  // （electron/db/db-renderer.ts，DB_NAME 'pomreader'，pouchdb-browser 浏览器版），
  // 数据落在 <userData>/IndexedDB/*.indexeddb.leveldb（Chromium LevelDB 格式）。
  // 本脚本不引入新 npm 依赖，node_modules 中无 level/pouchdb-node 可用 → 优雅降级。
  const idbDir = path.join(path.dirname(dir), 'IndexedDB');
  const idbNote = fs.existsSync(idbDir) ? `（已定位 ${idbDir}）` : '（未找到 IndexedDB 目录）';
  const uuidReferences: AuditReport['uuidReferences'] = {
    status: 'skipped',
    reason:
      '书籍存储为隐藏窗口 PouchDB(IndexedDB)（Chromium LevelDB 格式），脚本环境无可用 level/pouchdb-node 包' +
      `且不得引入新 npm 依赖，无法离线读取，跳过该统计${idbNote}。` +
      '迁移前请在运行中的应用内补充该统计（或评估临时安装 level 包读取）。',
  };

  const enabledCount = sources.filter((s) => s.enabled).length;
  return {
    generatedAt: new Date().toISOString(),
    dir,
    readOnly: true,
    totals: {
      sources: sources.length,
      enabled: enabledCount,
      disabled: sources.length - enabledCount,
      skeletons: sources.filter((s) => s.isSkeleton).length,
      handEdited: sources.filter((s) => s.handEdited).length,
      pureTemplate: sources.filter((s) => !s.handEdited && !s.isSkeleton).length,
      missingRequired: sources.filter((s) => s.missingRequired.length > 0).length,
    },
    fieldCompleteness,
    handEditedSources: sources
      .filter((s) => s.handEdited)
      .map((s) => ({ fileName: s.fileName, violations: s.templateViolations })),
    skeletonSources: sources.filter((s) => s.isSkeleton).map((s) => s.fileName),
    missingRequiredSources: sources
      .filter((s) => s.missingRequired.length > 0)
      .map((s) => ({ fileName: s.fileName, missing: s.missingRequired })),
    specialPatterns,
    uuidReferences,
    sources,
  };
}

function printHumanReport(r: AuditReport): void {
  const t = r.totals;
  console.log('═══ 书源存量盘点报告（P0，只读）═══');
  console.log(`目录: ${r.dir}`);
  console.log(`时间: ${r.generatedAt}`);
  console.log('');
  console.log('── 概览 ──');
  console.log(`源总数: ${t.sources}（启用 ${t.enabled} / 禁用 ${t.disabled}）`);
  console.log(
    `纯模板源: ${t.pureTemplate} · 手改源: ${t.handEdited} · legado 骨架源: ${t.skeletons}`,
  );
  console.log(`缺必填项源: ${t.missingRequired}`);
  if (t.sources > 0) {
    const ratio = ((t.handEdited / t.sources) * 100).toFixed(1);
    console.log(`手改比例: ${ratio}%（D1 细部判据：<5% 停用归档即可；≥5% 加强 needs-manual UI）`);
  }
  console.log('');
  console.log('── 字段完整度（15 个规则常量各自的缺失源数）──');
  for (const c of RULE_CONSTS) {
    const n = r.fieldCompleteness[c];
    const required = (REQUIRED_RULE_CONSTS as readonly string[]).includes(c) ? '（必填）' : '';
    if (n > 0) console.log(`  ${c}${required}: 缺失 ${n}`);
  }
  if (Object.values(r.fieldCompleteness).every((n) => n === 0)) console.log('  全部常量齐备');
  const missingName = r.sources.filter((s) => s.missingRequired.includes('// @name')).length;
  if (missingName > 0) console.log(`  // @name（必填）: 缺失 ${missingName}`);
  console.log('');
  console.log('── 手改检测（白名单外声明 / 模板外顶层语句）──');
  if (r.handEditedSources.length === 0) console.log('  无手改源');
  for (const s of r.handEditedSources) {
    console.log(`  ${s.fileName}:`);
    for (const v of s.violations) console.log(`    - ${v}`);
  }
  console.log('');
  console.log('── legado 骨架源 ──');
  if (r.skeletonSources.length === 0) console.log('  无');
  for (const f of r.skeletonSources) console.log(`  ${f}`);
  console.log('');
  console.log('── 特殊模式命中 ──');
  const sp = r.specialPatterns;
  const fmtHits = (hits: PatternHit[]): string =>
    hits.map((h) => `${h.fileName}:${h.constName}${h.detail ? `(${h.detail})` : ''}`).join(', ');
  console.log(`  嵌套量词正则: ${sp.nestedQuantifierRegex.length} 处`);
  if (sp.nestedQuantifierRegex.length) console.log(`    ${fmtHits(sp.nestedQuantifierRegex)}`);
  console.log(`  {{ 模板语法: ${sp.doubleBrace.length} 处`);
  if (sp.doubleBrace.length) console.log(`    ${fmtHits(sp.doubleBrace)}`);
  console.log(`  $.jsonpath: ${sp.jsonpath.length} 处`);
  if (sp.jsonpath.length) console.log(`    ${fmtHits(sp.jsonpath)}`);
  console.log(`  超长规则串(>${RULE_MAX_LEN} 字符): ${sp.overlongRules.length} 处`);
  if (sp.overlongRules.length) console.log(`    ${fmtHits(sp.overlongRules)}`);
  console.log('');
  console.log('── Book.bookSourceUuid 引用统计 ──');
  if (r.uuidReferences.status === 'skipped') {
    console.log(`  已跳过: ${r.uuidReferences.reason}`);
  } else {
    for (const [uuid, n] of Object.entries(r.uuidReferences.byUuid ?? {})) {
      console.log(`  ${uuid}: ${n} 本书`);
    }
  }
  if (r.missingRequiredSources.length > 0) {
    console.log('');
    console.log('── 缺必填项源明细 ──');
    for (const s of r.missingRequiredSources) {
      console.log(`  ${s.fileName}: 缺 ${s.missing.join(', ')}`);
    }
  }
}

function main(): void {
  const args = process.argv.slice(2);
  let dir: string | null = null;
  let outFile: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') {
      printUsage();
      return;
    } else if (a === '--out') {
      outFile = args[++i] ?? null;
      if (!outFile) {
        console.error('--out 需要一个文件路径参数');
        process.exitCode = 2;
        return;
      }
    } else if (a.startsWith('--')) {
      console.error(`未知参数: ${a}`);
      printUsage();
      process.exitCode = 2;
      return;
    } else if (dir === null) {
      dir = a;
    } else {
      console.error(`多余的位置参数: ${a}`);
      process.exitCode = 2;
      return;
    }
  }

  if (dir === null) {
    dir = probeBooksourcesDir();
    if (dir === null) {
      console.error(
        '未探测到 <userData>/booksources 目录，请显式传入书源目录路径（--help 查看用法）',
      );
      process.exitCode = 2;
      return;
    }
    console.log(`（自动探测到书源目录: ${dir}）\n`);
  }
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    console.error(`书源目录不存在或不是目录: ${dir}`);
    process.exitCode = 2;
    return;
  }

  const report = auditDir(dir);
  printHumanReport(report);
  if (outFile) {
    fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n', 'utf-8');
    console.log(`\n完整 JSON 报告已写入: ${outFile}`);
  }
}

main();
