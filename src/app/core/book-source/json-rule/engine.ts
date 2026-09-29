/**
 * JSON 规则引擎（方案 §3.2）：BookSourceDoc.rules 直接由 TS 执行，替代「生成 JS + 沙箱运行」。
 *
 * 行为与 JS 模板逐字段等价（smart-rules.ts generateSourceCode 生成的 search/bookInfo/
 * chapterList/chapterContent，:695-756）。对齐要点：
 *  - HTTP 不直连 IPC：构造函数注入 RuleEngineHttp，由外层 service 接 booksourceHttpProxy + CF 弹窗
 *  - F6：模板 extractText 正则分支 stripTags(m[1])，而 pickText 正则分支不剥标签
 *    → 单值文本一律走本模块的 pickTextStripped，不得直接用 pickText
 *  - F6c：cssRulesEnabled 止血开关现状两条链路都在（sandbox.service.ts:676-677 对每个 CSS
 *    选择器 fail）→ 引擎对每条 CSS 规则先过 assertCssAllowed，抛与沙箱同一文案
 *  - 提取复用 smart-rules 纯函数（stripTags/absUrl/buildFormBody/applyContentReplaceRules/
 *    pickHtml/pickAttr/matchLinkItems/matchSearchItems 已核对逐字等价）
 *  - 执行护栏（长度/正则风险/预算/HTML 上限/结果裁剪/原型防御）全部在 guard.ts
 *
 * 本模块是纯 TS（主线程运行），无 Angular 装饰器；DOMParser 不执行脚本本身安全，
 * 唯一不可中断的环节是正则回溯，靠 guard 静态检查 + 长度上限兜（方案 §3.2 已知取舍）。
 */
import type { BookSourceDoc } from '../../models/book-source-doc.model';
import {
  absUrl,
  applyContentReplaceRules,
  buildFormBody,
  cssRulesEnabled,
  DEFAULT_PATTERNS,
  isCssRule,
  matchLinkItems,
  matchSearchItems,
  pickAttr,
  pickHtml,
  pickText,
  stripTags,
  type ContentReplaceRule,
  type SearchMethod,
} from '../smart-add/smart-rules';
import {
  assertHtmlSize,
  assertRegexSafe,
  assertRuleLength,
  capContent,
  capList,
  CHAPTER_MAX_ITEMS,
  EXECUTION_BUDGET_MS,
  SEARCH_MAX_RESULTS,
  whitelistResult,
  withBudget,
} from './guard';

/**
 * 引擎的 HTTP 抽象（对齐 legado.http.get/post）：只回 body 文本。
 * 由外层 service 实现（接 booksourceHttpProxy + CF Tier 2 弹窗），引擎不感知 IPC。
 */
export interface RuleEngineHttp {
  get(url: string, headers: Record<string, string>): Promise<string>;
  post(url: string, body: string, headers: Record<string, string>): Promise<string>;
}

/** 引擎入口阶段 */
export type RuleEnginePhase = 'search' | 'bookInfo' | 'chapterList' | 'chapterContent';

/** 一次入口调用内的追踪记录（调试页数据源，替代 sandbox.progress，方案 F11） */
export interface RuleTrace {
  /** 所属入口 */
  phase: RuleEnginePhase;
  /** http=一次请求；extract=一次规则提取；done=入口收尾（失败时带 error） */
  stage: 'http' | 'extract' | 'done';
  /** 请求 URL（stage=http） */
  url?: string;
  /** 请求方法（stage=http；POST_RAW 归为 POST） */
  method?: 'GET' | 'POST';
  /** HTTP 状态码 —— RuleEngineHttp 只回 body，状态由外层 service 补充填写 */
  status?: number;
  /** 命中的规则字段名（stage=extract），如 searchItemPattern */
  ruleField?: string;
  /** 命中的规则串（stage=extract） */
  rule?: string;
  /** 提取条数（search/chapterList） */
  itemCount?: number;
  /** 正文长度（chapterContent） */
  contentLength?: number;
  /** 本步骤耗时 ms */
  durationMs: number;
  /** 错误信息（stage=done 且失败时） */
  error?: string;
}

export type RuleTraceListener = (trace: RuleTrace) => void;

/** 内部 emit：phase 由入口包装层统一补（RuleTrace.phase） */
type PhaseTraceEmitter = (trace: Omit<RuleTrace, 'phase'>) => void;

/** 搜索结果条目（模板 search() 返回形态：author/kind 恒为字符串，缺省 ''） */
export interface RuleSearchItem {
  name: string;
  author: string;
  kind: string;
  bookUrl: string;
}

/** 章节条目（模板 chapterList() 返回形态） */
export interface RuleChapterItem {
  name: string;
  url: string;
}

