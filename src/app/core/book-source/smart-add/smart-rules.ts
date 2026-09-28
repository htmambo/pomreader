/**
 * 智能添加的规则模型与纯函数（对应 legado SmartSourceDetector 的「提取的选择器」页，
 * 差异：沙箱无 DOM → 规则支持 CSS 选择器与正则双模式；置信度为真实命中测试而非 mock）
 */

/** 显式 CSS 前缀（含特殊字符 ? ^ 等的选择器用它强制 CSS 模式） */
export const CSS_PREFIX = 'css:';

/** 规则测试默认关键词池：随机取一本热门书名，避免固定词被站点缓存/限流 */
export const TEST_KEYWORDS = ['庆余年', '雪中悍刀行', '赘婿', '斗破苍穹', '盗墓笔记', '鬼吹灯'];

export function randomTestKeyword(): string {
  return TEST_KEYWORDS[Math.floor(Math.random() * TEST_KEYWORDS.length)];
}

/**
 * 正则特征字符（与 generateSourceCode 生成代码内的 isCssRule 保持同一套启发式）：
 * \ ( ) { } ? | ^ $ * + —— 命中即判正则，否则兜底 CSS（[^ 已被 ^ 覆盖，无需单列）
 */
const REGEX_HINT = /[\\(){}?|^$*+]/;

/** Feature Flag:localStorage['pom.cssRules']==='0' 时全量回退正则（运行时止血开关） */
export function cssRulesEnabled(): boolean {
  try {
    return localStorage.getItem('pom.cssRules') !== '0';
  } catch {
    return true;
  }
}

/** 规则模式判定:css: 前缀 → CSS;含正则特征 → 正则;兜底 → CSS */
export function isCssRule(pattern: string): boolean {
  if (pattern.trim().toLowerCase().startsWith(CSS_PREFIX)) return true;
  return !REGEX_HINT.test(pattern);
}

/** 剥离 css: 前缀，得到实际选择器/模式串 */
export function ruleSelector(pattern: string): string {
  const p = pattern.trim();
  return p.toLowerCase().startsWith(CSS_PREFIX) ? p.slice(CSS_PREFIX.length).trim() : p;
}

/** 搜索请求方式：GET 走 searchPath 模板；POST/POST_RAW 走 searchBodyParams / searchRawBody */
export type SearchMethod = 'GET' | 'POST' | 'POST_RAW';

/** 单条表单参数（POST form-urlencoded 模式） */
export interface SearchBodyParam {
  key: string;
  /** value 支持 {keyword} / {page} 占位符（运行时由生成的 search() 替换 + encodeURIComponent） */
  value: string;
}

/** 单条正文净化规则：rule 为正则（g 全局替换），replace 为替换内容（留空 = 删除匹配文本） */
export interface ContentReplaceRule {
  rule: string;
  replace: string;
}

/** 可视化规则：每个字段直接参数化生成的书源代码 */
export interface SourceRules {
  siteName: string;
  /** 搜索路径模板：
   *  - GET：含 {keyword}（可选 {page}）占位
   *  - POST / POST_RAW：作为 POST 请求的 URL（不含 query string）；支持 {keyword} / {page} 占位 */
  searchPath: string;
  /** 搜索请求方式：缺省 'GET'（向后兼容） */
  searchMethod?: SearchMethod;
  /** POST form-urlencoded 模式的参数列表（searchMethod='POST'） */
  searchBodyParams?: SearchBodyParam[];
  /** POST Content-Type 头：searchMethod='POST' 时缺省 'application/x-www-form-urlencoded'；
   *  searchMethod='POST_RAW' 时由用户自填（如 application/json / text/xml） */
  searchContentType?: string;
  /** POST 原始 body 文本（searchMethod='POST_RAW'）：支持 {keyword} / {page} 占位符（不做 encode，由用户自管） */
  searchRawBody?: string;
  /** 搜索结果列表项规则（CSS 选择器，或正则：捕获组 1=书籍 URL，2=书名） */
  searchItemPattern: string;
  /**
   * 【可选增强】搜索结果条目内的作者规则（CSS 选择器，或正则：捕获组 1=作者）。
   * 作用域是**条目内部**，不是整页：
   *  - 条目规则为 CSS：作用于条目元素的 innerHTML（条目规则要选到含作者/分类的整块容器，如 `dl.list dd`）
   *  - 条目规则为正则：作用于「本条匹配起点 → 下一条匹配起点」之间的 HTML 片段
   * 留空（缺省）= 不提取，search() 返回的 author 为空串；这不是必需规则，配错不影响搜索命中。
   */
  searchAuthorPattern?: string;
  /**
   * 【可选增强】搜索结果条目内的分类规则，作用域同 searchAuthorPattern。
   * 命中后写入 search() 返回项的 kind（对应项目 Book.kind「分类/题材」），用于封面生成器文案。
   * 留空（缺省）= 不提取。
   */
  searchCategoryPattern?: string;
  /** 详情页标题规则（CSS 选择器，或正则：捕获组 1=标题） */
  bookTitlePattern: string;
  /** 详情页作者规则（CSS 选择器，或正则：捕获组 1=作者） */
  bookAuthorPattern: string;
  /** 章节链接规则（CSS 选择器，或正则：捕获组 1=章节 URL，2=章节名） */
  chapterItemPattern: string;
  /** 正文容器规则（CSS 选择器，或正则：捕获组 1=正文 HTML） */
  contentPattern: string;
  /** 正文净化规则列表：正文提取后按顺序执行，rule 为正则（g 全局替换）→ replace（留空 = 删除） */
  contentReplaceRules?: ContentReplaceRule[];
  /** 书籍分类规则（CSS 选择器，或正则：捕获组 1=分类名 —— 单本书的题材分类,如"玄幻"/"都市"） */
  bookCategoryPattern?: string;
  /** 封面规则（CSS 选择器（命中 img 元素，提取 src）或正则：捕获组 1=封面 URL） */
  coverUrlPattern?: string;
}

