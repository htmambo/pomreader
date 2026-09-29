/**
 * 规则引擎 —— 四入口（书源 JSON 规则化 P1.3）
 *
 * 逐函数对齐**现状生产行为**（生成模板 `smart-rules.ts` 的代码生成段），不是照搬模板文本，
 * 也不是照搬 TS 侧既有近似实现。已确认并处理的两处不等价：
 *
 * 1. **正则分支剥标签**：模板 `extractText` 正则分支是 `stripTags(m[1])`，而 TS 侧
 *    `pickText` 正则分支**不剥**（`smart-rules.ts:161-168`）。照搬 `pickText` 会静默返回带标签文本
 *    → 本文件自己实现 `extractText`，正则分支带 `stripTags`。
 * 2. **CSS 查询走真实实现**：本文件**不复用** `pickText`/`pickHtml`/`pickAttr`/`matchLinkItems`
 *    —— 它们内部的 `queryFirst` 绕过了 `legado.query` 的三道约束（`cssRulesEnabled` 门、
 *    5MB 上限、空选择器报错文案）。本文件所有 CSS 查询统一走 `runQuery`（从
 *    `sandbox.service.ts` 提取导出的**真实实现**），于是这三道约束自动继承、逐字一致。
 *
 * 结果条数裁剪**不在本层**：`SEARCH_MAX_ITEMS` 属于适配器职责（与现状
 * `JsSourceAdapter.MAX_SEARCH_RESULTS` 位置一致），放这里会让差分比对失真。
 * 但 `CHAPTER_MAX_ITEMS` / `CONTENT_MAX_BYTES` 相反，**留在本层**：它们约束的是
 * 引擎交出去的结果体量，与「对外返回值语义」无关；挪到适配器会让 `bookInfo().chapters`
 * 这条不经适配器的直连路径（调试页 / 源测试）绕过上限。
 *
 * ## 与旧引擎**有意**不一致的两处（唯一两处，其余逐条对齐）
 *
 * 1. **单章正文 2MB 上限**。旧模板的 `chapterContent`（`smart-rules.ts:823-831`）**没有任何
 *    长度裁剪** —— 全文里 `slice` / `substring` / `substr` 零命中。这道门是方案 §3.2 guard 表
 *    明列的"**新增，无沙箱兜底**"：沙箱在时结果体量由 Worker 兜着，引擎在主线程没有。
 *    差分测试因此**不能**用 >2MB 的正文做夹具（两侧必然不等），已在差分基座的
 *    `SAMPLE_HTML.chapter` 上钉住（远小于上限）。
 * 2. **章节数 20000 上限**。同理，真实生效的是模板常量 `MAX_EXTRACT_LINKS=500`（见
 *    `guard.ts` 的说明），20000 那道今天不可达，属冗余兜底。
 *
 * 代理对处理（`truncateText`）属于第 1 条内部：它只在"已经因上限而不一致"的输入上起作用，
 * 不新增任何分歧类别；留着是为了别在裁剪边界吐一个 U+FFFD。
 */
import {
  absUrl,
  applyContentReplaceRules,
  buildFormBody,
  cssRulesEnabled,
  isCssRule,
  resolveRuleDefaults,
  ruleSelector,
  stripTags,
  type ContentReplaceRule,
  type SearchBodyParam,
  type SearchMethod,
  type SourceRules,
} from '../smart-add/smart-rules';
import { runQuery } from '../js-source/sandbox.service';
import type { QueryItem } from '../js-source/sandbox.service';
import { CHAPTER_MAX_ITEMS, CONTENT_MAX_BYTES, checkRule, ExecBudget } from './guard';

// ── HTTP 契约（与 preload 的 booksourceHttpProxy 一致，见方案 §3.2 Round 3 修订）──

export interface EngineHttpRequest {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string | null;
}

export interface EngineHttpResponse {
  /** 状态码。**引擎据此做 2xx 门**：非 2xx 抛 `HTTP <status>`（与 `sandbox.worker.ts:405-409` 的 shim 同契约） */
  status: number;
  body: string;
  /** 主进程回传的 CF 标志；引擎据此调 Tier 2 人工过盾（不经过 FetchError —— 见方案 §3.2） */
  cfChallenge?: boolean;
}

export type EngineHttp = (req: EngineHttpRequest) => Promise<EngineHttpResponse>;

// ── 契约类型（与 js-source.adapter.ts / 差分基座一致）──

export interface RawSearchItem {
  name: string;
  author: string;
  kind: string;
  bookUrl: string;
}

export interface LinkItem {
  name: string;
  url: string;
}

