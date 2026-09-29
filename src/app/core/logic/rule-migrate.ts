/**
 * 存量 `.js` 书源 → `.json` 规则文档的**迁移判定**（书源 JSON 规则化 P3.1）
 *
 * 纯函数：输入「一个 `.js` 文件的全文 + 主进程扫出的 meta」，输出**该文件该怎么办**。
 * IO（读文件 / 写 JSON / 归档 `.js`）全在 `core/services/book-source-migrate.service.ts`，
 * 本文件只做判定 —— 这样每条判定分支都能用构造出来的字符串直接测，不需要真磁盘。
 *
 * ## 判定为什么必须保守
 *
 * 错迁的代价是**静默的**：用户看到源还在列表里、能编辑，但抓取行为悄悄变了，且没有任何报错。
 * 反过来，误判 needs-manual 只是让用户在列表里看到一行标灰 + 一句原因，点进去还能拿到原始 `.js`。
 * 故一律「宁可误归 needs-manual 不可错迁」（方案 §4.2 判定策略）。
 *
 * ## 三条出口
 *
 * 1. `convert` —— 纯模板源，产出可写盘的 `BookSourceDoc`（含 legado 骨架源：产出 `enabled:false` + `legadoRaw`）；
 * 2. `needs-manual` —— 判不了，**不产 JSON**，调用方只把 `.js` 归档（用户仍能在列表里看到并捞回）；
 * 3. `skip` —— 同 uuid 的 `.json` 已存在，整文件跳过（用户手改过的 JSON 不被覆盖）。
 *
 * ## 幂等口径（方案 §4.2 唯一口径）
 *
 * 成功路径把 `.js` 移走、`needs-manual` 路径也移走，所以"扫描集里还在"就等于"没处理过"。
 * 本文件因此**不涉及任何时间戳比较**，也不需要 mtime。
 */
import * as v from 'valibot';
import { parseJsSource, TEMPLATE_CONST_NAMES } from './rule-parse';
import { buildSourceDoc } from './source-doc-build';
import {
  BookSourceDocSchema,
  SOURCE_TYPES,
  type BookSourceDocDraft,
  type SourceType,
} from '../models/book-source-doc.model';
import { translateLegadoToDoc } from '../book-source/legado/legado-translator';
import type { LegadoSource } from '../book-source/legado/legado-types';

/** 报告里的一条记录 */
export interface MigrationItem {
  /** 旧 `.js` 文件名 */
  fileName: string;
  /** 新 `.json` 文件名（needs-manual 时缺席） */
  jsonFileName?: string;
  /** 人类可读原因：needs-manual / failed 必填，convert 时写"为什么能转" */
  reason: string;
}

export type MigrateResult =
  | { outcome: 'convert'; doc: BookSourceDocDraft; item: MigrationItem; isSkeleton: boolean }
  | { outcome: 'needs-manual'; item: MigrationItem }
  | { outcome: 'skip'; item: MigrationItem };

/**
 * 一次迁移的汇总报告（落盘到 `booksources_migration_report.json`，管理页读一次即删）
 *
 * 形状**唯一**：主进程在"报告文件本身损坏"时也返回同一套键（P2.2 遗留的旧实现返回过
 * `{needsManual: true, failed:[{fileName, error}]}`，字段名与形状都不同，渲染端只能崩或显示空）。
 * 消费方不需要为坏路径写第二套解析。
 */
export interface MigrationReport {
  /** 报告生成时间（ISO 8601） */
  at: string;
  /** 成功转成 `.json` 的源 */
  converted: MigrationItem[];
  /** 判不了、只归档了 `.js` 的源（用户可在列表页看到并捞回） */
  needsManual: MigrationItem[];
  /** 迁移过程本身出错的源（读文件失败 / 落盘失败等）—— 与 needs-manual 是两回事 */
  failed: MigrationItem[];
  /** 因同 uuid 的 JSON 已存在而整文件跳过的数量 */
  skipped: number;
}

/**
 * 报告是否"无实质内容"（`true` → 不必落盘）
 *
 * `skipped` **不计入**空判定：一份只有 `skipped: 3` 的报告什么都没变，落盘只会让
 * 管理页下次进来弹一个零条目的汇总窗口，白挨一次打扰。`skipped` 只是报告的附注。
 */
