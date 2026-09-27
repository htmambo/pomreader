/**
 * 标准书源 / 增强书源 判定与 marker 校正。
 *
 * - 标准书源：代码 = generateSourceCode(模板, 规则) 的纯函数产物，用户只维护规则。
 *   判定方式：从源码解析规则 → 重新生成 → 字符串比对（双方剔除 marker 行、去尾部空白）。
 *   剔除 marker 再比对 → 无 marker 的存量生成源也判为标准，平滑迁移。
 * - 增强书源：任何解析失败 / 比对不等（保守兜底，永不误判为标准）。
 * - marker（GENERATED_MARKER 头注释行）只作列表徽章的廉价依据；
 *   保存时由 ensure/strip 校正，保证 marker 与真实状态一致。
 */
import {
  GENERATED_MARKER,
  generateSourceCode,
  type SearchMethod,
  type SourceRules,
} from './smart-rules';

export { GENERATED_MARKER };

export interface ParsedSource {
  rules: SourceRules;
  baseUrl: string;
  headers: Record<string, string>;
}

/** 提取 `const NAME = ...` 单行值；JSON 字符串字面量求值，backtick 取内容，其他原样返回 */
function extractConst(content: string, name: string): string {
  const m = new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*(.+?)\\s*$`, 'm').exec(content);
  if (!m) return '';
  let raw = m[1].trim().replace(/;$/, '').trim();
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'")) ||
    (raw.startsWith('`') && raw.endsWith('`'))
  ) {
    try {
      return JSON.parse(raw) as string;
    } catch {
      /* backtick 或单引号：取内 */
    }
    if (raw.startsWith('`')) return raw.slice(1, -1);
    if (raw.startsWith("'")) return raw.slice(1, -1);
  }
  return raw;
}

/** 求值 JS 数组字面量 → [{key,value}]。元素兼容二元组 ["k","v"]（标准形态）与对象 {key,value}（历史形态） */
function extractPairs(content: string, name: string): Array<{ key: string; value: string }> {
  const raw = extractConst(content, name);
  if (!raw || !raw.startsWith('[')) return [];
  try {
    const arr = new Function(`return (${raw});`)() as unknown;
    if (!Array.isArray(arr)) return [];
    const out: Array<{ key: string; value: string }> = [];
    for (const it of arr) {
      if (
        Array.isArray(it) &&
        it.length >= 2 &&
        typeof it[0] === 'string' &&
        typeof it[1] === 'string'
      ) {
        out.push({ key: it[0], value: it[1] });
      } else if (
        it &&
        typeof it === 'object' &&
        typeof (it as { key?: unknown }).key === 'string'
      ) {
        const o = it as { key: string; value?: unknown };
        out.push({
          key: o.key,
          value: typeof o.value === 'string' ? o.value : String(o.value ?? ''),
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** 提取 const HEADERS = {...}（generateSourceCode 以 JSON.stringify 写出，必为合法 JSON） */
function extractHeaders(content: string): Record<string, string> {
  const raw = extractConst(content, 'HEADERS');
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw) as unknown;
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj as Record<string, string>;
  } catch {
    /* 非 JSON（用户手改）→ 按无 header 处理，比对自然会判为增强 */
  }
  return {};
}

/**
 * 从源码解析 13 个规则常量 + BASE_URL + HEADERS（best-effort：缺字段给空值/缺省，不抛错）。
 * 供编辑器面板回填与 isStandardSource 重新生成比对共用。
 */
export function parseSourceRules(content: string): ParsedSource {
  const methodRaw = extractConst(content, 'SEARCH_METHOD').replace(/^["']|["']$/g, '');
  const method: SearchMethod = (['GET', 'POST', 'POST_RAW'] as SearchMethod[]).includes(
    methodRaw as SearchMethod,
  )
    ? (methodRaw as SearchMethod)
    : 'GET';
  const siteName = /^\s*\/\/\s*@name\s+(.+?)\s*$/m.exec(content)?.[1] ?? '';
  return {
    baseUrl: extractConst(content, 'BASE_URL'),
    headers: extractHeaders(content),
    rules: {
      siteName,
      searchPath: extractConst(content, 'SEARCH_PATH'),
      searchMethod: method,
      searchBodyParams: extractPairs(content, 'SEARCH_BODY_PARAMS'),
      searchContentType:
        extractConst(content, 'SEARCH_CONTENT_TYPE') || 'application/x-www-form-urlencoded',
      searchRawBody: extractConst(content, 'SEARCH_RAW_BODY'),
      searchItemPattern: extractConst(content, 'SEARCH_ITEM_RULE'),
      bookTitlePattern: extractConst(content, 'BOOK_TITLE_RULE'),
      coverUrlPattern: extractConst(content, 'COVER_RULE'),
      bookAuthorPattern: extractConst(content, 'BOOK_AUTHOR_RULE'),
      chapterItemPattern: extractConst(content, 'CHAPTER_ITEM_RULE'),
      contentPattern: extractConst(content, 'CONTENT_RULE'),
      contentReplaceRules: extractPairs(content, 'CONTENT_REPLACE_RULES').map((p) => ({
        rule: p.key,
        replace: p.value,
      })),
      bookCategoryPattern: extractConst(content, 'BOOK_CATEGORY_RULE'),
    },
  };
}

/** 比对归一化：剔除 marker 行（位置无关）+ 去尾部空白 */
function normalizeForCompare(content: string): string {
  return content
    .split('\n')
    .filter((l) => l.trim() !== GENERATED_MARKER)
    .join('\n')
    .replace(/\s+$/, '');
}

/**
 * 权威判定：源码是否仍为 generateSourceCode 的纯规则产物。
 * 解析/生成任何一步失败 → false（增强，保守兜底）。
 */
export function isStandardSource(content: string): boolean {
  if (!content.trim()) return false;
  const { rules, baseUrl, headers } = parseSourceRules(content);
  let regenerated: string;
  try {
    regenerated = generateSourceCode(baseUrl, rules, { headers });
  } catch {
    return false;
  }
  return normalizeForCompare(content) === normalizeForCompare(regenerated);
}

/** 剔除 marker 行（增强书源保存前调用；无 marker 时原样返回） */
export function stripGeneratedMarker(content: string): string {
  if (!content.includes(GENERATED_MARKER)) return content;
  return content
    .split('\n')
    .filter((l) => l.trim() !== GENERATED_MARKER)
    .join('\n');
}

/** 确保 marker 存在（标准书源保存前调用，顺带迁移无 marker 的存量生成源）：插入头部注释块末尾 */
export function ensureGeneratedMarker(content: string): string {
  const lines = content.split('\n');
  if (lines.some((l) => l.trim() === GENERATED_MARKER)) return content;
  let insertAt = 0;
  while (insertAt < lines.length && lines[insertAt].trimStart().startsWith('//')) insertAt++;
  lines.splice(insertAt, 0, GENERATED_MARKER);
  return lines.join('\n');
}
