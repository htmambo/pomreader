/**
 * 旧 JS 书源 → 规则解析（书源 JSON 规则化改造 P1）
 *
 * 从存量 `.js` 书源源码里抽出 19 个模板常量，还原成 `SourceRules` + `headers` + `homepage`。
 * 编辑器反解析（`book-source-editor.component.ts`）与启动迁移（`rule-migrate.ts`）共用本文件，
 * 保证「编辑器看到的」与「迁移产出的」是同一套解析。
 *
 * ## 缺省值必须逐条对齐生成模板
 *
 * `smart-rules.ts:483-490` 生成代码时对每个可选常量都做了缺省回填。迁移必须**逐条复刻**，
 * 否则存量源迁移后行为漂移：
 *
 * | 常量 | 模板缺省 | 证据 |
 * |---|---|---|
 * | `SEARCH_METHOD` | `'GET'` | `:481` |
 * | `SEARCH_CONTENT_TYPE` | `POST_RAW ? 'application/json' : 'application/x-www-form-urlencoded'` | `:483-485` |
 * | `SEARCH_RAW_BODY` | `''` | `:486` |
 * | `SEARCH_BODY_PARAMS` / `CONTENT_REPLACE_RULES` | `[]` | `:482` / `:492` |
 * | `SEARCH_AUTHOR_RULE` / `SEARCH_CATEGORY_RULE` | `''`（生成器不做启发式猜测，`:444-445`） | |
 * | `BOOK_CATEGORY_RULE` | `DEFAULT_PATTERNS.bookCategoryPattern` | `:497` |
 * | `COVER_RULE` | `DEFAULT_PATTERNS.coverUrlPattern` | `:499` |
 *
 * ⚠️ 两条**不能照抄编辑器反解析**的既有缺陷：
 * ① `searchContentType` 回退恒为 `form-urlencoded`，会让手写 `POST_RAW` 源漂移（编辑器 `parseRulesFromSource` 现存缺陷）；
 * ② `BOOK_CATEGORY_RULE` / `COVER_RULE` 编辑器直接留空，而模板会回填 `DEFAULT_PATTERNS.*` —— 留空等于"不提取"，与模板不同。
 *
 * 缺省回填由 `resolveRuleDefaults` 完成，它**住在 `smart-rules.ts`**（与它镜像的生成侧缺省链同文件），
 * 本文件只负责"从源码里读出写了什么"，并在解析末尾过一次缺省回填。
 */
import {
  type ContentReplaceRule,
  type SearchBodyParam,
  type SourceRules,
  normalizeMethod,
  resolveRuleDefaults,
} from '../book-source/smart-add/smart-rules';

/** 数一行里未被转义的反引号（用于判断是否处于模板字符串内） */
function countBackticks(line: string): number {
  let n = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== '`') continue;
    // 数**连续反斜杠个数**而非只看前一个字符：`\\` + 反引号时该反引号并未被转义，
    // 误判会让 ticks 奇偶错位、把后续常量连同整个文件一起吞进当前常量值
    let bs = 0;
    for (let j = i - 1; j >= 0 && line[j] === '\\'; j--) bs++;
    if (bs % 2 === 0) n++;
  }
  return n;
}

/**
 * 提取 `const NAME = <值>`，支持跨行数组 / 对象 / 模板字符串
 *
 * 续行终止条件是「不在模板字符串内 **且** 下一行是新的顶层声明」。
 * 编辑器的 `/(?:const|let|var)\s+NAME\s*=\s*(.+?)\s*$/m` 只吃到行尾，
 * 手写源里把数组摊成多行时会把后半截当成代码（迁移必修项）。
 */
