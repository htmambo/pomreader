/**
 * JS 书源全文 → 结构化 SourceRules 的反向解析（方案 docs/Architecture/2026-09-29-BOOKSOURCE-JSON-RULES-PLAN.md §4.2）
 * 供 P3 迁移与 P3 编辑器改造共用；纯函数、无 Angular 依赖。
 * 逻辑抽自 book-source-editor.component.ts 的 parseRulesFromSource，与其有意差异三点：
 *  - searchContentType 缺省回填按 searchMethod 区分（POST_RAW → application/json）；
 *    editor 恒回退 x-www-form-urlencoded 是现状 bug 级差异，方案 §4.2 显式要求按 method 区分
 *  - 旧元组形态 SEARCH_BODY_PARAMS / CONTENT_REPLACE_RULES（[["k","v"],...]）升级为对象数组（F15，
 *    破坏性变更见 docs/Usage/BOOKSOURCE_GUIDE.md「格式变更」段）
 *  - 新增 HEADERS 常量提取（F7，editor 反解析不含 HEADERS）
 */
import type {
  ContentReplaceRule,
  SearchBodyParam,
  SearchMethod,
  SourceRules,
} from '../book-source/smart-add/smart-rules';

/** 7 个必填字段（F3：7 必填 + 9 可选）；任一解析为空 → 调用方判 needs-manual */
const REQUIRED_FIELDS = [
  'siteName',
  'searchPath',
  'searchItemPattern',
  'bookTitlePattern',
  'bookAuthorPattern',
  'chapterItemPattern',
  'contentPattern',
] as const;

/**
 * 抽 `const NAME = <值>` 的原始值文本（去尾分号）；未命中返回 ''
 * 生成器产出的常量恒为单行（JSON.stringify 不产裸换行），故按行匹配即可
 */
function extractRaw(source: string, name: string): string {
  const m = new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*(.+?)\\s*$`, 'm').exec(source);
  if (!m) return '';
  return m[1].trim().replace(/;$/, '').trim();
}

/**
 * 字符串常量值：历史模板生成器以 JSON.stringify 注入，故按 JSON.parse 语义解析；
 * 与 editor 对齐的兜底链：JSON.parse 失败且为反引号 → 取内层；再失败 → 返回原文（手改源的容错路径）
 */
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

/**
 * 对象数组常量（SEARCH_BODY_PARAMS / CONTENT_REPLACE_RULES）：
 *  - JSON.parse 失败 / 非数组 → null（由调用方区分「常量缺失」与「解析失败」）
 *  - 旧元组形态 [k, v] 命中时升级为对象（F15）
 */
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
 * 任一必填字段解析不出来（常量缺失 / 值为空）→ 返回 null，调用方据此判 needs-manual。
 * siteName 取自 `// @name` 头：缺失时为空串 → 同样走 null（editor 容忍空串交运行时回退文件名，
 * 迁移语义下方案 §4.2 要求「任一必填为空 → needs-manual」）
 */
export function extractRulesFromJs(source: string): SourceRules | null {
  // @name 头 → siteName（与 editor 同一正则）
  const siteName = /^\s*\/\/\s*@name\s+(.+?)\s*$/m.exec(source)?.[1] ?? '';

  const methodRaw = extractString(source, 'SEARCH_METHOD');
  const searchMethod: SearchMethod = (['GET', 'POST', 'POST_RAW'] as SearchMethod[]).includes(
    methodRaw as SearchMethod,
  )
    ? (methodRaw as SearchMethod)
    : 'GET';

  // 缺省回填按 method 区分（方案 §4.2）：POST_RAW 模板缺省是 application/json，
  // 恒回退 x-www-form-urlencoded 会让手写 POST_RAW 源行为漂移
  const searchContentType =
    extractString(source, 'SEARCH_CONTENT_TYPE') ||
    (searchMethod === 'POST_RAW' ? 'application/json' : 'application/x-www-form-urlencoded');

  const rules: SourceRules = {
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
    // 模板版本漂移的旧生成源可能没有这两个常量（F15）：缺省 '' = 不提取（模板 searchExtraRules 的向后兼容语义）
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

/** 抽 `const BASE_URL = "..."`；缺失返回 '' */
export function extractBaseUrl(source: string): string {
  return extractString(source, 'BASE_URL');
}

/**
 * 抽 `const HEADERS = {...}`（JSON 对象字面量，legado 导入源带自定义请求头，F7）。
 * 缺失 / JSON.parse 失败 / 非对象（数组、标量）→ {}：header 是增强项，写坏不应让整个解析失败
 */
export function extractHeaders(source: string): Record<string, string> {
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