/** 默认规则模板（探测失败时的兜底值） */
export const DEFAULT_PATTERNS = {
  searchItemPattern: '<a[^>]+href="([^"]+)"[^>]*>([^<]{2,40})<\\/a>',
  bookTitlePattern: '<h1[^>]*>([\\s\\S]*?)<\\/h1>',
  bookAuthorPattern: '作者[：:]\\s*(?:<[^>]+>)*([^<]{1,30})',
  chapterItemPattern: '<a[^>]+href="([^"]+)"[^>]*>([^<]*第[^<]{1,60}章[^<]*)<\\/a>',
  contentPattern: '<div[^>]+id="content"[^>]*>([\\s\\S]*?)<\\/div>',
  bookCategoryPattern: '分类[：:]\\s*(?:<[^>]+>)*([^<]{1,20})',
  // 封面：默认 CSS 模式兜底选首张 img 的 src（用户在智能添加/编辑器可改）
  coverUrlPattern: 'css:img',
} as const;

/** 去标签 + 常见实体反转义（与生成代码里的 stripTags 保持同语义） */
export function stripTags(html: string): string {
  return (
    String(html || '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<div[^>]*>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      // 先解码 &amp; 再处理具体实体：双重编码（如 &amp;nbsp;）还原为 &nbsp; 后统一转换
      .replace(/&amp;/g, '&')
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      // 水平空白压缩（不动换行）；3+ 连续换行封顶为段间空行 —— </p> 与 <br> 各产生的换行保留
      .replace(/[^\S\n]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/\n[^\S\n]+/g, '\n')
      .trim()
  );
}

export function absUrl(href: string, base: string): string {
  try {
    return new URL(href, base).href;
  } catch {
    return href || '';
  }
}

/** 编译正则，非法模式抛带模式摘要的错误（UI 行内展示） */
function compile(pattern: string, flags: string): RegExp {
  try {
    return new RegExp(pattern, flags);
  } catch (e) {
    throw new Error(`正则无效：${(e as Error).message}`);
  }
}

/** 单值提取（捕获组 group，默认 1）；未命中返回 ''；CSS 模式取首个命中元素 textContent */
export function pickText(pattern: string, html: string, group = 1): string {
  if (cssRulesEnabled() && isCssRule(pattern)) {
    const el = queryFirst(pattern, html);
    return (el?.textContent ?? '').trim();
  }
  const re = compile(pattern, 'i');
  const m = re.exec(html);
  return m ? (m[group] ?? '') : '';
}

/** 容器 HTML 提取（正文用）：CSS → 首个命中元素 innerHTML；正则 → 同 pickText 组 1 */
export function pickHtml(pattern: string, html: string): string {
  if (cssRulesEnabled() && isCssRule(pattern)) {
    return queryFirst(pattern, html)?.innerHTML ?? '';
  }
  return pickText(pattern, html);
}

/** 属性提取（封面 src / 任意 attr 用）：
 *  - CSS 模式：取首个命中元素的 `attr` 属性（用于 img@src、a@href 等）
 *  - 正则模式：捕获组 group（默认 1）即为属性值
 *  返回绝对化后的 URL；CSS attr 不存在 / 正则未命中 → '' */
export function pickAttr(pattern: string, html: string, attr: string, group = 1): string {
  if (cssRulesEnabled() && isCssRule(pattern)) {
    const el = queryFirst(pattern, html);
    if (!el) return '';
    return el.getAttribute(attr) ?? '';
  }
  const re = compile(pattern, 'i');
  const m = re.exec(html);
  return m ? (m[group] ?? '') : '';
}

/** CSS 单元素查询；选择器语法非法时抛「选择器无效」错误（UI 行内展示） */
function queryFirst(pattern: string, html: string): Element | null {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  try {
    return doc.querySelector(ruleSelector(pattern));
  } catch (e) {
    throw new Error(`选择器无效：${(e as Error).message}`);
  }
}

export interface MatchedItem {
  name: string;
  url: string;
}

/** 条目 + 作用域 HTML（提取作者/分类增强字段用；对外只暴露 name/url） */
interface MatchedItemWithContext extends MatchedItem {
  /** 条目作用域的 HTML：CSS → 元素 innerHTML；正则 → 本条匹配起点到下一条匹配起点的片段 */
  context: string;
}

/** 搜索结果条目的可选增强规则（留空 = 不提取） */
export interface SearchExtraRules {
  /** 作者规则：CSS 选择器或正则，作用于条目作用域内 */
  authorRule?: string;
  /** 分类规则：CSS 选择器或正则，作用于条目作用域内 */
  categoryRule?: string;
}

/** 搜索结果条目（含可选的作者/分类增强字段） */
export interface MatchedSearchItem extends MatchedItem {
  /** 作者：增强规则未配置/未命中则缺省 */
  author?: string;
  /** 分类/题材：增强规则未配置/未命中则缺省（写入 search() 返回项的 kind） */
  kind?: string;
}

/** 链接项提取；CSS 模式见 extractItemContextsCss，正则模式约定组 1=href，2=文本 */
export function matchLinkItems(
  pattern: string,
  html: string,
  baseUrl: string,
  limit = 500,
): MatchedItem[] {
  return extractItemContexts(pattern, html, baseUrl, limit).map(({ name, url }) => ({ name, url }));
}

/**
 * 搜索结果条目 + 可选的作者/分类增强字段（与生成的 search() 同语义，供规则面板「测试搜索」用）
 *
 * 增强字段是**可选补充**，不是必需项：
 *  - 两条增强规则都为空 → 不做任何额外提取，等价于 matchLinkItems
 *  - 规则未命中 → 该字段缺省（不写入空串），调用方按缺省处理
 */
export function matchSearchItems(
  pattern: string,
  html: string,
  baseUrl: string,
  extras: SearchExtraRules = {},
  limit = 500,
): MatchedSearchItem[] {
  const items = extractItemContexts(pattern, html, baseUrl, limit);
  const authorRule = (extras.authorRule ?? '').trim();
  const categoryRule = (extras.categoryRule ?? '').trim();
  if (!authorRule && !categoryRule) {
    return items.map(({ name, url }) => ({ name, url }));
  }
  return items.map(({ name, url, context }) => {
    const author = authorRule ? stripTags(pickText(authorRule, context)) : '';
    const kind = categoryRule ? stripTags(pickText(categoryRule, context)) : '';
    return { name, url, ...(author ? { author } : {}), ...(kind ? { kind } : {}) };
  });
}

/** 条目提取（带作用域 HTML）：按规则模式分派到 CSS / 正则实现 */
function extractItemContexts(
  pattern: string,
  html: string,
  baseUrl: string,
  limit: number,
): MatchedItemWithContext[] {
  if (cssRulesEnabled() && isCssRule(pattern)) {
    return extractItemContextsCss(ruleSelector(pattern), html, baseUrl, limit);
  }
  return extractItemContextsRegex(pattern, html, baseUrl, limit);
}

/**
 * CSS 模式链接提取：命中元素为 a 则取之，否则取其后代锚点；
 * 按绝对 URL 去重（同 URL 保留首个非空 name —— 同一书籍的 img 链接/书名链接/按钮链接收敛为一条）；
 * context 取条目元素 innerHTML，供作者/分类增强规则在条目作用域内提取
 */
function extractItemContextsCss(
  selector: string,
  html: string,
  baseUrl: string,
  limit: number,
): MatchedItemWithContext[] {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  let els: Element[];
  try {
    els = Array.from(doc.querySelectorAll(selector));
  } catch (e) {
    throw new Error(`选择器无效：${(e as Error).message}`);
  }
  const byUrl = new Map<string, MatchedItemWithContext>();
  for (const el of els) {
    const anchors = el.tagName === 'A' ? [el] : Array.from(el.querySelectorAll('a[href]'));
    for (const a of anchors) {
      const url = absUrl(a.getAttribute('href') ?? '', baseUrl);
      if (!url) continue;
      const name = (a.textContent ?? '').trim();
      const context = el.innerHTML;
      const prev = byUrl.get(url);
      if (!prev) {
        byUrl.set(url, { name, url, context });
      } else {
        if (!prev.name && name) prev.name = name;
        if (!prev.context && context) prev.context = context;
      }
    }
    if (byUrl.size >= limit) break;
  }
  return [...byUrl.values()];
}

/**
 * 正则模式链接提取：组 1=href，2=文本（不去重，保持兼容）；
 * context 取「本条匹配起点 → 下一条匹配起点」之间的片段 —— 正则条目规则通常只锚定书名链接，
 * 作者/分类等增强信息跟在其后同一条目块内
 */
function extractItemContextsRegex(
  pattern: string,
  html: string,
  baseUrl: string,
  limit: number,
): MatchedItemWithContext[] {
  const re = compile(pattern, 'gi');
  const matches: RegExpExecArray[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    matches.push(m);
    if (matches.length >= limit) break;
  }
  return matches.map((match, i) => ({
    name: stripTags(match[2] ?? ''),
    url: absUrl(match[1] ?? '', baseUrl),
    context: html.slice(match.index, matches[i + 1]?.index ?? html.length),
  }));
}

// ── 启发式探测 ─────────────────────────────────────────────────────────────

/** 从首页 HTML 提取 <title>（剥常见分隔符后缀） */
export function detectSiteName(html: string, host: string): string {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const raw = m ? m[1].trim() : '';
  const cleaned = raw.split(/[-_|—–]/)[0].trim();
  return cleaned || host.split('.')[0] || host;
}

/** 探测搜索路径：优先含 search 字样的 GET 表单 action + 文本框 name */
export function detectSearchPath(html: string): string {
  const formRe = /<form[^>]*>/gi;
  let form: RegExpExecArray | null;
  while ((form = formRe.exec(html)) !== null) {
    const tag = form[0];
    if (/method\s*=\s*["']?post/i.test(tag)) continue;
    const action = /action\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? '';
    const inputName =
      /<input[^>]+type=["']?(?:text|search)["']?[^>]*name=["']([^"']+)["']/i.exec(html)?.[1] ??
      /<input[^>]+name=["']([^"']+)["']/i.exec(html)?.[1] ??
      '';
    if (action && /search|so|s\.|find/i.test(action)) {
      const sep = action.includes('?') ? '&' : '?';
      return `${action}${inputName ? `${sep}${inputName}={keyword}` : ''}`;
    }
  }
  return '/search?keyword={keyword}';
}

/** 统计疑似章节链接数量（第…章 锚文本） */
export function countChapterLinks(html: string): number {
  const matches = html.match(/<a[^>]+>[^<]*第[^<]{1,40}章[^<]*<\/a>/gi);
  return matches ? matches.length : 0;
}

/** 探测正文容器：命中常见 id/class 时给出对应正则，否则给 id=content 默认 */
export function detectContentPattern(html: string): string {
  if (/id=["']content["']/i.test(html)) return DEFAULT_PATTERNS.contentPattern;
  if (/id=["']chaptercontent["']/i.test(html))
    return '<div[^>]+id="chaptercontent"[^>]*>([\\s\\S]*?)<\\/div>';
  if (/class=["'][^"']*content/i.test(html))
    return '<div[^>]+class="[^"]*content[^"]*"[^>]*>([\\s\\S]*?)<\\/div>';
  return DEFAULT_PATTERNS.contentPattern;
}

/**
 * POST form-urlencoded body 构造（智能添加页 testSearch 与生成的 search() 同源实现）
 * - value 支持 {keyword} / {page} 占位符 → 替换后 encodeURIComponent
 * - 空 key 跳过（避免生成 "&value" 这类无效段）
 */
export function buildFormBody(
  params: Array<{ key: string; value: string }>,
  keyword: string,
  page: number | string,
): string {
  const parts: string[] = [];
  for (const p of params) {
    if (!p.key) continue;
    const replaced = String(p.value ?? '')
      .replace('{keyword}', keyword)
      .replace('{page}', String(page));
    parts.push(`${encodeURIComponent(p.key)}=${encodeURIComponent(replaced)}`);
  }
  return parts.join('&');
}

/**
 * 正文净化（智能添加页「测试正文」预览 与 生成的 chapterContent() 同源实现）
 * - 按顺序对正文文本执行 rule 的 g 模式全局替换为 replace（留空 = 删除匹配文本）
 * - 空 rule 跳过；非法正则跳过（不中断后续规则）
 */
export function applyContentReplaceRules(
  text: string,
  rules: ContentReplaceRule[] | undefined,
): string {
  let out = text;
  for (const r of rules ?? []) {
    if (!r || typeof r !== 'object' || !r.rule) continue;
    try {
      out = out.replace(new RegExp(r.rule, 'g'), r.replace ?? '');
    } catch {
      // 非法正则跳过,不中断后续规则
    }
  }
  return out;
}

/** 抓取到的首页 HTML → 初始规则集 */
export function buildRules(url: string, html: string): SourceRules {
  const host = new URL(url).hostname.replace(/^www\./, '');
  return {
    siteName: detectSiteName(html, host),
    searchPath: detectSearchPath(html),
    searchMethod: 'GET',
    searchBodyParams: [],
    searchContentType: 'application/x-www-form-urlencoded',
    searchItemPattern: DEFAULT_PATTERNS.searchItemPattern,
    // 作者/分类增强规则不做启发式猜测（猜错会污染搜索结果）→ 默认空串 = 不提取，用户在规则面板按站点实际结构填
    searchAuthorPattern: '',
    searchCategoryPattern: '',
    bookTitlePattern: DEFAULT_PATTERNS.bookTitlePattern,
    bookAuthorPattern: DEFAULT_PATTERNS.bookAuthorPattern,
    chapterItemPattern: DEFAULT_PATTERNS.chapterItemPattern,
    contentPattern: detectContentPattern(html),
    contentReplaceRules: [],
    bookCategoryPattern: DEFAULT_PATTERNS.bookCategoryPattern,
    coverUrlPattern: DEFAULT_PATTERNS.coverUrlPattern,
  };
}

// ── 代码生成 ───────────────────────────────────────────────────────────────

/**
 * 由规则生成 pomreader 沙箱兼容的书源 JS
 * 规则串以 JSON 转义注入 —— 用户可改出含 / " \ 的任意模式都不会破坏代码结构;
 * 双模式(CSS/正则)判定在生成的代码运行时进行(与 isCssRule 同一套启发式)
 *
 * @param url 主站 origin（用于 absUrl 解析）
 * @param rules 可视化规则(列表/列表项内作者/列表项内分类/标题/作者/章节/正文/分类/封面 + 正文净化规则) + searchPath + 搜索方式(method/body)
 * @param options.headers 注入每个 HTTP 请求的自定义 header（legado JSON 导入用）
 */
export function generateSourceCode(
  url: string,
  rules: SourceRules,
  options?: { headers?: Record<string, string> },
): string {
  const u = new URL(url);
  const j = (s: unknown): string => JSON.stringify(s);
  const headers = options?.headers ?? {};
  const headersJson = j(headers);
  const description =
    headers && Object.keys(headers).length
      ? `由 legado JSON 订阅源导入（${u.host}），含自定义 HTTP header`
      : `由智能添加从 ${u.host} 生成(CSS 选择器/正则双模式,可在智能添加页继续调规则)`;
  // 搜索方式 + body 相关常量 —— 向后兼容:缺省 GET
  const searchMethod: SearchMethod = rules.searchMethod ?? 'GET';
  const searchBodyParams: SearchBodyParam[] = rules.searchBodyParams ?? [];
  const searchContentType =
    rules.searchContentType ??
    (searchMethod === 'POST_RAW' ? 'application/json' : 'application/x-www-form-urlencoded');
  const searchRawBody = rules.searchRawBody ?? '';
  // 封面规则：缺省走 DEFAULT_PATTERNS.coverUrlPattern('css:img')
  const coverRule = rules.coverUrlPattern ?? DEFAULT_PATTERNS.coverUrlPattern;
  // searchBodyParams → JSON 对象数组 [{"key":"q","value":"{keyword}"},...]
  // 盘上格式与 UI 层形态统一为对象（见 SearchBodyParam / ContentReplaceRule）
  const bodyParamsJson = j(searchBodyParams);
  // 正文净化规则 → JSON 对象数组 [{"rule":"正则","replace":"替换为"},...]
  const contentReplaceRulesJson = j(rules.contentReplaceRules ?? []);
  return `// @name        ${rules.siteName}
// @version     1.2.0
// @author      智能添加
// @url         ${u.origin}
// @enabled     true
// @tags        智能识别
// @description ${description}

const BASE_URL = ${j(u.origin)}
const HEADERS = ${headersJson}

// ── 规则(可视化编辑的值,直接改这里也生效;CSS 选择器或正则均可,含特殊符号的选择器加 css: 前缀) ──
const SEARCH_PATH = ${j(rules.searchPath)}
const SEARCH_METHOD = ${j(searchMethod)}
const SEARCH_BODY_PARAMS = ${bodyParamsJson}
const SEARCH_CONTENT_TYPE = ${j(searchContentType)}
const SEARCH_RAW_BODY = ${j(searchRawBody)}
const SEARCH_ITEM_RULE = ${j(rules.searchItemPattern)}
const SEARCH_AUTHOR_RULE = ${j(rules.searchAuthorPattern ?? '')}
const SEARCH_CATEGORY_RULE = ${j(rules.searchCategoryPattern ?? '')}
const BOOK_TITLE_RULE = ${j(rules.bookTitlePattern)}
const BOOK_AUTHOR_RULE = ${j(rules.bookAuthorPattern)}
const CHAPTER_ITEM_RULE = ${j(rules.chapterItemPattern)}
const CONTENT_RULE = ${j(rules.contentPattern)}
const CONTENT_REPLACE_RULES = ${contentReplaceRulesJson}
const BOOK_CATEGORY_RULE = ${j(rules.bookCategoryPattern ?? DEFAULT_PATTERNS.bookCategoryPattern)}
const COVER_RULE = ${j(coverRule)}

// ── 规则模式判定(css: 前缀 → CSS;含正则特征字符 → 正则;兜底 CSS) ──
const REGEX_HINT_CHARS = '\\\\(){}?|^$*+'
function isCssRule(p) {
  p = String(p).trim()
  if (p.toLowerCase().startsWith('css:')) return true
  for (const ch of REGEX_HINT_CHARS) if (p.indexOf(ch) !== -1) return false
  return true
}

/** 提取 CSS 选择器:去掉 css: 前缀(如有) */
function ruleSelector(p) {
  p = String(p).trim()
  return p.toLowerCase().startsWith('css:') ? p.slice(4).trim() : p
}

// ── 工具函数(沙箱内无 DOM:正则走 RegExp,CSS 走 legado.query 主线程代理) ──
// 提取上限(由 matchAll 与 extractLinks 共用,统一魔数;修改时同步两处)
const MAX_EXTRACT_LINKS = 500
function stripTags(html) {
  return String(html || '')
    .replace(/<script[\\s\\S]*?<\\/script>/gi, '')
    .replace(/<style[\\s\\S]*?<\\/style>/gi, '')
    .replace(/<br\\s*\\/?>/gi, '\\n')
    .replace(/<div[^>]*>/gi, '\\n')
    .replace(/<\\/p>/gi, '\\n')
    .replace(/<[^>]+>/g, '')
    // 先解码 &amp; 再处理具体实体:双重编码(如 &amp;nbsp;)还原为 &nbsp; 后统一转换
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    // 水平空白压缩(不动换行);3+ 连续换行封顶为段间空行 —— </p> 与 <br> 各产生的换行保留
    .replace(/[^\\S\\n]+/g, ' ')
    .replace(/\\n{3,}/g, '\\n\\n')
    .replace(/\\n[^\\S\\n]+/g, '\\n')
    .trim()
}

/** 绝对 URL 解析:href 相对于 base 的绝对 URL;解析失败返回空字符串 */
function absUrl(href, base) {
  try { return new URL(href, base).href } catch { return href || '' }
}

/** 匹配所有正则结果(受 MAX_EXTRACT_LINKS 限制) */
function matchAll(re, html) {
  re.lastIndex = 0
  const out = []
  let m
  while ((m = re.exec(html)) !== null) {
    out.push(m)
    if (out.length >= MAX_EXTRACT_LINKS) break
  }
  return out
}

/** 链接项提取:CSS 按 URL 去重(非空 name 优先,上限 MAX_EXTRACT_LINKS);正则约定组 1=href,2=文本(不去重,保持兼容——计划契约) */
async function extractLinks(rule, html, baseUrl) {
  if (isCssRule(rule)) {
    const items = await legado.query(html, ruleSelector(rule), baseUrl)
    const byUrl = new Map()
    for (const el of items) {
      // legado.query 契约保证 links 必为数组,此处防御实现漂移
      for (const l of (el.links || [])) {
        if (!l.href) continue
        const prev = byUrl.get(l.href)
        if (!prev || (!prev.name && l.text)) byUrl.set(l.href, { name: l.text, url: l.href })
      }
      if (byUrl.size >= MAX_EXTRACT_LINKS) break
    }
    return [...byUrl.values()]
  }
  return matchAll(new RegExp(rule, 'gi'), html)
    .map((m) => ({ name: stripTags(m[2]), url: absUrl(m[1], baseUrl) }))
}

/**
 * 搜索条目提取(带作用域 HTML):与 extractLinks 同源,额外返回 context 供作者/分类增强规则在**条目内部**提取
 *  - CSS:context = 条目元素 innerHTML(legado.query 的 el.links 已含 a 元素自身,与 extractLinks 同一套收敛逻辑)
 *  - 正则:context = 本条匹配起点 → 下一条匹配起点之间的 HTML 片段(条目正则通常只锚定书名链接,作者/分类跟在其后)
 */
async function extractSearchItems(rule, html, baseUrl) {
  if (isCssRule(rule)) {
    const items = await legado.query(html, ruleSelector(rule), baseUrl)
    const byUrl = new Map()
    for (const el of items) {
      for (const l of (el.links || [])) {
        if (!l || !l.href) continue
        const prev = byUrl.get(l.href)
        if (!prev) byUrl.set(l.href, { name: l.text, url: l.href, context: el.html || '' })
        else {
          if (!prev.name && l.text) prev.name = l.text
          if (!prev.context && el.html) prev.context = el.html
        }
      }
      if (byUrl.size >= MAX_EXTRACT_LINKS) break
    }
    return [...byUrl.values()]
  }
  const matches = matchAll(new RegExp(rule, 'gi'), html)
  return matches.map((m, i) => ({
    name: stripTags(m[2]),
    url: absUrl(m[1], baseUrl),
    context: html.slice(m.index, i + 1 < matches.length ? matches[i + 1].index : html.length),
  }))
}

/** 搜索结果增强规则(可选):作者 / 分类 —— 旧书源未声明这两个常量时按「未配置」处理(向后兼容) */
function searchExtraRules() {
  return {
    author: typeof SEARCH_AUTHOR_RULE === 'undefined' ? '' : String(SEARCH_AUTHOR_RULE || ''),
    kind: typeof SEARCH_CATEGORY_RULE === 'undefined' ? '' : String(SEARCH_CATEGORY_RULE || ''),
  }
}

/** 单文本提取:CSS 取首个命中 textContent;空结果返回 '' 不抛异常 */
async function extractText(rule, html, baseUrl) {
  if (isCssRule(rule)) {
    const r = await legado.query(html, ruleSelector(rule), baseUrl)
    const first = r && r[0]
    return ((first && first.text) || '').trim()
  }
  const m = new RegExp(rule, 'i').exec(html)
  return m ? stripTags(m[1] || '') : ''
}

/** 容器 HTML 提取:CSS 取首个命中 innerHTML;空结果返回 '' 不抛异常 */
async function extractHtml(rule, html, baseUrl) {
  if (isCssRule(rule)) {
    const r = await legado.query(html, ruleSelector(rule), baseUrl)
    const first = r && r[0]
    return (first && first.html) || ''
  }
  const m = new RegExp(rule, 'i').exec(html)
  return (m && m[1]) || ''
}

/** 属性提取(封面 src 用):CSS 取首个命中元素的 attr;正则捕获组 1 */
async function extractAttr(rule, html, baseUrl, attr) {
  if (isCssRule(rule)) {
    const r = await legado.query(html, ruleSelector(rule), baseUrl)
    const first = r && r[0]
    if (!first || !first.attrs) return ''
    return (first.attrs[attr] != null ? first.attrs[attr] : '') || ''
  }
  const m = new RegExp(rule, 'i').exec(html)
  return (m && m[1]) || ''
}

/** 把搜索参数键值对序列化为 form-urlencoded 字符串。
 *  - 形态:对象数组 [{"key":"q","value":"{keyword}"},...]（与 UI 层 rules-panel 内存态一致）
 *  - value 支持 {keyword} / {page} 占位符:运行时由 search() 替换后 encodeURIComponent
 *  - 空 key 跳过(避免生成 "&value" 这类无效段)
 *  - null/undefined → 空串 */
function buildFormBody(params, keyword, page) {
  const parts = [];
  for (const p of params ?? []) {
    if (!p || typeof p !== 'object' || !p.key) continue;
    const replaced = String(p.value ?? '')
      .replace('{keyword}', keyword)
      .replace('{page}', String(page));
    parts.push(encodeURIComponent(p.key) + '=' + encodeURIComponent(replaced));
  }
  return parts.join('&');
}

/** 搜索 —— 返回搜索结果列表 [{name, author, kind, bookUrl}]
 *  - GET(SEARCH_METHOD='GET'):searchPath 作为 URL 模板,走 legado.http.get
 *  - POST(SEARCH_METHOD='POST'):searchPath 作为 POST URL,body 由 SEARCH_BODY_PARAMS 拼 form-urlencoded
 *  - POST_RAW(SEARCH_METHOD='POST_RAW'):body 由 SEARCH_RAW_BODY 模板替换 {keyword}/{page} 后原文 POST
 *  - author / kind 为**可选增强**:由 SEARCH_AUTHOR_RULE / SEARCH_CATEGORY_RULE 在条目作用域内提取,
 *    两条规则都留空(默认)时不做任何额外提取,二者恒返回空串 —— 不影响 name/bookUrl 的搜索结果
 */
async function search(key, page) {
  let resp, pageUrl
  if (SEARCH_METHOD === 'POST') {
    pageUrl = absUrl(SEARCH_PATH.replace('{keyword}', encodeURIComponent(key)).replace('{page}', String(page)), BASE_URL)
    const body = buildFormBody(SEARCH_BODY_PARAMS, key, page)
    resp = await legado.http.post(pageUrl, body, Object.assign({}, HEADERS, { 'Content-Type': SEARCH_CONTENT_TYPE }))
  } else if (SEARCH_METHOD === 'POST_RAW') {
    pageUrl = absUrl(SEARCH_PATH.replace('{keyword}', encodeURIComponent(key)).replace('{page}', String(page)), BASE_URL)
    const body = SEARCH_RAW_BODY
      .replace('{keyword}', key)
      .replace('{page}', String(page))
    resp = await legado.http.post(pageUrl, body, Object.assign({}, HEADERS, { 'Content-Type': SEARCH_CONTENT_TYPE }))
  } else {
    const path = SEARCH_PATH
      .replace('{keyword}', encodeURIComponent(key))
      .replace('{page}', page)
    pageUrl = absUrl(path, BASE_URL)
    resp = await legado.http.get(pageUrl, HEADERS)
  }
  const extra = searchExtraRules()
  const items = await extractSearchItems(SEARCH_ITEM_RULE, resp, pageUrl)
  const out = []
  for (const it of items) {
    if (!it.name || !it.url) continue
    let author = ''
    let kind = ''
    if (extra.author) author = stripTags(await extractText(extra.author, it.context, pageUrl))
    if (extra.kind) kind = stripTags(await extractText(extra.kind, it.context, pageUrl))
    out.push({ name: it.name, author: author, kind: kind, bookUrl: it.url })
  }
  return out
}

/** 书籍详情 —— 返回书籍信息对象 {title, author, category, cover, chapters} */
async function bookInfo(bookUrl) {
  const resp = await legado.http.get(bookUrl, HEADERS)
  const cover = await extractAttr(COVER_RULE, resp, bookUrl, 'src')
  return {
    title: await extractText(BOOK_TITLE_RULE, resp, bookUrl),
    author: await extractText(BOOK_AUTHOR_RULE, resp, bookUrl),
    category: await extractText(BOOK_CATEGORY_RULE, resp, bookUrl),
    cover: absUrl(cover, bookUrl),
    chapters: await chapterList(bookUrl),
  }
}

/** 目录 —— 返回章节列表 [{name, url}] */
async function chapterList(bookUrl) {
  const resp = await legado.http.get(bookUrl, HEADERS)
  return await extractLinks(CHAPTER_ITEM_RULE, resp, bookUrl)
}

/** 正文 —— 返回章节正文文本(提取后按 CONTENT_REPLACE_RULES 顺序净化:rule 正则 g 全局替换为 replace) */
async function chapterContent(chapterUrl) {
  const resp = await legado.http.get(chapterUrl, HEADERS)
  let text = stripTags(await extractHtml(CONTENT_RULE, resp, chapterUrl))
  for (const r of CONTENT_REPLACE_RULES ?? []) {
    if (!r || typeof r !== 'object' || !r.rule) continue
    try { text = text.replace(new RegExp(r.rule, 'g'), r.replace || '') } catch (e) { /* 非法正则跳过,不中断后续规则 */ }
  }
  return text
}
`;
}