/** 书籍详情（模板 bookInfo() 返回形态） */
export interface RuleBookInfo {
  title: string;
  author: string;
  category: string;
  cover: string;
  chapters: RuleChapterItem[];
}

export interface RuleEngineOptions {
  /** 单次入口执行预算（缺省 15s；测试可注入更小值，勿真等 15s） */
  budgetMs?: number;
}

/** F6c 门报错文案：与 sandbox.service.ts:677 逐字一致，差分矩阵断言同一文案 */
export const CSS_RULES_DISABLED_MESSAGE = 'CSS 规则已禁用（localStorage pom.cssRules=0）';

/** 模板提取层上限（generateSourceCode 的 MAX_EXTRACT_LINKS，smart-rules.ts:539） */
const MAX_EXTRACT_LINKS = 500;

/**
 * F6c 门：CSS 规则在 localStorage['pom.cssRules']==='0' 时响亮失败。
 * ⚠️ 不能依赖 smart-rules 函数的自带门 —— pickText/matchLinkItems 在 flag=0 时是
 * 静默回退正则（:162,:275），而沙箱链路是 fail；引擎必须在每条 CSS 路径前显式检查。
 */
function assertCssAllowed(pattern: string): void {
  if (!cssRulesEnabled() && isCssRule(pattern)) {
    throw new Error(CSS_RULES_DISABLED_MESSAGE);
  }
}

/**
 * 单值文本提取（模板 extractText，smart-rules.ts:638-646）：
 *  - CSS 分支：首个命中元素 textContent.trim() —— 与 pickText CSS 分支一致，直接复用
 *  - 正则分支：模板是 stripTags(m[1])，pickText 不剥标签（F6）→ 本地补 stripTags
 */
function pickTextStripped(pattern: string, html: string): string {
  assertCssAllowed(pattern);
  if (cssRulesEnabled() && isCssRule(pattern)) {
    return pickText(pattern, html);
  }
  return stripTags(pickText(pattern, html));
}

/** 本入口用到的规则串：长度 + 正则静态风险（CSS 选择器不做正则检查） */
function checkPatterns(fields: Array<[string, string]>): void {
  for (const [field, pattern] of fields) {
    assertRuleLength(field, pattern);
    if (!isCssRule(pattern)) assertRegexSafe(field, pattern);
  }
}

/** 正文净化规则一律按正则编译（无 CSS 模式），逐条检查；空 rule 与模板一样跳过 */
function checkReplaceRules(rules: ContentReplaceRule[] | undefined): void {
  for (const r of rules ?? []) {
    if (!r || typeof r !== 'object' || !r.rule) continue;
    assertRuleLength('contentReplaceRules.rule', r.rule);
    assertRegexSafe('contentReplaceRules.rule', r.rule);
  }
}

export class JsonRuleEngine {
  private readonly budgetMs: number;

  constructor(
    private readonly http: RuleEngineHttp,
    options: RuleEngineOptions = {},
  ) {
    this.budgetMs = options.budgetMs ?? EXECUTION_BUDGET_MS;
  }

  /** 搜索（模板 :695-726）：GET/POST/POST_RAW 三形态 + author/kind 可选增强规则 */
  async search(
    doc: BookSourceDoc,
    keyword: string,
    page: number | string = 1,
    onTrace?: RuleTraceListener,
  ): Promise<RuleSearchItem[]> {
    return this.execute('search', onTrace, (emit) => this.doSearch(doc, keyword, page, emit));
  }

  /** 书籍详情（模板 :729-739）；注意模板内部会再调 chapterList 复抓一次 bookUrl */
  async bookInfo(
    doc: BookSourceDoc,
    bookUrl: string,
    onTrace?: RuleTraceListener,
  ): Promise<RuleBookInfo> {
    return this.execute('bookInfo', onTrace, (emit) => this.doBookInfo(doc, bookUrl, emit));
  }

  /** 目录（模板 :742-745） */
  async chapterList(
    doc: BookSourceDoc,
    bookUrl: string,
    onTrace?: RuleTraceListener,
  ): Promise<RuleChapterItem[]> {
    return this.execute('chapterList', onTrace, (emit) => this.doChapterList(doc, bookUrl, emit));
  }

  /** 正文（模板 :748-756）：提取 → stripTags → contentReplaceRules 顺序净化 */
  async chapterContent(
    doc: BookSourceDoc,
    chapterUrl: string,
    onTrace?: RuleTraceListener,
  ): Promise<string> {
    return this.execute('chapterContent', onTrace, (emit) =>
      this.doChapterContent(doc, chapterUrl, emit),
    );
  }

  // ── 内部实现 ──────────────────────────────────────────────────────────────