export interface BookInfoLike {
  title: string;
  author: string;
  category: string;
  cover: string;
  chapters: LinkItem[];
}

export interface RuleEngineInput {
  rules: SourceRules;
  /** 主站 origin（原 BASE_URL） */
  homepage: string;
  /** 自定义请求头（原 HEADERS 常量，legado 导入产物才有） */
  headers?: Record<string, string>;
  http: EngineHttp;
  /** 与模板常量一致：单次提取的链接上限 */
  maxExtractLinks?: number;
}

export interface RuleEngine {
  search(keyword: string, page: number): Promise<RawSearchItem[]>;
  bookInfo(bookUrl: string): Promise<BookInfoLike>;
  chapterList(bookUrl: string): Promise<LinkItem[]>;
  chapterContent(chapterUrl: string): Promise<string>;
}

const DEFAULT_MAX_EXTRACT_LINKS = 500; // 模板常量 MAX_EXTRACT_LINKS

/**
 * 全部规则串事前过 guard：危险正则只能事前拦（事后主线程无法中断同步回溯）
 *
 * `contentReplaceRules` 是**数组**，`Object.entries` 的值不是字符串会被 `typeof` 过滤掉 ——
 * 漏检它就等于留了一条绕过守卫的路：净化规则同样是拿正则去跑正文（`/g` 全局替换），
 * 一条 `(a+)+` 就能在主线程上冻住整个应用。外部评审 R1 抓到，已补。
 */
function assertRulesPassable(rules: SourceRules): void {
  for (const [name, value] of Object.entries(rules)) {
    if (typeof value !== 'string' || !value) continue;
    if (name === 'searchContentType') continue; // 不是选择器
    const r = checkRule(value);
    if (!r.ok) throw new Error(`${name}：${r.reason}`);
  }
  const replaceRules = rules.contentReplaceRules ?? [];
  for (let i = 0; i < replaceRules.length; i++) {
    const pattern = replaceRules[i]?.rule;
    if (!pattern) continue; // 空 rule 由 applyContentReplaceRules 自行跳过
    const r = checkRule(pattern);
    if (!r.ok) throw new Error(`contentReplaceRules[${i}]：${r.reason}`);
  }
}