export function isEmptyReport(report: MigrationReport): boolean {
  return (
    report.converted.length === 0 && report.needsManual.length === 0 && report.failed.length === 0
  );
}

/** 旧 `.js` 源的头部元数据（主进程 `parseHeaderMeta` 的产物，已应用 marker 覆盖） */
export interface LegacyJsMeta {
  fileName: string;
  /** 与 uuid 同值（`parseHeaderMeta` 两个字段都填 `uuid || fileName`） */
  uuid: string;
  name: string;
  url: string;
  urls: string[];
  author: string | null;
  logo: string | null;
  description: string | null;
  /** 已合并 marker 覆盖与 `@enabled` 头的最终状态 */
  enabled: boolean;
  sourceType: SourceType;
  version: string;
  updateUrl: string | null;
  tags: string[];
  minDelayMs: number;
  requireUrls: string[];
}

// ── 头部元数据归一 ─────────────────────────────────────────────────────

/**
 * IPC 传回的是 `Record<string, unknown>`（主进程 `parseHeaderMeta` 的返回类型），
 * 这里逐字段收敛成 `LegacyJsMeta`。**刻意不信任入参形状**：IPC 边界上的任何一侧改了
 * 字段名，症状都应该是"某个字段退回缺省"而不是 `undefined` 顺着流进文档。
 */
export function normalizeLegacyMeta(raw: unknown): LegacyJsMeta {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const fileName = str(o['fileName']);
  const urls = strArray(o['urls']);
  const st = str(o['sourceType']);
  return {
    fileName,
    // uuid 回退**带**扩展名（`booksource-meta.ts:142` 的 `uuid || fileName`）——
    // 这是命名空间连续性的硬要求，剥了会让 `Book.bookSourceUuid` 静默失配
    uuid: str(o['uuid']) || str(o['sourceKey']) || fileName,
    name: str(o['name']) || fileName.replace(/\.js$/i, ''),
    url: str(o['url']) || urls[0] || '',
    urls,
    author: str(o['author']) || null,
    logo: str(o['logo']) || null,
    description: str(o['description']) || null,
    enabled: o['enabled'] !== false,
    sourceType: (SOURCE_TYPES as readonly string[]).includes(st) ? (st as SourceType) : 'novel',
    version: str(o['version']),
    updateUrl: str(o['updateUrl']) || null,
    tags: strArray(o['tags']),
    minDelayMs: num(o['minDelayMs']) && num(o['minDelayMs']) > 0 ? num(o['minDelayMs']) : 0,
    requireUrls: strArray(o['requireUrls']),
  };
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function strArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && !!x);
}

// ── 模板纯净度（手改检测）────────────────────────────────────────────────

/**
 * 模板生成的 16 个函数（取自 `smart-rules.ts` 生成代码段，逐一核对过）
 *
 * ⚠️ 改模板时**必须同步本清单**。漏一个名字的代价是该源被误判 needs-manual；
 * 多一个名字的代价是用户可以把手写逻辑藏进同名函数里骗过检测 —— 后者更危险。
 */
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

/** 模板的 19 个常量：直接复用 `rule-parse.ts` 的清单，不另抄一份 */
const WHITELIST_CONSTS = new Set<string>(TEMPLATE_CONST_NAMES);

/** `return` / `=` 之类后面出现的 `/` 是正则字面量，除法要靠前一字符区分 */
const REGEX_PRECEDING_KEYWORDS = new Set([
  'return',
  'typeof',
  'case',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'instanceof',
  'do',
  'else',
  'yield',
  'await',
]);

export interface PurityVerdict {
  pure: boolean;
  /** 不纯时的原因（直接进 needs-manual 报告，措辞要能让人知道去改哪儿） */
  reason: string | null;
}