  /** 入口包装：预算 + done trace（成功/失败都发）；phase 由本层统一补进 trace */
  private async execute<T>(
    phase: RuleEnginePhase,
    onTrace: RuleTraceListener | undefined,
    task: (emit: PhaseTraceEmitter) => Promise<T>,
  ): Promise<T> {
    const started = Date.now();
    const emit: PhaseTraceEmitter = (t) => onTrace?.({ phase, ...t });
    try {
      const result = await withBudget(task(emit), this.budgetMs, phase);
      emit({ stage: 'done', durationMs: Date.now() - started });
      return result;
    } catch (e) {
      emit({ stage: 'done', durationMs: Date.now() - started, error: (e as Error).message });
      throw e;
    }
  }

  /** HTTP 步骤：计时 + trace；POST_RAW 与 POST 都走 http.post */
  private async request(
    emit: PhaseTraceEmitter,
    method: 'GET' | 'POST',
    url: string,
    body: string | undefined,
    headers: Record<string, string>,
  ): Promise<string> {
    const started = Date.now();
    try {
      const resp =
        method === 'GET'
          ? await this.http.get(url, headers)
          : await this.http.post(url, body ?? '', headers);
      emit({ stage: 'http', url, method, durationMs: Date.now() - started });
      return resp;
    } catch (e) {
      emit({
        stage: 'http',
        url,
        method,
        durationMs: Date.now() - started,
        error: (e as Error).message,
      });
      throw e;
    }
  }

  private async doSearch(
    doc: BookSourceDoc,
    keyword: string,
    page: number | string,
    emit: PhaseTraceEmitter,
  ): Promise<RuleSearchItem[]> {
    const rules = doc.rules;
    const method: SearchMethod = rules.searchMethod ?? 'GET';
    // searchContentType 缺省回填与模板一致（smart-rules.ts:483-485）
    const contentType =
      rules.searchContentType ??
      (method === 'POST_RAW' ? 'application/json' : 'application/x-www-form-urlencoded');
    const headers = doc.headers ?? {};
    const authorRule = rules.searchAuthorPattern ?? '';
    const categoryRule = rules.searchCategoryPattern ?? '';

    checkPatterns([
      ['searchItemPattern', rules.searchItemPattern],
      ...(authorRule ? ([['searchAuthorPattern', authorRule]] as Array<[string, string]>) : []),
      ...(categoryRule
        ? ([['searchCategoryPattern', categoryRule]] as Array<[string, string]>)
        : []),
    ]);
    // F6c 门：条目规则与两条增强规则各自过门（增强规则可能是 CSS 而条目规则是正则）
    assertCssAllowed(rules.searchItemPattern);
    if (authorRule) assertCssAllowed(authorRule);
    if (categoryRule) assertCssAllowed(categoryRule);

    // URL 模板替换与模板 :698-712 逐字对齐：URL 里 keyword 一律 encodeURIComponent；
    // POST_RAW 的 body 里 keyword 不 encode（由用户自管）
    let pageUrl: string;
    let resp: string;
    if (method === 'POST') {
      pageUrl = absUrl(
        rules.searchPath
          .replace('{keyword}', encodeURIComponent(keyword))
          .replace('{page}', String(page)),
        doc.homepage,
      );
      const body = buildFormBody(rules.searchBodyParams ?? [], keyword, page);
      resp = await this.request(emit, 'POST', pageUrl, body, {
        ...headers,
        'Content-Type': contentType,
      });
    } else if (method === 'POST_RAW') {
      pageUrl = absUrl(
        rules.searchPath
          .replace('{keyword}', encodeURIComponent(keyword))
          .replace('{page}', String(page)),
        doc.homepage,
      );
      const body = (rules.searchRawBody ?? '')
        .replace('{keyword}', keyword)
        .replace('{page}', String(page));
      resp = await this.request(emit, 'POST', pageUrl, body, {
        ...headers,
        'Content-Type': contentType,
      });
    } else {
      pageUrl = absUrl(
        rules.searchPath
          .replace('{keyword}', encodeURIComponent(keyword))
          .replace('{page}', String(page)),
        doc.homepage,
      );
      resp = await this.request(emit, 'GET', pageUrl, undefined, headers);
    }
    assertHtmlSize(resp);

    // 条目提取对齐模板 extractSearchItems（:603-627）：CSS 按 URL 收敛去重 + context=条目
    // innerHTML；正则不去重、context=本条起点到下条起点。matchSearchItems 内部
    // extractItemContexts 与模板收敛逻辑逐字一致（!prev.name && name 补名、
    // !prev.context && context 补 context），增强规则提取语义也已核对等价（见文件头注释）。
    const items = matchSearchItems(
      rules.searchItemPattern,
      resp,
      pageUrl,
      { authorRule, categoryRule },
      MAX_EXTRACT_LINKS,
    );
    emit({
      stage: 'extract',
      ruleField: 'searchItemPattern',
      rule: rules.searchItemPattern,
      itemCount: items.length,
      durationMs: 0,
    });

    // 模板 :717-724：空 name/url 的条目丢弃；author/kind 恒为字符串
    const out: RuleSearchItem[] = [];
    for (const it of items) {
      if (!it.name || !it.url) continue;
      out.push(
        whitelistResult({
          name: it.name,
          author: it.author ?? '',
          kind: it.kind ?? '',
          bookUrl: it.url,
        }),
      );
    }
    return capList(out, SEARCH_MAX_RESULTS);
  }