export function createRuleEngine(input: RuleEngineInput): RuleEngine {
  // 缺省收口放在**引擎自己这里**，而不是只靠"调用方都记得过"的约定：
  // ① `SourceRules` 的可选字段类型是 `string | undefined`，直接用会让
  //    `isCssRule(undefined)` 抛 "Cannot read properties of undefined" —— 报错完全不指向书源规则；
  // ② 旧引擎那一侧的缺省是 `generateSourceCode` **烘焙进源码的字面量**，差分基座必须同样在
  //    引擎侧补齐，两边才对称（否则"引擎忘了过 resolveRuleDefaults"会伪装成行为漂移）。
  // 幂等：全程 `??`，已解析的值原样保留。
  const rules = resolveRuleDefaults(input.rules);
  const { homepage, http } = input;
  const docHeaders = input.headers ?? {};
  const maxLinks = input.maxExtractLinks ?? DEFAULT_MAX_EXTRACT_LINKS;
  const budget = new ExecBudget();

  assertRulesPassable(rules);

  // ── 查询：统一走真实实现，继承 flag 门 / 5MB 上限 / 空选择器报错 ──
  async function queryAll(html: string, rule: string, baseUrl: string): Promise<QueryItem[]> {
    const r = runQuery(html, ruleSelector(rule), baseUrl);
    if (!r.ok) throw new Error(r.error);
    return r.items;
  }

  /** 模板 `matchAll`：重置 lastIndex + 上限截断 */
  function matchAll(re: RegExp, html: string): RegExpExecArray[] {
    re.lastIndex = 0;
    const out: RegExpExecArray[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      out.push(m);
      if (out.length >= maxLinks) break;
    }
    return out;
  }

  // ── 单值提取（三者的 CSS 分支取首个命中，正则分支各自不同）──

  /** 模板 `extractText`：CSS 取首个 textContent；**正则分支剥标签**（与 pickText 的差异点） */
  async function extractText(rule: string, html: string, baseUrl: string): Promise<string> {
    if (isCssRule(rule)) {
      const items = await queryAll(html, rule, baseUrl);
      return ((items[0] && items[0].text) || '').trim();
    }
    const m = new RegExp(rule, 'i').exec(html);
    return m ? stripTags(m[1] || '') : '';
  }

  /** 模板 `extractHtml`：CSS 取首个 innerHTML；正则分支取组 1，**不剥标签** */
  async function extractHtml(rule: string, html: string, baseUrl: string): Promise<string> {
    if (isCssRule(rule)) {
      const items = await queryAll(html, rule, baseUrl);
      return (items[0] && items[0].html) || '';
    }
    const m = new RegExp(rule, 'i').exec(html);
    return (m && m[1]) || '';
  }

  /** 模板 `extractAttr`：CSS 取首个命中元素的 attr；正则分支取组 1。**两者都不做绝对化**（由调用方 absUrl） */
  async function extractAttr(
    rule: string,
    html: string,
    baseUrl: string,
    attr: string,
  ): Promise<string> {
    if (isCssRule(rule)) {
      const items = await queryAll(html, rule, baseUrl);
      const first = items[0];
      if (!first || !first.attrs) return '';
      return (first.attrs[attr] != null ? first.attrs[attr] : '') || '';
    }
    const m = new RegExp(rule, 'i').exec(html);
    return (m && m[1]) || '';
  }

  // ── 列表提取 ──

  /** 模板 `extractLinks`：CSS 分支按 href 去重（后出现的有名字就补名）；正则分支组 1=href 组 2=文本 */
  async function extractLinks(rule: string, html: string, baseUrl: string): Promise<LinkItem[]> {
    if (isCssRule(rule)) {
      const items = await queryAll(html, rule, baseUrl);
      const byUrl = new Map<string, LinkItem>();
      for (const el of items) {
        for (const l of el.links || []) {
          if (!l.href) continue;
          const prev = byUrl.get(l.href);
          if (!prev || (!prev.name && l.text)) byUrl.set(l.href, { name: l.text, url: l.href });
        }
        if (byUrl.size >= maxLinks) break;
      }
      return [...byUrl.values()];
    }
    return matchAll(new RegExp(rule, 'gi'), html).map((m) => ({
      name: stripTags(m[2]),
      url: absUrl(m[1], baseUrl),
    }));
  }

  interface SearchItemWithContext extends LinkItem {
    context: string;
  }

  /** 模板 `extractSearchItems`：额外带 `context`（条目作用域 HTML），供作者/分类增强规则提取 */
  async function extractSearchItems(
    rule: string,
    html: string,
    baseUrl: string,
  ): Promise<SearchItemWithContext[]> {
    if (isCssRule(rule)) {
      const items = await queryAll(html, rule, baseUrl);
      const byUrl = new Map<string, SearchItemWithContext>();
      for (const el of items) {
        for (const l of el.links || []) {
          if (!l || !l.href) continue;
          const prev = byUrl.get(l.href);
          if (!prev) byUrl.set(l.href, { name: l.text, url: l.href, context: el.html || '' });
          else {
            if (!prev.name && l.text) prev.name = l.text;
            if (!prev.context && el.html) prev.context = el.html;
          }
        }
        if (byUrl.size >= maxLinks) break;
      }
      return [...byUrl.values()];
    }
    const matches = matchAll(new RegExp(rule, 'gi'), html);
    return matches.map((m, i) => ({
      name: stripTags(m[2]),
      url: absUrl(m[1], baseUrl),
      context: html.slice(m.index, i + 1 < matches.length ? matches[i + 1].index : html.length),
    }));
  }

  /** 模板 `searchExtraRules`：老源缺这两个常量时按「未配置」处理（向后兼容） */
  function searchExtraRules(): { author: string; kind: string } {
    return {
      author: String(rules.searchAuthorPattern || ''),
      kind: String(rules.searchCategoryPattern || ''),
    };
  }

  /**
   * 唯一的出口：所有 HTTP 都过这里，**统一做 2xx 门**
   *
   * 旧链路里这道门在 `sandbox.worker.ts:405-409`（`legado.http` 的 shim：非 2xx 直接
   * `reject('HTTP <status>')`）。引擎不在 transport 层做，就等于让 404/500 的错误页
   * 原文进提取器 —— 规则匹配不上时得到的是"空标题 + 空目录"这种**静默错结果**，
   * 而不是现状那种响亮失败。故放在这里而不是 `EngineHttp` 的实现方：注入的 http
   * 可能来自差分基座或将来新链路，靠约定不如靠类型与代码。
   */
  async function request(req: EngineHttpRequest): Promise<string> {
    budget.check();
    const r = await http(req);
    budget.check();
    if (r.status < 200 || r.status >= 300) throw new Error(`HTTP ${r.status}`);
    return r.body;
  }

  async function fetchText(url: string): Promise<string> {
    return request({ url, method: 'GET', headers: { ...docHeaders } });
  }

  // ── 四入口 ──

  async function search(keyword: string, page: number): Promise<RawSearchItem[]> {
    const method: SearchMethod = rules.searchMethod ?? 'GET';
    const contentType =
      rules.searchContentType ??
      (method === 'POST_RAW' ? 'application/json' : 'application/x-www-form-urlencoded');
    const rawBody = rules.searchRawBody ?? '';
    const bodyParams: SearchBodyParam[] = rules.searchBodyParams ?? [];
    const out: RawSearchItem[] = [];
    let pageUrl: string;
    let resp: string;

    if (method === 'POST') {
      pageUrl = absUrl(
        rules.searchPath
          .replace('{keyword}', encodeURIComponent(keyword))
          .replace('{page}', String(page)),
        homepage,
      );
      resp = await request({
        url: pageUrl,
        method: 'POST',
        headers: { ...docHeaders, 'Content-Type': contentType },
        body: buildFormBody(bodyParams, keyword, page),
      });
    } else if (method === 'POST_RAW') {
      pageUrl = absUrl(
        rules.searchPath
          .replace('{keyword}', encodeURIComponent(keyword))
          .replace('{page}', String(page)),
        homepage,
      );
      resp = await request({
        url: pageUrl,
        method: 'POST',
        headers: { ...docHeaders, 'Content-Type': contentType },
        body: rawBody.replace('{keyword}', keyword).replace('{page}', String(page)),
      });
    } else {
      const path = rules.searchPath
        .replace('{keyword}', encodeURIComponent(keyword))
        .replace('{page}', String(page));
      pageUrl = absUrl(path, homepage);
      resp = await fetchText(pageUrl);
    }

    const extra = searchExtraRules();
    const items = await extractSearchItems(rules.searchItemPattern, resp, pageUrl);
    for (const it of items) {
      if (!it.name || !it.url) continue;
      let author = '';
      let kind = '';
      if (extra.author) {
        author = stripTags(await extractText(extra.author, it.context, pageUrl));
      }
      if (extra.kind) {
        kind = stripTags(await extractText(extra.kind, it.context, pageUrl));
      }
      out.push({ name: it.name, author, kind, bookUrl: it.url });
    }
    return out;
  }

  async function chapterList(bookUrl: string): Promise<LinkItem[]> {
    const resp = await fetchText(bookUrl);
    const links = await extractLinks(rules.chapterItemPattern, resp, bookUrl);
    // 章节数上限：畸形源（选择器过宽 / 正则命中整页导航）会产出上万条，
    // 裁掉尾部而不是报错 —— 现状沙箱侧没有这道门，但新引擎没有沙箱兜底，
    // 结果体量直接进内存与前端渲染，必须在引擎层收口（方案 §3.2 guard 表）。
    return links.length > CHAPTER_MAX_ITEMS ? links.slice(0, CHAPTER_MAX_ITEMS) : links;
  }

  async function bookInfo(bookUrl: string): Promise<BookInfoLike> {
    const resp = await fetchText(bookUrl);
    const cover = await extractAttr(rules.coverUrlPattern, resp, bookUrl, 'src');
    return {
      title: await extractText(rules.bookTitlePattern, resp, bookUrl),
      author: await extractText(rules.bookAuthorPattern, resp, bookUrl),
      category: await extractText(rules.bookCategoryPattern, resp, bookUrl),
      cover: absUrl(cover, bookUrl),
      chapters: await chapterList(bookUrl),
    };
  }

  async function chapterContent(chapterUrl: string): Promise<string> {
    const resp = await fetchText(chapterUrl);
    const text = stripTags(await extractHtml(rules.contentPattern, resp, chapterUrl));
    const rules_: ContentReplaceRule[] = rules.contentReplaceRules ?? [];
    const cleaned = applyContentReplaceRules(text, rules_);
    // 单章正文上限：净化**之后**的最终文本才是一路进内存、进缓存、进页面的东西，
    // 裁在净化后才是真的防住了体量（净化规则常做减法，先裁会漏掉这一步的收益）。
    return truncateText(cleaned, CONTENT_MAX_BYTES);
  }

  return { search, bookInfo, chapterList, chapterContent };
}

/**
 * 按上限截断文本，**不把代理对劈成两半**
 *
 * 上限按 UTF-16 code unit 计（`String.length` 的口径，≈ 字符数，emoji 占 2）。
 * 切点可能落在代理对中间 → 末尾留下一个孤立的高代理，渲染时变成 `�`。
 * 这里退一个 code unit 把它整对裁掉。
 */
function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(max - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, max - 1) : cut;
}

/** 供测试/调试确认门是否生效；引擎本身不重复判（由 runQuery 内部判） */
export { cssRulesEnabled };