/**
 * 手改检测：源码是不是「生成模板原样」的结构
 *
 * ## 为什么是结构白名单而不是逐字节比对
 *
 * 模板版本会漂移（本机存量源里已见到 1.1.0，而方案只记了 1.0.0 / 1.2.0），头部注释的
 * 空格对齐也会因生成器改动而变。逐字节比对会把这些**无害**差异判成手改，于是
 * 大量本可自动迁移的源全被打成 needs-manual —— 比错迁还糟（用户得手工处理每一个）。
 *
 * ## 判据
 *
 * 剥离头部注释块后，**顶层**只允许出现白名单里的 `function` / `const` 声明。
 * 顶层出现任何别的东西（别的函数、别的常量、赋值、表达式语句、`export`、`return`、
 * 被注释掉的代码）都判手改。
 *
 * ## ⚠️ 已知盲区（登记为二期项，不要在文档里写成"全面检测"）
 *
 * 只看**顶层**：在白名单函数体**内部**加语句（改 `search()` 的实现等）检测不到。
 * 代价是这类源会被当作纯模板迁移，用户的手改静默丢失。彻底解决需要逐函数体比对模板
 * 产物，而那正好是被 F15 否掉的方案（模板漂移会误伤）。当前取舍：顶层检测 + 文档留痕。
 */
export function checkPureTemplate(content: string): PurityVerdict {
  // 头部注释块整体豁免：那里的内容是元数据（`// @name …`），不参与"是否纯模板"的判断
  const { body, offset } = stripLeadingHeaderComments(content);
  const skeleton = buildSkeleton(body);
  if (skeleton.commentViolation) return { pure: false, reason: skeleton.commentViolation };
  return findViolation(skeleton.code, content, offset);
}

/** 剥掉开头连续的 `//` 注释行与空行（头部元数据块） */
function stripLeadingHeaderComments(src: string): { body: string; offset: number } {
  let i = 0;
  while (i < src.length) {
    const nl = src.indexOf('\n', i);
    const line = src.slice(i, nl === -1 ? src.length : nl);
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('//')) {
      i = nl === -1 ? src.length : nl + 1;
      continue;
    }
    break;
  }
  return { body: src.slice(i), offset: i };
}

/** 被挖空后的源码：字面量 / 注释位置换成空格（换行保留，行号与列数不变） */
interface Skeleton {
  /** 挖空后的代码；只用于结构分析，不参与任何取值 */
  code: string;
  /** 顶层"被注释掉的代码"命中原因（无则 null） */
  commentViolation: string | null;
}

/**
 * 把字符串 / 模板串 / 正则 / 注释挖成空格，让后面的花括号配对只在**代码**上成立
 *
 * 不挖的话，`/\d{1,3}/` 里的 `{` 会被当代码块开头，后续所有语句的层级判断全部错位 ——
 * 这类正则正是存量源里最常见的自定义痕迹。
 */
function buildSkeleton(src: string): Skeleton {
  const out = src.split('');
  let commentViolation: string | null = null;
  let depth = 0;
  let lastSig = '';
  let prevWord = '';
  const n = src.length;
  let i = 0;

  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== '\n') out[k] = ' ';
  };

  while (i < n) {
    const ch = src[i]!;

    if (ch === '/' && src[i + 1] === '/') {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      // 顶层被注释掉的**代码**（模板自己的小节注释是散文，不会命中）
      if (depth === 0 && !commentViolation) {
        const reason = commentCodeReason(src.slice(i, stop));
        if (reason) commentViolation = reason;
      }
      blank(i, stop);
      i = stop;
      continue;
    }

    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }

    if (ch === '"' || ch === "'") {
      const stop = endOfQuoted(src, i, ch);
      blank(i, stop);
      i = stop;
      lastSig = ch;
      prevWord = '';
      continue;
    }

    if (ch === '`') {
      const stop = endOfTemplate(src, i);
      blank(i, stop);
      i = stop;
      lastSig = ch;
      prevWord = '';
      continue;
    }

    if (ch === '/' && startsRegex(src, i, lastSig, prevWord)) {
      const stop = endOfRegex(src, i);
      blank(i, stop);
      i = stop;
      lastSig = '/';
      prevWord = '';
      continue;
    }

    if (ch === '{') depth++;
    else if (ch === '}') depth = Math.max(0, depth - 1);

    if (!/\s/.test(ch)) {
      lastSig = ch;
      prevWord = isWordChar(ch) ? prevWord + ch : '';
    }
    i++;
  }

  return { code: out.join(''), commentViolation };
}

/** 结束引号之后的位置（处理反斜杠转义） */
function endOfQuoted(src: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < src.length) {
    const c = src[i]!;
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === quote) return i + 1;
    if (c === '\n') return i; // 未闭合：就当到行尾（宁可后面报"结构不对"也别死循环）
    i++;
  }
  return i;
}

