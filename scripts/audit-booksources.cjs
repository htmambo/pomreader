/**
 * 书源存量盘点（P0 只读审计）
 *
 * 用途：为「书源 JSON 规则化」方案提供存量数据 ——
 *   1. 决定 D1（手改源的处置力度：停用归档 vs 加强 needs-manual UI）
 *   2. 为 P1 差分测试挑选 fixture 样本形态
 *
 * **只读**：不写、不删、不移动任何文件。
 *
 * 用法：
 *   node scripts/audit-booksources.cjs [dir] [--json]
 *   BOOKSOURCES_DIR=/path/to/booksources node scripts/audit-booksources.cjs
 *
 * 退出码：0 = 盘点完成（无论有无告警）；1 = 参数 / IO 错误
 *
 * 维护须知：本文件的 meta 解析必须与 `electron/ipc/booksource-meta.ts` 保持同构 ——
 *   uuid 回退 = `uuid || fileName`（:142，**不剥**扩展名）
 *   name 回退 = `name || fileName.replace(/\.js$/i,'')`（:150，**剥**扩展名）
 *   两者方向相反，改动时同步上游。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

/** 模板内的 19 个常量（15 规则常量 + BASE_URL/HEADERS/REGEX_HINT_CHARS/MAX_EXTRACT_LINKS） */
const TEMPLATE_CONSTS = [
  'BASE_URL', 'HEADERS', 'REGEX_HINT_CHARS', 'MAX_EXTRACT_LINKS',
  'SEARCH_PATH', 'SEARCH_METHOD', 'SEARCH_BODY_PARAMS', 'SEARCH_CONTENT_TYPE',
  'SEARCH_RAW_BODY', 'SEARCH_ITEM_RULE', 'SEARCH_AUTHOR_RULE', 'SEARCH_CATEGORY_RULE',
  'BOOK_TITLE_RULE', 'BOOK_AUTHOR_RULE', 'CHAPTER_ITEM_RULE', 'CONTENT_RULE',
  'CONTENT_REPLACE_RULES', 'BOOK_CATEGORY_RULE', 'COVER_RULE',
];

/** 迁移判据用：必填规则常量（空值即判 needs-manual） */
const REQUIRED_CONSTS = [
  'BASE_URL', 'SEARCH_PATH', 'SEARCH_ITEM_RULE',
  'BOOK_TITLE_RULE', 'BOOK_AUTHOR_RULE', 'CHAPTER_ITEM_RULE', 'CONTENT_RULE',
];

/** 白名单：模板写死的函数（取自 smart-rules.ts 生成代码段） */
const WHITELIST_FUNCTIONS = new Set([
  'isCssRule', 'ruleSelector', 'stripTags', 'absUrl', 'matchAll', 'extractLinks',
  'extractSearchItems', 'searchExtraRules', 'extractText', 'extractHtml', 'extractAttr',
  'buildFormBody', 'search', 'bookInfo', 'chapterList', 'chapterContent',
]);
const WHITELIST_CONSTS = new Set(TEMPLATE_CONSTS);

const RULE_LENGTH_LIMIT = 512; // 与方案 guard.ts 的规则串上限一致
const MARKER_SUFFIXES = ['.enabled', '.disabled'];

/** 骨架源可靠特征（legado-translator.ts makeSkeleton 抛错串） */
const SKELETON_RE = /此源由 legado 导入|由 legado 订阅源导入（未能自动转换）/;

/**
 * 灾难性回溯的**保守**粗筛：只认两种歧义形态，刻意不追求覆盖全部 ReDoS。
 *
 * 1) 重复交替：`(a|a)+`（两支内容相同才算歧义）
 * 2) 短原子被重复：`(a+)+` / `(\s*)*` / `([\d]+)+` —— 内层是「短 + 无锚点」的可重复原子
 *
 * ⚠️ 刻意排除「结构化内层」：`(?:<[^>]+>)*`、`(?:\s+|,)*` 这类内层自带终止符/锚点的组
 * **不是** ReDoS（每次重复吃掉一个确定长度的完整单元，分割唯一），用「内层含 `<` 或 `>`」排除。
 * 宁可漏报也不误杀 —— 误杀会把存量合法源错标成需人工处理。
 *
 * ⚠️ 本函数是 P0 粗筛，**不得原样搬进 guard.ts** 当拒绝条件（见方案 §3.2 guard 约束）。
 */