export function extractJsConsts(content: string): Record<string, string> {
  const lines = content.split('\n');
  const out: Record<string, string> = {};
  for (let i = 0; i < lines.length; i++) {
    const m = /^const\s+([A-Za-z_$][\w$]*)\s*=/.exec(lines[i]);
    if (!m) continue;
    const first = lines[i].slice(m[0].length);
    const parts = [first];
    let ticks = countBackticks(first);
    while (i + 1 < lines.length) {
      const next = lines[i + 1];
      if (ticks % 2 === 0) {
        // 新的顶层声明
        if (/^(const|let|var|function|async function|class)\s/.test(next)) break;
        // 列 0 的注释行同样终止：模板里每个常量后面常跟 `// ── 小节标题 ──`，
        // 漏掉这条会让常量值吞掉下一行注释 → JSON 解析失败 / 字面量多出尾巴。
        // （往返测试实测：HEADERS 吞注释 → 解析回退 {}，legacy 请求头整个丢失）
        if (/^(\/\/|\/\*|\*)/.test(next)) break;
      }
      parts.push(next);
      ticks += countBackticks(next);
      i++;
    }
    out[m[1]] = parts.join('\n').trim().replace(/;$/, '').trim();
  }
  return out;
}

/**
 * 单个常量取字符串字面量的值；非字面量（对象/数组/表达式）返回原样
 *
 * ⚠️ 三种引号都要处理。`JSON.parse` **只认双引号**（JSON 规范），所以单引号字面量
 * 会在 parse 阶段抛错；若 catch 里只解包反引号（早期版本），`SEARCH_PATH = '/s.php'`
 * 会带着引号原样返回成 `"'/s.php'"` —— 手写源（正是 P0 要处理的场景）会静默得到坏搜索路径。
 * 早期版本靠 `parseJsSource` 里对 `SEARCH_METHOD` 单独加一条剥引号的 `.replace` 兜住，
 * 等于只给一个字段打了补丁 —— 这里改成三种引号统一处理，补丁随之删除。
 */