/** 结束模板串的位置；`${…}` 内部仍按代码扫描（内部的花括号是真花括号） */
function endOfTemplate(src: string, start: number): number {
  let i = start + 1;
  let exprDepth = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (exprDepth === 0 && c === '`') return i + 1;
    if (c === '$' && src[i + 1] === '{') {
      exprDepth++;
      i += 2;
      continue;
    }
    if (exprDepth > 0) {
      if (c === '{') exprDepth++;
      else if (c === '}') exprDepth--;
    }
    i++;
  }
  return i;
}

/** 结束正则字面量的位置（处理字符类 `[…]` 与转义） */
function endOfRegex(src: string, start: number): number {
  let i = start + 1;
  let inClass = false;
  while (i < src.length) {
    const c = src[i]!;
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '\n') return i; // 正则不跨行
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) {
      i++;
      while (i < src.length && isWordChar(src[i]!)) i++; // 修饰符 gimsuy
      return i;
    }
    i++;
  }
  return i;
}

/** `/` 是正则还是除法：靠**前一个有效字符 / 前一个词**判断 */
function startsRegex(src: string, at: number, lastSig: string, prevWord: string): boolean {
  if (at === 0) return true;
  if (lastSig === '') return true;
  if (isWordChar(lastSig)) return REGEX_PRECEDING_KEYWORDS.has(prevWord);
  // `)` / `]` 结尾是表达式（`f(x) / 2`），其余标点（`( , = : [ ! & | ? { } ; + - * % ~ ^ < >`）都可能是正则
  return !(lastSig === ')' || lastSig === ']');
}

function isWordChar(ch: string): boolean {
  return /[A-Za-z0-9_$]/.test(ch);
}

/** 顶层注释里是否藏着代码（模板的小节注释是散文，命中即手改） */
function commentCodeReason(comment: string): string | null {
  const body = comment.replace(/^\/\/\s?/, '');
  if (
    /^(const|let|var|function|async|class|export|import|return|if|for|while|switch|throw|await|new)\b/.test(
      body,
    )
  ) {
    return `含被注释掉的代码: ${truncate(body)}`;
  }
  return null;
}