function findNestedQuantifiers(text) {
  const hits = [];
  const altRe = /\(([A-Za-z0-9\\]{1,8})\|([A-Za-z0-9\\]{1,8})\)\s*(?:[+*]|\{\d+,?\d*\})/g;
  const nestRe = /\(([A-Za-z0-9\\s\W]{0,4}[+*])\)\s*(?:[+*]|\{\d+,?\d*\})/g;
  let m;
  // 重复交替的歧义判据是「**存在重叠分割**」，不只是两支完全相同：
  // `(a|a)+` 与 `(a|ab)+` 在 "aaa…b" 上都有指数级回溯（`ab` 也能被拆成 `a`+`b`）。
  // 故判 `a === b || a.startsWith(b) || b.startsWith(a)`；`(x|y)+` 两支无前缀关系 → 放行。
  while ((m = altRe.exec(text)) !== null) {
    const [a, b] = [m[1], m[2]];
    if (a === b || a.startsWith(b) || b.startsWith(a)) hits.push(m[0]);
  }
  while ((m = nestRe.exec(text)) !== null) {
    if (m[1].includes('<') || m[1].includes('>')) continue;
    hits.push(m[0]);
  }
  return hits;
}

// ---------------------------------------------------------------- meta 解析

/** 解析 `// @key value` 头（对应 booksource-meta.ts parseHeaderMeta） */
function parseHeader(content) {
  const meta = { urls: [], requireUrls: [], headerEnabled: null };
  for (const line of content.split('\n')) {
    const m = /^\s*\/\/\s*@(\w+)\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, key, rawValue] = m;
    const value = rawValue.trim();
    switch (key) {
      case 'name': if (!meta.name) meta.name = value; break;
      case 'uuid': if (!meta.uuid) meta.uuid = value; break;
      case 'url': if (value) meta.urls.push(value); break;
      case 'enabled': if (meta.headerEnabled === null) {
        meta.headerEnabled = !(value === 'false' || value === '0' || value === 'no');
      } break;
      case 'version': if (!meta.version) meta.version = value; break;
      case 'type': if (!meta.sourceType) meta.sourceType = value; break;
      case 'minDelayMs':
      case 'minDelay': { const n = parseInt(value, 10); if (Number.isFinite(n) && n >= 0) meta.minDelayMs = n; break; }
      case 'require': if (value) meta.requireUrls.push(value); break;
    }
  }
  return meta;
}

// ---------------------------------------------------------------- 常量提取

/** 数一行里**未被转义**的反引号（用于判断是否处于模板字符串内） */
function countBackticks(line) {
  let n = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== '`') continue;
    // 必须数**连续反斜杠的个数**：只看前一个字符会把 `\\` + 反引号误判为已转义
    // （外部评审 R3-P2），导致 ticks 奇偶错位、后续常量吞掉整个文件
    let bs = 0;
    for (let j = i - 1; j >= 0 && line[j] === '\\'; j--) bs++;
    if (bs % 2 === 0) n++;
  }
  return n;
}

/**
 * 提取 `const NAME = <值>`，支持跨行数组 / 对象 / 模板字符串
 *
 * 续行终止条件是「**不在模板字符串内**且下一行是新的顶层声明」——
 * 否则模板字面量里以 `const ` 开头的内容行会被误判成新顶层声明，
 * 既截断当前常量值，又制造假的"模板外声明"（外部评审 P1）。
 */
function extractConsts(content) {
  const lines = content.split('\n');
  const out = {};
  for (let i = 0; i < lines.length; i++) {
    const m = /^const\s+([A-Za-z_$][\w$]*)\s*=/.exec(lines[i]);
    if (!m) continue;
    const first = lines[i].slice(m[0].length);
    const parts = [first];
    let ticks = countBackticks(first);
    while (i + 1 < lines.length) {
      const next = lines[i + 1];
      if (ticks % 2 === 0 && /^const\s|^function\s|^async function\s/.test(next)) break;
      parts.push(next);
      ticks += countBackticks(next);
      i++;
    }
    out[m[1]] = parts.join('\n').trim();
  }
  return out;
}

