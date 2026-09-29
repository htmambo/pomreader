// @name        样本净化站
// @version     1.2.0
// @author      智能添加
// @url         https://sample-clean.invalid
// @enabled     true
// @tags        智能识别
// @description 由智能添加从 sample-clean.invalid 生成(CSS 选择器/正则双模式,可在智能添加页继续调规则)

const BASE_URL = "https://sample-clean.invalid"
const HEADERS = {}

// ── 规则(可视化编辑的值,直接改这里也生效;CSS 选择器或正则均可,含特殊符号的选择器加 css: 前缀) ──
const SEARCH_PATH = "/search?keyword={keyword}"
const SEARCH_METHOD = "GET"
const SEARCH_BODY_PARAMS = []
const SEARCH_CONTENT_TYPE = "application/x-www-form-urlencoded"
const SEARCH_RAW_BODY = ""
const SEARCH_ITEM_RULE = "css:dl.list dd"
const SEARCH_AUTHOR_RULE = ""
const SEARCH_CATEGORY_RULE = ""
const BOOK_TITLE_RULE = "css:h1.book-title"
const BOOK_AUTHOR_RULE = "css:span.author"
const CHAPTER_ITEM_RULE = "css:ul.chapters a"
const CONTENT_RULE = "css:div#content"
const CONTENT_REPLACE_RULES = [{"rule":"【广告】[^\\n]*","replace":""},{"rule":"最新章节地址：\\S+","replace":""},{"rule":"（本章完）","replace":""}]
const BOOK_CATEGORY_RULE = "css:span.category"
const COVER_RULE = "css:img.cover"

// ── 规则模式判定(css: 前缀 → CSS;含正则特征字符 → 正则;兜底 CSS) ──
const REGEX_HINT_CHARS = '\\(){}?|^$*+'
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
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<div[^>]*>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    // 先解码 &amp; 再处理具体实体:双重编码(如 &amp;nbsp;)还原为 &nbsp; 后统一转换
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    // 水平空白压缩(不动换行);3+ 连续换行封顶为段间空行 —— </p> 与 <br> 各产生的换行保留
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\n[^\S\n]+/g, '\n')
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