function truncate(s: string, max = 40): string {
  const one = s.trim().replace(/\s+/g, ' ');
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

/**
 * 在挖空后的代码里找顶层违规声明
 *
 * 两个容易踩的坑（都已踩过并留了测试）：
 * ① **对象字面量的 `}` 不是语句结尾**。`const A = {…}, B = 2` 里的 `}` 闭合后
 *    仍在本条语句中，若把它当语句边界，紧随其后的 `,` 会被判成"非白名单语句"。
 *    故用栈记录每个 `{` 是**块**（函数体）还是**对象字面量**（由前一个有效字符判定）。
 * ② **数组 / 参数列表能跨行**。手写源常把 `SEARCH_BODY_PARAMS` 摊成多行，
 *    只数花括号会让续行里的标识符被当成新语句。故 `(` `[` 一并计入深度。
 *
 * ## 为什么换行仍然复位语句起点（外部评审 R1 建议删掉，驳回）
 *
 * 模板生成的代码**通篇无分号**（`const BASE_URL = "…"` 后面没有 `;`）。若换行不复位，
 * 第一条 `const` 之后 `atStmtStart` 永不复位 → 后面每一条顶层声明都被当成同一条语句的
 * 延续跳过 → **整个白名单检测彻底失效**（手改全部检不出），比误判严重一个量级。
 * 代价是链式调用跨行（`const a = foo\n  .bar()`）会被误判 needs-manual ——
 * 方向是保守的（多一行标灰，不会错迁），可接受。
 */
function findViolation(code: string, original: string, offset: number): PurityVerdict {
  /** `{` `(` `[` 统一计数；归零处才可能进入"语句边界"判定 */
  let depth = 0;
  /** 与 `{` 一一对应：true = 块（闭合后是新语句），false = 对象字面量（闭合后仍在原语句里） */
  const braceIsBlock: boolean[] = [];
  let atStmtStart = true;
  let prevSig = '';
  let prevWord = '';
  const n = code.length;
  let i = 0;

  while (i < n) {
    const ch = code[i]!;

    if (/\s/.test(ch)) {
      if (ch === '\n' && depth === 0) atStmtStart = true;
      i++;
      continue;
    }

    if (ch === '{' || ch === '(' || ch === '[') {
      if (ch === '{') braceIsBlock.push(looksLikeObjectLiteral(prevSig, prevWord));
      depth++;
      prevSig = ch;
      prevWord = '';
      i++;
      continue;
    }

    if (ch === '}' || ch === ')' || ch === ']') {
      if (depth === 0) return { pure: false, reason: `顶层出现多余的 ${ch}` };
      const wasBlock = ch === '}' ? braceIsBlock.pop() !== false : true;
      depth--;
      prevSig = ch;
      prevWord = '';
      atStmtStart = depth === 0 && (ch !== '}' || wasBlock);
      i++;
      continue;
    }

    if (ch === ';') {
      if (depth === 0) atStmtStart = true;
      prevSig = ch;
      prevWord = '';
      i++;
      continue;
    }

    if (depth > 0 || !atStmtStart) {
      if (isWordChar(ch)) prevWord += ch;
      else if (ch !== '"' && ch !== "'" && ch !== '`') {
        prevSig = ch;
        prevWord = '';
      }
      i++;
      continue;
    }

    // ── 顶层语句起点 ──
    const rest = code.slice(i);
    const fn = /^async\s+function\s+|^function\s+/.test(rest);
    if (fn) {
      const m = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/.exec(rest);
      const name = m?.[1] ?? '';
      if (!WHITELIST_FUNCTIONS.has(name)) {
        return { pure: false, reason: `模板外函数: ${name || '(匿名)'}` };
      }
      atStmtStart = false;
      i += m ? m[0].length : 0;
      prevWord = 'function';
      continue;
    }
    const decl = /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)/.exec(rest);
    if (decl) {
      // `let` / `var` 一律判手改：模板只用 `const`，出现它们说明有人在旁边加过东西
      if (!decl[0].startsWith('const') || !WHITELIST_CONSTS.has(decl[1]!)) {
        return { pure: false, reason: `模板外常量声明: ${decl[0]}` };
      }
      atStmtStart = false;
      i += decl[0].length;
      prevWord = 'const';
      continue;
    }
    return { pure: false, reason: `顶层出现非白名单语句: ${truncate(original.slice(offset + i))}` };
  }
  return depth === 0 ? { pure: true, reason: null } : { pure: false, reason: '括号不配对' };
}

/**
 * 这个 `{` 是对象字面量还是代码块？
 *
 * 判据是**前一个有效字符 / 词**：赋值与实参位置（`= ( , : [ ? …`）后面接 `{` 一定是
 * 对象字面量；`)` `}` `else` 后面接 `{` 是块。
 *
 * ⚠️ 集合里**刻意不含两个字符**（外部评审 R1 抓出）：
 * - `>`：箭头函数体（`=> {`）要按块处理，闭合后应视为新语句起点。写进集合会让
 *   `const f = () => {…}` 之后那条顶层语句**整个漏检** —— 那是"藏一段手改在箭头函数
 *   后面就能骗过检测"的口子。
 * - `;`：`; {` 在 JS 里是**块语句**不是对象字面量。误判成对象字面量会让闭合后
 *   `atStmtStart` 不复位，同样造成后面语句漏检。
 */
function looksLikeObjectLiteral(prevSig: string, prevWord: string): boolean {
  if (prevWord === 'return') return true;
  return '=(,:[?&|!+-*/%~^'.includes(prevSig);
}

// ── legado 骨架源识别 ─────────────────────────────────────────────────