/** 剥掉头部连续 `//` 行，返回 { header, body } */
function splitHeader(content) {
  const lines = content.split('\n');
  let end = 0;
  while (end < lines.length && (/^\s*\/\//.test(lines[end]) || lines[end].trim() === '')) end++;
  return { header: lines.slice(0, end), body: lines.slice(end) };
}

// ---------------------------------------------------------------- 手改检测

/**
 * 结构白名单：正文里**顶层**的声明名必须全部命中白名单（方案 §4.2 D8）
 *
 * 只认列 0 的声明：模板的顶层 const / function 都在列 0，函数体内的局部变量是缩进的
 * （`const out` / `let m` 之类），它们属于模板实现的一部分，不该被判成手改。
 * 早期用 `^\s*` 会把每个函数体内部的局部变量全扫出来（实测单文件误报 28 处）。
 */
function findNonTemplateDeclarations(body) {
  const found = [];
  // 分组：1=(const|let|var) 2=其名 3=(async ) 4=function 名 5=class 名
  // ⚠️ `function\s*\*?\s*` 支持生成器 `function* gen()` / `async function* gen()`
  //    ——原为 `function\s+`（要求 function 后必须有空白），生成器函数会被两个检测器同时漏掉
  const re = /^(?:export\s+|default\s+)?(?:(const|let|var)\s+([A-Za-z_$][\w$]*)|(async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)|class\s+([A-Za-z_$][\w$]*))/gm;
  let m;
  while ((m = re.exec(body)) !== null) {
    // ⚠️ class 的名字在 **m[5]**，不是 m[6]：原写 `m[2] || m[4] || m[6]` 里的 m[6] 恒为
    //    undefined，列 0 的 class 声明被整条 `continue` 掉 → 漏报手改。该缺陷自第一版即存在。
    const name = m[2] || m[4] || m[5];
    if (!name) continue;
    // 判别式注意：`(async\s+)?` 对普通 function 匹配的是**空串**（falsy），
    // 不能用 `m[3]` 是否为真来区分 function / class —— 改用「哪一支的名字捕获组有值」
    const kind = m[1] || (m[4] !== undefined ? 'function' : 'class');
    const known = WHITELIST_CONSTS.has(name) || WHITELIST_FUNCTIONS.has(name);
    if (!known) found.push(`${kind} ${name}`);
    // 同行多声明符 `const BASE_URL = '…', MY_HACK = 1`：上面的正则只抓第一个名字，
    // 而 `BASE_URL` 命中白名单就放行 → `MY_HACK` 被漏掉。补扫逗号后的声明名（外部评审 R5-P2）
    if (m[1]) {
      const rest = body.slice(m.index + m[0].length, body.indexOf('\n', m.index) === -1 ? body.length : body.indexOf('\n', m.index));
      for (const extra of rest.matchAll(/,\s*([A-Za-z_$][\w$]*)\s*=/g)) {
        if (!WHITELIST_CONSTS.has(extra[1])) found.push(`${m[1]} ${extra[1]}`);
      }
    }
  }
  return found;
}

/** 结构白名单之外还要看「顶层非声明语句」（外部评审 P2：漏报 `X.prototype.y=` / IIFE / 裸赋值） */
function findTopLevelStatements(body) {
  const found = [];
  // 真正的块注释状态跟踪，替代原先 `^\*` 的猜测式跳过
  let inBlockComment = false;
  for (const line of body.split('\n')) {
    // 块注释内部整段跳过：既避免把注释正文误判成顶层语句（外部评审 R2-P2），
    // 也不再需要 `^\*` 启发式 —— 那会顺带漏掉列 0 的 `* 2;` 乘法续行（外部评审 R2-P2）
    if (inBlockComment) {
      if (line.includes('*/')) inBlockComment = false;
      continue;
    }
    if (line === '') continue;
    // 关键：判据是**列 0**，必须拿原行判，不能 trim 后判 —— 模板的函数体是缩进的，
    // 早前一版先 `line.trim() === ''` 判空、再用未 trim 的行匹配 `^const`，
    // 结果把每个函数体的每一行都当成顶层语句（单文件误报上百条）。
    if (/^\s/.test(line)) continue; // 缩进行 = 函数体内部
    if (line.startsWith('//')) continue; // 行注释
    if (line.startsWith('/*')) {
      const end = line.indexOf('*/');
      if (end === -1) {
        inBlockComment = true;
        continue;
      }
      const rest = line.slice(end + 2).trim();
      if (!rest) continue;
      // 行内块注释**后面还有代码**（`/* 说明 */ myHack();`）—— 不能整行跳过（外部评审 R4-P2）
      if (/^(export\s+|default\s+)?(const|let|var)\s+[A-Za-z_$]/.test(rest)) continue;
      if (/^(export\s+|default\s+)?(async\s+)?function\s*\*?\s*[A-Za-z_$]/.test(rest)) continue;
      if (/^(export\s+|default\s+)?class\s+[A-Za-z_$]/.test(rest)) continue;
      found.push(rest.slice(0, 60));
      continue;
    }
    // 模板是生成代码、不重排缩进，函数收尾的 `}` / `});` / `};` 也在列 0 —— 不能算手改。
    // 不用括号深度计数（模板里有 `\d{1,3}` 这类量词，朴素计数会漂）。
    // ⚠️ 字符类写法坑：`[}\])];,\s]` 里的 `\]` 转义掉了 `]`，随后的 `]` 会**提前闭合**类，
    //     导致 `;` `,` 落在类外、整个正则永不匹配（实测 test('}') === false）。
    //     正确写法把 `]` 放在末尾：[}\]);,\s]
    if (/^[}\]);,\s]*$/.test(line)) continue; // 纯闭合符行（`}` / `});` / `};` …）
    // 跳过「真正的声明」时才要求关键字后紧跟标识符 —— 否则 `const { a } = x` 这类解构
    // 会被 `^const` 误当成声明跳过，导致解构形式的手改漏报
    if (/^(export\s+|default\s+)?(const|let|var)\s+[A-Za-z_$]/.test(line)) continue;
    if (/^(export\s+|default\s+)?(async\s+)?function\s*\*?\s*[A-Za-z_$]/.test(line)) continue;
    if (/^(export\s+|default\s+)?class\s+[A-Za-z_$]/.test(line)) continue;
    found.push(line.slice(0, 60));
  }
  return found;
}