function literalOf(raw: string): string {
  if (!raw) return '';
  const s = raw.trim();
  const q = s[0];
  if ((q === '"' || q === "'" || q === '`') && s.length >= 2 && s[s.length - 1] === q) {
    if (q === '`') return s.slice(1, -1); // 模板字符串：取内，不额外解转义
    try {
      return JSON.parse(s) as string; // 双引号：合法 JSON
    } catch {
      if (q === "'") {
        // 单引号：JSON.parse 必然失败，手工解 \\ 与 \' 两种转义（一次遍历，避免二次替换互相干扰）
        return s.slice(1, -1).replace(/\\(['\\])/g, '$1');
      }
    }
  }
  return s;
}

/**
 * 解析对象数组常量；**兼容历史元组形态** `[["k","v"],...]` → `[{key,value},...]`
 *
 * ⚠️ 形状校验里的属性访问一律用**方括号**（`o['key']`）：本仓 tsconfig 开了
 * `noPropertyAccessFromIndexSignature`，`consts` / `Record<string,unknown>` 上的点访问是编译错误。
 */
function extractBodyParams(raw: string): SearchBodyParam[] {
  return parseObjectArray<SearchBodyParam>(
    raw,
    (o) => typeof o['key'] === 'string' && typeof o['value'] === 'string',
    (pair) => ({ key: pair[0], value: pair[1] }),
  );
}

/** 解析正文净化规则；兼容历史元组形态 `[["正则","替换"],...]` → `[{rule,replace},...]` */
function extractReplaceRules(raw: string): ContentReplaceRule[] {
  return parseObjectArray<ContentReplaceRule>(
    raw,
    (o) => typeof o['rule'] === 'string' && typeof o['replace'] === 'string',
    (pair) => ({ rule: pair[0], replace: pair[1] }),
  );
}

/**
 * 对象数组解析 + 元组形态升级
 *
 * `isValid` 逐项校验对象形状：早期版本对任意对象直接 `item as T`，`{"k":1}` 会被当成
 * `SearchBodyParam` 放行（`key`/`value` 全 undefined）—— 返回类型与实际内容不符，
 * 任何在校验之前使用它的代码都会拿到坏规则。元组分支需长度 ≥2。
 *
 * 单个常量写坏不应让整个规则面板空白（沿用编辑器既有约定：解析失败一律回退空数组）。
 */
function parseObjectArray<T>(
  raw: string,
  isValid: (o: Record<string, unknown>) => boolean,
  fromPair: (pair: string[]) => T,
): T[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: T[] = [];
  for (const item of parsed) {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const o = item as Record<string, unknown>;
      if (isValid(o)) out.push(o as T);
    } else if (Array.isArray(item) && item.length >= 2) {
      out.push(fromPair(item.map((x) => String(x ?? ''))));
    }
  }
  return out;
}

/** 解析 `HEADERS` 常量（对象字面量）。legacy 导入源才可能有；解析失败回退 `{}` */
export function extractHeaders(raw: string): Record<string, string> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

/** 源码解析结果 */
export interface ParsedJsSource {
  rules: SourceRules;
  /** 原 `HEADERS` 常量（legado 导入产物才有；编辑器的反解析此前不含此项） */
  headers: Record<string, string>;
  /** 原 `BASE_URL` 常量 */
  baseUrl: string;
  /** `// @name` 头（缺省空串，运行时回退文件名） */
  siteName: string;
  /** 模板常量里没声明的名字 —— 供迁移判「老模板产物天然缺常量」 */
  missingConsts: string[];
}

/** 模板全部 19 个常量名 */
export const TEMPLATE_CONST_NAMES = [
  'BASE_URL',
  'HEADERS',
  'REGEX_HINT_CHARS',
  'MAX_EXTRACT_LINKS',
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
 * 读常量：缺席返回 `undefined`，**与「声明了但为空串」区分开**
 *
 * `??` 与 `||` 对 `''` 的反应不同，而模板 `smart-rules.ts:481-499` 全程用 `??` ——
 * 用 `||` 会把「显式留空 = 不提取」覆盖成默认选择器，把「没填」与「留空」两种语义搅在一起。
 */
function constOrUndefined(consts: Record<string, string>, name: string): string | undefined {
  return name in consts ? literalOf(consts[name]) : undefined;
}

/**
 * 旧 JS 源码 → 规则。缺省逐条对齐 `smart-rules.ts` 生成模板（见文件头表格）。
 * @param content `.js` 书源全文
 */
export function parseJsSource(content: string): ParsedJsSource {
  const consts = extractJsConsts(content);
  const siteName = /^\s*\/\/\s*@name\s+(.+?)\s*$/m.exec(content)?.[1] ?? '';

  return {
    // 条件缺省统一由 resolveRuleDefaults 按模板 `??` 链补齐；此处只负责「读出源码里写了什么」，
    // 且用 constOrUndefined 保住「缺席」与「声明为空串」的区别
    rules: resolveRuleDefaults({
      siteName,
      searchPath: constOrUndefined(consts, 'SEARCH_PATH') ?? '',
      searchMethod: normalizeMethod(constOrUndefined(consts, 'SEARCH_METHOD')),
      searchBodyParams: extractBodyParams(consts['SEARCH_BODY_PARAMS'] ?? ''),
      searchContentType: constOrUndefined(consts, 'SEARCH_CONTENT_TYPE'),
      searchRawBody: constOrUndefined(consts, 'SEARCH_RAW_BODY'),
      searchItemPattern: constOrUndefined(consts, 'SEARCH_ITEM_RULE') ?? '',
      searchAuthorPattern: constOrUndefined(consts, 'SEARCH_AUTHOR_RULE'),
      searchCategoryPattern: constOrUndefined(consts, 'SEARCH_CATEGORY_RULE'),
      bookTitlePattern: constOrUndefined(consts, 'BOOK_TITLE_RULE') ?? '',
      bookAuthorPattern: constOrUndefined(consts, 'BOOK_AUTHOR_RULE') ?? '',
      chapterItemPattern: constOrUndefined(consts, 'CHAPTER_ITEM_RULE') ?? '',
      contentPattern: constOrUndefined(consts, 'CONTENT_RULE') ?? '',
      contentReplaceRules: extractReplaceRules(consts['CONTENT_REPLACE_RULES'] ?? ''),
      bookCategoryPattern: constOrUndefined(consts, 'BOOK_CATEGORY_RULE'),
      coverUrlPattern: constOrUndefined(consts, 'COVER_RULE'),
    }),
    headers: extractHeaders(consts['HEADERS'] ?? ''),
    baseUrl: literalOf(consts['BASE_URL'] ?? ''),
    siteName,
    missingConsts: TEMPLATE_CONST_NAMES.filter((n) => !(n in consts)),
  };
}
