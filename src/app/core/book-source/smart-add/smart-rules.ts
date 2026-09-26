/**
 * 智能添加的规则模型与纯函数（对应 legado SmartSourceDetector 的「提取的选择器」页，
 * 差异：沙箱无 DOM → 规则支持 CSS 选择器与正则双模式；置信度为真实命中测试而非 mock）
 */

/** 显式 CSS 前缀（含特殊字符 ? ^ 等的选择器用它强制 CSS 模式） */
export const CSS_PREFIX = 'css:';

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

/** 可视化规则：每个字段直接参数化生成的书源代码 */
export interface SourceRules {
  siteName: string;
  /** 搜索路径模板，含 {keyword}（可选 {page}）占位 */
  searchPath: string;
  /** 搜索结果列表项规则（CSS 选择器，或正则：捕获组 1=书籍 URL，2=书名） */
  searchItemPattern: string;
  /** 详情页标题规则（CSS 选择器，或正则：捕获组 1=标题） */
  bookTitlePattern: string;
  /** 详情页作者规则（CSS 选择器，或正则：捕获组 1=作者） */
  bookAuthorPattern: string;
  /** 章节链接规则（CSS 选择器，或正则：捕获组 1=章节 URL，2=章节名） */
  chapterItemPattern: string;
  /** 正文容器规则（CSS 选择器，或正则：捕获组 1=正文 HTML） */
  contentPattern: string;
  /** 书籍分类规则（CSS 选择器，或正则：捕获组 1=分类名 —— 单本书的题材分类,如"玄幻"/"都市"） */
  bookCategoryPattern?: string;
}

/** 默认规则模板（探测失败时的兜底值） */
export const DEFAULT_PATTERNS = {
  searchItemPattern: '<a[^>]+href="([^"]+)"[^>]*>([^<]{2,40})<\\/a>',
  bookTitlePattern: '<h1[^>]*>([\\s\\S]*?)<\\/h1>',
  bookAuthorPattern: '作者[：:]\\s*(?:<[^>]+>)*([^<]{1,30})',
  chapterItemPattern: '<a[^>]+href="([^"]+)"[^>]*>([^<]*第[^<]{1,60}章[^<]*)<\\/a>',
  contentPattern: '<div[^>]+id="content"[^>]*>([\\s\\S]*?)<\\/div>',
  bookCategoryPattern: '分类[：:]\\s*(?:<[^>]+>)*([^<]{1,20})',
} as const;