/** 旧骨架 JS 的落款：四个 stub 抛出的错误文案（`legado-translator.makeSkeleton` 逐字一致） */
const SKELETON_MARKER = '此源由 legado 导入';
const SKELETON_STUB_RE =
  /async\s+function\s+(search|bookInfo|chapterList|chapterContent)\s*\([^)]*\)\s*\{\s*throw\s+new\s+Error\(/g;

export interface SkeletonInfo {
  /** 内嵌的原始 Legado JSON（注释块还原） */
  raw: string;
  /** 能解析成对象时给出，解析不了返回 null（调用方据此决定是否 needs-manual） */
  source: LegadoSource | null;
}

/**
 * 识别旧版 legado 骨架源并抽出内嵌的原始 JSON
 *
 * 骨架源**不是** needs-manual：它有确定的产出（`enabled:false` + `legadoRaw`），
 * 方案 §4.2 单独列了这条。识别靠两个独立信号同时成立：
 * ① 注释块里有落款文案；② 四个 stub 都在 `throw new Error(`（`search` 等名字单独存在不算数，
 * 纯模板源也有这四个函数）。
 */
export function detectSkeletonSource(content: string): SkeletonInfo | null {
  if (!content.includes(SKELETON_MARKER)) return null;
  const stubs = [...content.matchAll(SKELETON_STUB_RE)].map((m) => m[1]);
  if (new Set(stubs).size !== 4) return null;
  const raw = extractEmbeddedJson(content);
  if (!raw) return null;
  let source: LegadoSource | null = null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      source = parsed as LegadoSource;
    }
  } catch {
    source = null;
  }
  return { raw, source };
}

/** 从骨架 JS 的注释块里还原原始 JSON 文本 */
function extractEmbeddedJson(content: string): string {
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((l) => l.includes('原始 Legado JSON'));
  if (start === -1) return '';
  const end = lines.findIndex((l, i) => i > start && l.includes('留空待用户手写'));
  const stop = end === -1 ? lines.length : end;
  const body = lines
    .slice(start + 1, stop)
    .map((l) => l.replace(/^\s*\/\/\s?/, ''))
    .join('\n')
    .trim();
  return body;
}

// ── 迁移判定 ───────────────────────────────────────────────────────────

export interface MigrateInput {
  /** `.js` 文件名（**含**扩展名，marker 与归档路径都按它拼） */
  fileName: string;
  /** 文件全文 */
  content: string;
  /** 主进程 `parseHeaderMeta` 产物（已应用 marker 覆盖） */
  meta: LegacyJsMeta;
  /** 已存在 JSON 文档的 uuid 集合 —— 命中即整文件跳过 */
  existingUuids: ReadonlySet<string>;
}

/**
 * 单个 `.js` 文件的迁移判定
 *
 * 顺序刻意如此：幂等 → 骨架 → 纯净度 → 规则完整性 → schema。任何一步不过就落到
 * needs-manual 或 skip，**不产半成品文档**。
 */
export function migrateJsSource(input: MigrateInput): MigrateResult {
  const { fileName, content, meta, existingUuids } = input;

  // ① 幂等：同 uuid 的 JSON 已存在 → 整个文件跳过（用户手改过的 JSON 绝不被覆盖）
  if (existingUuids.has(meta.uuid)) {
    return {
      outcome: 'skip',
      item: { fileName, reason: `已存在同 uuid 的 JSON 文档（${meta.uuid}），保留用户版本` },
    };
  }

  // ② legado 骨架源 → enabled:false + legadoRaw 的文档（不是 needs-manual）
  const skeleton = detectSkeletonSource(content);
  if (skeleton) {
    if (!skeleton.source) {
      return {
        outcome: 'needs-manual',
        item: { fileName, reason: 'legado 骨架源内嵌的原始 JSON 无法解析' },
      };
    }
    const doc = buildSkeletonDoc(skeleton.source, meta, skeleton.raw);
    const checked = checkDoc(doc);
    if (!checked.ok) {
      return { outcome: 'needs-manual', item: { fileName, reason: checked.reason } };
    }
    return {
      outcome: 'convert',
      doc: checked.doc,
      isSkeleton: true,
      item: {
        fileName,
        jsonFileName: jsonNameOf(fileName),
        reason: 'legado 骨架源 → 禁用文档（启用前需手写规则）',
      },
    };
  }

  // ③ 手改检测
  const purity = checkPureTemplate(content);
  if (!purity.pure) {
    return { outcome: 'needs-manual', item: { fileName, reason: purity.reason ?? '含模板外语句' } };
  }

  // ④ 解析规则
  const parsed = parseJsSource(content);
  // homepage 以 `BASE_URL` 为先：旧引擎解析相对 URL 用的就是它，`@url` 头只是展示用。
  // 用户改了 BASE_URL 却没改 @url 时，取 BASE_URL 才是忠实还原。
  const homepage = parsed.baseUrl || meta.url || meta.urls[0] || '';
  if (!homepage) {
    return {
      outcome: 'needs-manual',
      item: { fileName, reason: '缺少 BASE_URL 与 @url，无法确定主站地址' },
    };
  }
  const missing = missingRequiredRules(parsed.rules);
  if (missing.length) {
    return {
      outcome: 'needs-manual',
      item: { fileName, reason: `必填规则为空: ${missing.join(', ')}` },
    };
  }

  const doc = buildSourceDoc({
    uuid: meta.uuid,
    name: meta.name,
    homepage,
    urls: meta.urls.length ? meta.urls : [homepage],
    rules: parsed.rules,
    headers: parsed.headers,
    enabled: meta.enabled,
    sourceType: meta.sourceType,
    author: meta.author ?? undefined,
    description: meta.description ?? undefined,
    tags: meta.tags,
    sourceVersion: meta.version,
    updateUrl: meta.updateUrl ?? undefined,
    minDelayMs: meta.minDelayMs,
    requireUrls: meta.requireUrls,
  });
  const checked = checkDoc(doc);
  if (!checked.ok) {
    return { outcome: 'needs-manual', item: { fileName, reason: checked.reason } };
  }
  return {
    outcome: 'convert',
    doc: checked.doc,
    isSkeleton: false,
    item: {
      fileName,
      jsonFileName: jsonNameOf(fileName),
      reason: '纯模板源，直接转换',
    },
  };
}