  private async doBookInfo(
    doc: BookSourceDoc,
    bookUrl: string,
    emit: PhaseTraceEmitter,
  ): Promise<RuleBookInfo> {
    const rules = doc.rules;
    // 缺省回填与模板 :488,:519 一致
    const categoryRule = rules.bookCategoryPattern ?? DEFAULT_PATTERNS.bookCategoryPattern;
    const coverRule = rules.coverUrlPattern ?? DEFAULT_PATTERNS.coverUrlPattern;
    checkPatterns([
      ['bookTitlePattern', rules.bookTitlePattern],
      ['bookAuthorPattern', rules.bookAuthorPattern],
      ['bookCategoryPattern', categoryRule],
      ['coverUrlPattern', coverRule],
    ]);
    assertCssAllowed(rules.bookTitlePattern);
    assertCssAllowed(rules.bookAuthorPattern);
    assertCssAllowed(categoryRule);
    assertCssAllowed(coverRule);

    const resp = await this.request(emit, 'GET', bookUrl, undefined, doc.headers ?? {});
    assertHtmlSize(resp);

    // 模板 :731-737：cover 先提取再过 absUrl；title/author/category 走 extractText 语义
    const cover = pickAttr(coverRule, resp, 'src');
    const info = whitelistResult({
      title: pickTextStripped(rules.bookTitlePattern, resp),
      author: pickTextStripped(rules.bookAuthorPattern, resp),
      category: pickTextStripped(categoryRule, resp),
      cover: absUrl(cover, bookUrl),
    });
    emit({ stage: 'extract', ruleField: 'bookInfo', durationMs: 0 });
    // 模板 bookInfo 的 chapters 来自 chapterList(bookUrl) —— 会复抓一次详情页 URL，照做
    const chapters = await this.doChapterList(doc, bookUrl, emit);
    return whitelistResult({ ...info, chapters });
  }

  private async doChapterList(
    doc: BookSourceDoc,
    bookUrl: string,
    emit: PhaseTraceEmitter,
  ): Promise<RuleChapterItem[]> {
    const rules = doc.rules;
    checkPatterns([['chapterItemPattern', rules.chapterItemPattern]]);
    assertCssAllowed(rules.chapterItemPattern);

    const resp = await this.request(emit, 'GET', bookUrl, undefined, doc.headers ?? {});
    assertHtmlSize(resp);

    // 模板 extractLinks 语义 = matchLinkItems（CSS 按 URL 去重/正则不去重，不过滤空条目）
    const items = matchLinkItems(rules.chapterItemPattern, resp, bookUrl, MAX_EXTRACT_LINKS);
    emit({
      stage: 'extract',
      ruleField: 'chapterItemPattern',
      rule: rules.chapterItemPattern,
      itemCount: items.length,
      durationMs: 0,
    });
    return capList(
      items.map((it) => whitelistResult({ name: it.name, url: it.url })),
      CHAPTER_MAX_ITEMS,
    );
  }

  private async doChapterContent(
    doc: BookSourceDoc,
    chapterUrl: string,
    emit: PhaseTraceEmitter,
  ): Promise<string> {
    const rules = doc.rules;
    checkPatterns([['contentPattern', rules.contentPattern]]);
    checkReplaceRules(rules.contentReplaceRules);
    assertCssAllowed(rules.contentPattern);

    const resp = await this.request(emit, 'GET', chapterUrl, undefined, doc.headers ?? {});
    assertHtmlSize(resp);

    // 模板 :750：stripTags(extractHtml(...)) —— extractHtml 正则分支取 m[1] 原文（不剥标签），
    // pickHtml 与之对齐；随后 contentReplaceRules 顺序净化（applyContentReplaceRules 同源实现）
    let text = stripTags(pickHtml(rules.contentPattern, resp));
    emit({
      stage: 'extract',
      ruleField: 'contentPattern',
      rule: rules.contentPattern,
      contentLength: text.length,
      durationMs: 0,
    });
    text = applyContentReplaceRules(text, rules.contentReplaceRules);
    return capContent(text);
  }
}