/** 去标签 + 常见实体反转义（与生成代码里的 stripTags 保持同语义） */
export function stripTags(html: string): string {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .trim();
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

/** 链接项提取；CSS 模式见 matchLinkItemsCss，正则模式约定组 1=href，2=文本 */
export function matchLinkItems(pattern: string, html: string, baseUrl: string, limit = 500): MatchedItem[] {
  if (cssRulesEnabled() && isCssRule(pattern)) {
    return matchLinkItemsCss(ruleSelector(pattern), html, baseUrl, limit);
  }
  const re = compile(pattern, 'gi');
  const out: MatchedItem[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    out.push({ name: stripTags(m[2] ?? ''), url: absUrl(m[1] ?? '', baseUrl) });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * CSS 模式链接提取：命中元素为 a 则取之，否则取其后代锚点；
 * 按绝对 URL 去重（同 URL 保留首个非空 name —— 同一书籍的 img 链接/书名链接/按钮链接收敛为一条）
 */
function matchLinkItemsCss(selector: string, html: string, baseUrl: string, limit: number): MatchedItem[] {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  let els: Element[];
  try {
    els = Array.from(doc.querySelectorAll(selector));
  } catch (e) {
    throw new Error(`选择器无效：${(e as Error).message}`);
  }
  const byUrl = new Map<string, MatchedItem>();
  for (const el of els) {
    const anchors = el.tagName === 'A' ? [el] : Array.from(el.querySelectorAll('a[href]'));
    for (const a of anchors) {
      const url = absUrl(a.getAttribute('href') ?? '', baseUrl);
      if (!url) continue;
      const name = (a.textContent ?? '').trim();
      const prev = byUrl.get(url);
      if (!prev || (!prev.name && name)) byUrl.set(url, { name, url });
    }
    if (byUrl.size >= limit) break;
  }
  return [...byUrl.values()];
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

/** 抓取到的首页 HTML → 初始规则集 */
export function buildRules(url: string, html: string): SourceRules {
  const host = new URL(url).hostname.replace(/^www\./, '');
  return {
    siteName: detectSiteName(html, host),
    searchPath: detectSearchPath(html),
    searchItemPattern: DEFAULT_PATTERNS.searchItemPattern,
    bookTitlePattern: DEFAULT_PATTERNS.bookTitlePattern,
    bookAuthorPattern: DEFAULT_PATTERNS.bookAuthorPattern,
    chapterItemPattern: DEFAULT_PATTERNS.chapterItemPattern,
    contentPattern: detectContentPattern(html),
    bookCategoryPattern: DEFAULT_PATTERNS.bookCategoryPattern,
  };
}

// ── 代码生成 ───────────────────────────────────────────────────────────────

/**
 * 由规则生成 pomreader 沙箱兼容的书源 JS
 * 规则串以 JSON 转义注入 —— 用户可改出含 / " \ 的任意模式都不会破坏代码结构;
 * 双模式(CSS/正则)判定在生成的代码运行时进行(与 isCssRule 同一套启发式)
 */
export function generateSourceCode(url: string, rules: SourceRules): string {
  const u = new URL(url);
  const j = (s: string) => JSON.stringify(s);
  return `// @name        ${rules.siteName}
// @version     1.1.0
// @author      智能添加
// @url         ${u.origin}
// @enabled     true
// @tags        智能识别
// @description 由智能添加从 ${u.host} 生成(CSS 选择器/正则双模式,可在智能添加页继续调规则)

const BASE_URL = ${j(u.origin)}

// ── 规则(可视化编辑的值,直接改这里也生效;CSS 选择器或正则均可,含特殊符号的选择器加 css: 前缀) ──
const SEARCH_PATH = ${j(rules.searchPath)}
const SEARCH_ITEM_RULE = ${j(rules.searchItemPattern)}
const BOOK_TITLE_RULE = ${j(rules.bookTitlePattern)}
const BOOK_AUTHOR_RULE = ${j(rules.bookAuthorPattern)}
const CHAPTER_ITEM_RULE = ${j(rules.chapterItemPattern)}
const CONTENT_RULE = ${j(rules.contentPattern)}
const BOOK_CATEGORY_RULE = ${j(rules.bookCategoryPattern ?? DEFAULT_PATTERNS.bookCategoryPattern)}

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
    .replace(/<\\/p>/gi, '\\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
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

/** 搜索 —— 返回搜索结果列表 [{name, author, bookUrl}] */
async function search(key, page) {
  const path = SEARCH_PATH
    .replace('{keyword}', encodeURIComponent(key))
    .replace('{page}', page)
  const pageUrl = absUrl(path, BASE_URL)
  const resp = await legado.http.get(pageUrl)
  return (await extractLinks(SEARCH_ITEM_RULE, resp, pageUrl))
    .map((it) => ({
      name: it.name,
      author: '',
      bookUrl: it.url,
    }))
    .filter((it) => it.name && it.bookUrl)
}

/** 书籍详情 —— 返回书籍信息对象 {title, author, category, chapters} */
async function bookInfo(bookUrl) {
  const resp = await legado.http.get(bookUrl)
  return {
    title: await extractText(BOOK_TITLE_RULE, resp, bookUrl),
    author: await extractText(BOOK_AUTHOR_RULE, resp, bookUrl),
    category: await extractText(BOOK_CATEGORY_RULE, resp, bookUrl),
    chapters: await chapterList(bookUrl),
  }
}

/** 目录 —— 返回章节列表 [{name, url}] */
async function chapterList(bookUrl) {
  const resp = await legado.http.get(bookUrl)
  return await extractLinks(CHAPTER_ITEM_RULE, resp, bookUrl)
}

/** 正文 —— 返回章节正文文本 */
async function chapterContent(chapterUrl) {
  const resp = await legado.http.get(chapterUrl)
  return stripTags(await extractHtml(CONTENT_RULE, resp, chapterUrl))
}
`;
}