/** 检出特殊模式（ReDoS 粗筛 / legado 不可数据化语法 / 超长规则） */
function findSpecialPatterns(content, consts) {
  const hits = { nestedQuantifier: findNestedQuantifiers(content), mustache: 0, jsonpath: 0, overlongRules: [] };
  hits.mustache = (content.match(/\{\{/g) || []).length;
  hits.jsonpath = (content.match(/\$\.jsonpath/g) || []).length;
  for (const [name, value] of Object.entries(consts)) {
    if (!name.endsWith('_RULE') && !name.endsWith('_RULES')) continue;
    if (value.length > RULE_LENGTH_LIMIT) hits.overlongRules.push({ name, length: value.length });
  }
  return hits;
}

// ---------------------------------------------------------------- 单源分析

/**
 * 读入后归一化：BOM + CRLF
 *
 * ⚠️ CRLF 必须在这里处理，不能指望各正则自己扛：JS 正则的 `.` **不匹配 `\r`**（`\r` 是行终止符），
 *    而无 `m` 标志的 `$` 只匹配串尾 —— 于是 `/^\s*\/\/\s*@(\w+)\s*(.*)$/` 在 CRLF 文件上
 *    **整条头都匹配不到**，表现为「有 @url 的源被判成『无 @url』」。实测已复现。
 */
function normalizeSource(text) {
  return text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}

function analyzeSource(filePath, fileName) {
  let raw;
  try {
    raw = fs.readFileSync(filePath);
  } catch (e) {
    // 断链符号链接 / 无读权限 / 目录冒充 .js —— 不可让整个盘点崩掉（外部评审 P1）
    return { fileName, unreadable: true, error: e.code || String(e) };
  }
  const content = normalizeSource(raw.toString('utf-8'));
  const { body } = splitHeader(content);
  const meta = parseHeader(content);
  const consts = extractConsts(content);

  // 与 booksource-meta.ts 同构：uuid 不剥扩展名，name 剥
  const uuid = meta.uuid || fileName;
  const name = meta.name || fileName.replace(/\.js$/i, '');

  const isSkeleton = SKELETON_RE.test(content);
  const extraDecls = isSkeleton ? [] : findNonTemplateDeclarations(body.join('\n'));
  const topLevelStmts = isSkeleton ? [] : findTopLevelStatements(body.join('\n'));
  const missingConsts = TEMPLATE_CONSTS.filter((c) => !(c in consts));
  const emptyRequired = REQUIRED_CONSTS.filter((c) => !consts[c]);
  const special = findSpecialPatterns(content, consts);

  // 迁移判据（与方案 §4.2 流程同序）
  let disposition;
  if (isSkeleton) disposition = { kind: 'skeleton', reason: 'legado 骨架源（可转 enabled:false + legadoRaw）' };
  else if (extraDecls.length || topLevelStmts.length) {
    const why = [
      extraDecls.length ? `含模板外声明：${extraDecls.join(', ')}` : '',
      topLevelStmts.length ? `含顶层非声明语句：${topLevelStmts.join(' | ')}` : '',
    ].filter(Boolean).join('；');
    disposition = { kind: 'needs-manual', reason: why };
  } else if (emptyRequired.length) disposition = { kind: 'needs-manual', reason: `必填规则为空：${emptyRequired.join(', ')}` };
  else if (meta.urls.length === 0) disposition = { kind: 'needs-manual', reason: '无 @url' };
  else disposition = { kind: 'migratable', reason: '结构合规' };

  return {
    fileName, name, uuid,
    uuidFromHeader: Boolean(meta.uuid),
    version: meta.version || null,
    sourceType: meta.sourceType || null,
    headerEnabled: meta.headerEnabled,
    consts, missingConsts, emptyRequired, extraDecls, topLevelStmts, special,
    isSkeleton, disposition,
    lineCount: content.split('\n').length,
    byteSize: raw.length, // 磁盘真实字节数；不能用归一化后的 content（CRLF/BOM 会偏小）
  };
}

// ---------------------------------------------------------------- 报告

function audit(dir) {
  // withFileTypes：目录名以 .js 结尾时要排除（readFileSync 会 EISDIR 崩掉整个盘点）；
  // 符号链接保留（用户可能软链书源），断链交给 analyzeSource 的 try/catch 记为不可读
  const dirents = fs.readdirSync(dir, { withFileTypes: true });
  const isName = (f) => f.toLowerCase();
  const files = dirents.map((d) => d.name);
  const isMarker = (n) => MARKER_SUFFIXES.some((s) => isName(n).endsWith(s));
  const jsFiles = dirents.filter((d) => (d.isFile() || d.isSymbolicLink()) && isName(d.name).endsWith('.js')).map((d) => d.name);
  // 目录不该被当 marker（否则会误报成「孤儿 marker」）
  const markerFiles = dirents.filter((d) => !d.isDirectory() && isMarker(d.name)).map((d) => d.name);
  const otherFiles = files.filter((f) => !isName(f).endsWith('.js') && !isMarker(f));

  const analyzed = jsFiles.map((f) => analyzeSource(path.join(dir, f), f));
  const unreadable = analyzed.filter((s) => s.unreadable);
  const sources = analyzed.filter((s) => !s.unreadable);
  const byBase = new Map(sources.map((s) => [s.fileName, s]));

  // marker 状态 + 孤儿 marker。**双 marker 并存时 .disabled 胜**（同 booksource-meta.ts:184-185），
  // 且每个源只产生一条记录 —— 早期实现两条都 push，enabledCount 会把禁用的源算成启用（外部评审 P0）
  const enabled = [];
  const orphans = [];
  const disabledBases = new Set(markerFiles.filter((m) => /\.disabled$/i.test(m)).map((m) => m.replace(/\.disabled$/i, '')));
  const enabledBases = new Set(markerFiles.filter((m) => /\.enabled$/i.test(m)).map((m) => m.replace(/\.enabled$/i, '')));
  for (const base of new Set([...disabledBases, ...enabledBases])) {
    if (byBase.get(base)) {
      const off = disabledBases.has(base);
      enabled.push({ fileName: base, enabled: !off, via: off && enabledBases.has(base) ? 'marker(冲突→disabled 胜)' : 'marker' });
    }
  }
  for (const m of markerFiles) {
    const base = m.replace(/\.(enabled|disabled)$/i, '');
    if (!byBase.get(base)) orphans.push(m);
  }
  for (const s of sources) {
    if (enabled.some((e) => e.fileName === s.fileName)) continue;
    enabled.push({
      fileName: s.fileName,
      enabled: s.headerEnabled === null ? true : s.headerEnabled,
      via: s.headerEnabled === null ? 'default' : 'header',
    });
  }

  // 字段完整度：分母排除骨架源（它按设计就没有模板常量，算进去会把每一行都拉低）
  const templateSources = sources.filter((s) => !s.isSkeleton);
  const completeness = TEMPLATE_CONSTS.map((c) => ({
    name: c,
    present: templateSources.length - templateSources.filter((s) => s.missingConsts.includes(c)).length,
  }));

  // @version 漂移
  const versions = {};
  for (const s of sources) { const v = s.version || '(缺 @version)'; versions[v] = (versions[v] || 0) + 1; }

  const byDisposition = { migratable: 0, 'needs-manual': 0, skeleton: 0 };
  for (const s of sources) byDisposition[s.disposition.kind]++;

  return {
    dir, total: sources.length, sources, markerCount: markerFiles.length, orphans, otherFiles,
    unreadable: unreadable.map((u) => ({ fileName: u.fileName, error: u.error })),
    enabledCount: enabled.filter((e) => e.enabled).length, enabled, completeness, versions, byDisposition,
    templateSourceCount: templateSources.length,
    uuids: sources.map((s) => ({ fileName: s.fileName, uuid: s.uuid, fromHeader: s.uuidFromHeader })),
  };
}

function printReport(r) {
  const L = console.log;
  L(`\n📦 书源存量盘点`);
  L(`目录：${r.dir}`);
  L(`样本量：${r.total} 个 .js 源${r.total < 5 ? '  ⚠️ 样本量过小，比例类结论不可外推' : ''}\n`);

  L(`── 概览 ──`);
  L(`启用 ${r.enabledCount} / 共 ${r.total}；marker 文件 ${r.markerCount} 个；孤儿 marker ${r.orphans.length} 个`);
  if (r.orphans.length) L(`  ⚠️ 孤儿 marker（无对应 .js）：${r.orphans.join(', ')}`);
  if (r.otherFiles.length) L(`  其他文件（非 .js / marker）：${r.otherFiles.join(', ')}`);
  if (r.unreadable.length) {
    L(`  ⚠️ 不可读条目 ${r.unreadable.length} 个（已跳过，不计入任何统计）：`);
    for (const u of r.unreadable) L(`    ${u.fileName} — ${u.error}`);
  }

  L(`\n── 迁移预判 ──`);
  L(`可迁移 ${r.byDisposition.migratable} · 需人工 ${r.byDisposition['needs-manual']} · 骨架源 ${r.byDisposition.skeleton}`);
  for (const s of r.sources) {
    const mark = { migratable: '✅', 'needs-manual': '⚠️', skeleton: '🦴' }[s.disposition.kind];
    L(`  ${mark} ${s.fileName} — ${s.disposition.reason}`);
  }

  // 分母用 templateSourceCount：骨架源按设计就不是模板生成，计入只会稀释手改率（外部评审 P1）
  const handEdited = r.sources.filter(
    (s) => s.disposition.kind === 'needs-manual' && (s.extraDecls.length || s.topLevelStmts.length));
  L(`\n── 手改检测（手改率 = ${handEdited.length} / ${r.templateSourceCount} 个模板生成源，已排除骨架源）──`);
  if (r.templateSourceCount) {
    const pct = (handEdited.length / r.templateSourceCount) * 100;
    // 必须用数值比较：早前写成 `pct < '5.0'` 是**字符串**比较，
    // "100.0" < "5.0" 为真 → 100% 手改率反而打印「<5%，停用归档即可」（报告层误导）
    L(`${pct.toFixed(1)}%  ${pct < 5 ? '→ <5%，D1 取「停用归档即可」' : '→ ≥5%，D1 取「加强 needs-manual 行内 UI」'}`);
  }
  for (const s of handEdited) {
    L(`  ${s.fileName}: ${[...s.extraDecls, ...s.topLevelStmts].join(' | ')}`);
  }

  L(`\n── 字段完整度（分母 ${r.templateSourceCount} 个模板生成源，已排除骨架源）──`);
  for (const c of r.completeness) {
    const miss = r.templateSourceCount - c.present;
    L(`  ${miss === 0 ? '  ' : '⚠️'} ${c.name.padEnd(24)} ${c.present}/${r.templateSourceCount}${miss ? `（缺 ${miss}）` : ''}`);
  }

  L(`\n── 模板版本漂移 ──`);
  for (const [v, n] of Object.entries(r.versions)) L(`  @version ${v}：${n} 个`);

  L(`\n── 特殊模式命中 ──`);
  let clean = true;
  for (const s of r.sources) {
    const sp = s.special;
    if (sp.nestedQuantifier.length || sp.mustache || sp.jsonpath || sp.overlongRules.length) {
      clean = false;
      const parts = [];
      if (sp.nestedQuantifier.length) parts.push(`嵌套量词 ${sp.nestedQuantifier.join(', ')}`);
      if (sp.mustache) parts.push(`{{×${sp.mustache}`);
      if (sp.jsonpath) parts.push(`$.jsonpath×${sp.jsonpath}`);
      if (sp.overlongRules.length) parts.push(`超长规则 ${sp.overlongRules.map((o) => `${o.name}:${o.length}`).join(',')}`);
      L(`  ⚠️ ${s.fileName}: ${parts.join(' · ')}`);
    }
  }
  if (clean) L('  ✅ 无命中');

  L(`\n── uuid 清单（迁移必须原样沿用；回退值带 .js 扩展名）──`);
  for (const u of r.uuids) L(`  ${u.fileName.padEnd(28)} → ${u.uuid}  ${u.fromHeader ? '(来自 @uuid)' : '(⚠️ 回退值 = 文件名)'}`);

  const fallback = r.uuids.filter((u) => !u.fromHeader).length;
  if (fallback) L(`  ⚠️ ${fallback}/${r.total} 个源走 uuid 回退（文件名）—— 迁移后必须保持「带扩展名」，否则 Book.bookSourceUuid 匹配不上且不报错`);

  L(`\n── 未能覆盖 ──`);
  L(`  • Book.bookSourceUuid 跨库引用核对：书库为 pouchdb-browser + IndexedDB（db.service.ts:157），node 脚本不可达；`);
  L(`    上表 uuid 清单供 P3 在应用内对拍（D6 硬验收）。`);
  L(`  • 手改检测为启发式（白名单声明扫描），最终判定以迁移期 isPureTemplate 实跑为准。\n`);
}

// ---------------------------------------------------------------- 入口

function main() {
  const args = process.argv.slice(2);
  const wantJson = args.includes('--json');
  const dirArg = args.find((a) => !a.startsWith('--'));
  const dir = dirArg || process.env.BOOKSOURCES_DIR || path.join(os.homedir(), '.config', 'pomreader', 'booksources');

  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    console.error(`❌ 目录不存在：${dir}\n   用法：node scripts/audit-booksources.cjs [dir] [--json]`);
    process.exit(1);
  }

  const report = audit(dir);
  if (wantJson) console.log(JSON.stringify(report, null, 2));
  else printReport(report);
  process.exit(0);
}

main();