/** 骨架源文档：规则取翻译器产物，meta 以**磁盘上的头**为准 */
function buildSkeletonDoc(
  source: LegadoSource,
  meta: LegacyJsMeta,
  raw: string,
): BookSourceDocDraft {
  // 复用 P2.3 的导入路径产出 rules / headers / legadoRaw —— 两处各写一份必然漂移
  const translated = translateLegadoToDoc(source);
  const tags = meta.tags.includes('needs-manual') ? meta.tags : ['needs-manual', ...meta.tags];
  return buildSourceDoc({
    // uuid 走头的 `@uuid`（回退文件名）：命名空间连续性优先于翻译器的派生值
    uuid: meta.uuid,
    name: meta.name,
    homepage: meta.url || meta.urls[0] || '',
    urls: meta.urls.length ? meta.urls : undefined,
    rules: translated.doc.rules,
    headers: translated.doc.headers,
    // 骨架一律禁用，与 `makeSkeleton` 同语义：填完规则由用户显式启用
    enabled: false,
    sourceType: meta.sourceType,
    author: meta.author ?? undefined,
    description: meta.description ?? translated.doc.description,
    tags,
    sourceVersion: meta.version,
    updateUrl: meta.updateUrl ?? undefined,
    minDelayMs: meta.minDelayMs,
    requireUrls: meta.requireUrls,
    legadoRaw: raw,
  });
}

/** schema 终检：文档不合规就 needs-manual，绝不把坏文档交给落盘层 */
function checkDoc(
  doc: BookSourceDocDraft,
): { ok: true; doc: BookSourceDocDraft } | { ok: false; reason: string } {
  const parsed = v.safeParse(BookSourceDocSchema, doc);
  if (parsed.success) return { ok: true, doc };
  const first = parsed.issues[0];
  return { ok: false, reason: `文档不合 schema: ${first ? first.message : '未知'}` };
}

/** 七条必填规则（与主进程 `jsonEnvelopeError` 的 `REQUIRED_RULE_KEYS` 同口径） */
function missingRequiredRules(rules: object): string[] {
  const keys = [
    'siteName',
    'searchPath',
    'searchItemPattern',
    'bookTitlePattern',
    'bookAuthorPattern',
    'chapterItemPattern',
    'contentPattern',
  ];
  // 接口（`SourceRules`）没有索引签名，转成 `Record` 才能按键取值 —— 与
  // `source-doc-build.omitUndefined` 同一个理由
  const rec = rules as Record<string, unknown>;
  return keys.filter((k) => {
    const value = rec[k];
    return typeof value !== 'string' || value.trim() === '';
  });
}

function jsonNameOf(jsFileName: string): string {
  return jsFileName.replace(/\.js$/i, '.json');
}
