/**
 * JsonRuleEngine 单元测试：假 http（URL → 固定 HTML 映射）驱动四入口，
 * 并用 generateSourceCode 生成的模板代码做 3 组等价性对照（真正的双引擎差分在另一任务）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CSS_RULES_DISABLED_MESSAGE,
  JsonRuleEngine,
  type RuleEngineHttp,
  type RuleTrace,
} from './engine';
import type { BookSourceDoc } from '../../models/book-source-doc.model';
import { DEFAULT_PATTERNS, generateSourceCode, type SourceRules } from '../smart-add/smart-rules';
import { HTML_MAX_LENGTH } from './guard';

const BASE = 'https://www.sample.com';

interface HttpCall {
  method: 'GET' | 'POST';
  url: string;
  body?: string;
  headers: Record<string, string>;
}

/** URL → 固定 HTML 的假 http；记录全部调用供断言 */
class FakeHttp implements RuleEngineHttp {
  readonly calls: HttpCall[] = [];
  constructor(private readonly routes: Record<string, string>) {}
  async get(url: string, headers: Record<string, string>): Promise<string> {
    this.calls.push({ method: 'GET', url, headers });
    return this.routes[url] ?? '';
  }
  async post(url: string, body: string, headers: Record<string, string>): Promise<string> {
    this.calls.push({ method: 'POST', url, body, headers });
    return this.routes[url] ?? '';
  }
}

function makeDoc(rules: Partial<SourceRules> & Pick<SourceRules, 'siteName'>): BookSourceDoc {
  return {
    format: 'pomreader.booksource',
    schemaVersion: 1,
    uuid: 'sample.json',
    name: rules.siteName,
    homepage: BASE,
    urls: [BASE],
    enabled: true,
    sourceType: 'novel',
    tags: [],
    minDelayMs: 0,
    requireUrls: [],
    headers: {},
    rules: {
      searchPath: '/search?keyword={keyword}',
      searchItemPattern: DEFAULT_PATTERNS.searchItemPattern,
      bookTitlePattern: DEFAULT_PATTERNS.bookTitlePattern,
      bookAuthorPattern: DEFAULT_PATTERNS.bookAuthorPattern,
      chapterItemPattern: DEFAULT_PATTERNS.chapterItemPattern,
      contentPattern: DEFAULT_PATTERNS.contentPattern,
      ...rules,
    },
  };
}

// ── 样本 HTML ────────────────────────────────────────────────────────────────

/** CSS 搜索页：书 5 有两个同 href 锚点（img + 书名），应收敛为一条 */
const CSS_SEARCH_HTML =
  '<dl class="list"><dd>' +
  '<a href="/book/5/index.html"><img src="c5.jpg"></a>' +
  '<h4><a href="/book/5/index.html">庆余年</a></h4>' +
  '<span class="author">猫腻</span><span class="kind">东方玄幻</span>' +
  '</dd><dd>' +
  '<h4><a href="/book/6/index.html">将夜</a></h4>' +
  '<span class="author">猫腻二</span>' +
  '</dd></dl>';

const CSS_DETAIL_HTML =
  '<h1 class="title">庆余年</h1><span class="author">猫腻</span>' +
  '<span class="cat">玄幻</span><img class="cover" src="/covers/5.jpg">' +
  '<ul class="toc"><li><a href="/book/5/1.html">第一章 起</a></li>' +
  '<li><a href="/book/5/2.html">第二章 承</a></li></ul>';

const CSS_CONTENT_HTML = '<div id="content"><p>第一段</p><p>第二段&nbsp;空</p></div>';

const REGEX_SEARCH_HTML =
  '<a href="/book/1.html">书甲乙丙</a> 作者：张三<br>' +
  '<a href="/book/2.html">书丁戊己</a> 作者：李四<br>';

const REGEX_DETAIL_HTML =
  '<h1>庆余年</h1>作者：猫腻<br>分类：玄幻<br><img src="c.jpg">' +
  '<a href="/book/5/1.html">第一章 起</a><a href="/book/5/2.html">第二章 承</a>';

const REGEX_CONTENT_HTML = '<div id="content"><p>正文甲</p><br>正文乙</div>';

const SEARCH_URL = `${BASE}/search?keyword=%E5%BA%86%E4%BD%99%E5%B9%B4`;
const BOOK_URL = `${BASE}/book/5/index.html`;
const CHAPTER_URL = `${BASE}/book/5/1.html`;

// ── CSS 模式 ─────────────────────────────────────────────────────────────────

describe('JsonRuleEngine — CSS 模式', () => {
  afterEach(() => localStorage.removeItem('pom.cssRules'));

  const cssRules: Partial<SourceRules> & Pick<SourceRules, 'siteName'> = {
    siteName: '样例站',
    searchPath: '/search?keyword={keyword}',
    searchItemPattern: 'dl.list dd',
    searchAuthorPattern: '.author',
    searchCategoryPattern: '.kind',
    bookTitlePattern: 'h1.title',
    bookAuthorPattern: 'span.author',
    bookCategoryPattern: 'span.cat',
    coverUrlPattern: 'img.cover',
    chapterItemPattern: 'ul.toc a',
    contentPattern: 'div#content',
  };

  function cssEngine() {
    const http = new FakeHttp({
      [SEARCH_URL]: CSS_SEARCH_HTML,
      [BOOK_URL]: CSS_DETAIL_HTML,
      [CHAPTER_URL]: CSS_CONTENT_HTML,
    });
    return { http, engine: new JsonRuleEngine(http) };
  }

  it('search：全字段 + 同 URL 锚点收敛 + author/kind 增强', async () => {
    const { http, engine } = cssEngine();
    const res = await engine.search(makeDoc(cssRules), '庆余年', 1);
    expect(res).toEqual([
      {
        name: '庆余年',
        author: '猫腻',
        kind: '东方玄幻',
        bookUrl: `${BASE}/book/5/index.html`,
      },
      { name: '将夜', author: '猫腻二', kind: '', bookUrl: `${BASE}/book/6/index.html` },
    ]);
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0].method).toBe('GET');
    expect(http.calls[0].url).toBe(SEARCH_URL);
  });

  it('bookInfo：全字段 + cover 过 absUrl + chapters 复抓详情页（模板语义）', async () => {
    const { http, engine } = cssEngine();
    const info = await engine.bookInfo(makeDoc(cssRules), BOOK_URL);
    expect(info).toEqual({
      title: '庆余年',
      author: '猫腻',
      category: '玄幻',
      cover: `${BASE}/covers/5.jpg`,
      chapters: [
        { name: '第一章 起', url: `${BASE}/book/5/1.html` },
        { name: '第二章 承', url: `${BASE}/book/5/2.html` },
      ],
    });
    // 模板 bookInfo 内部再调 chapterList(bookUrl) 复抓一次 → 两次 GET 同一 URL
    expect(http.calls.map((c) => c.url)).toEqual([BOOK_URL, BOOK_URL]);
  });

  it('chapterList：CSS 锚点提取并绝对化', async () => {
    const { engine } = cssEngine();
    const chapters = await engine.chapterList(makeDoc(cssRules), BOOK_URL);
    expect(chapters).toEqual([
      { name: '第一章 起', url: `${BASE}/book/5/1.html` },
      { name: '第二章 承', url: `${BASE}/book/5/2.html` },
    ]);
  });

  it('chapterContent：innerHTML → stripTags → contentReplaceRules 顺序净化（非法正则跳过）', async () => {
    const { engine } = cssEngine();
    const doc = makeDoc({
      ...cssRules,
      contentReplaceRules: [
        { rule: '第二段', replace: '第贰段' },
        { rule: '([', replace: '不应生效' }, // 非法正则跳过，不中断后续规则
        { rule: '空', replace: '' },
      ],
    });
    const text = await engine.chapterContent(doc, CHAPTER_URL);
    expect(text).toBe('第一段\n第贰段 ');
  });
});

// ── 正则模式 ─────────────────────────────────────────────────────────────────

describe('JsonRuleEngine — 正则模式', () => {
  afterEach(() => localStorage.removeItem('pom.cssRules'));

  const regexRules: Partial<SourceRules> & Pick<SourceRules, 'siteName'> = {
    siteName: '样例站',
    searchPath: '/search?keyword={keyword}',
    searchItemPattern: DEFAULT_PATTERNS.searchItemPattern,
    searchAuthorPattern: '作者[：:]\\s*([^<]{1,30})',
    bookCategoryPattern: DEFAULT_PATTERNS.bookCategoryPattern,
    coverUrlPattern: '<img[^>]+src="([^"]+)"',
  };

  function regexEngine() {
    const http = new FakeHttp({
      [SEARCH_URL]: REGEX_SEARCH_HTML,
      [BOOK_URL]: REGEX_DETAIL_HTML,
      [CHAPTER_URL]: REGEX_CONTENT_HTML,
    });
    return { http, engine: new JsonRuleEngine(http) };
  }

  it('search：组 1=URL 组 2=书名不去重；作者增强规则作用于条目作用域', async () => {
    const { engine } = regexEngine();
    const res = await engine.search(makeDoc(regexRules), '庆余年', 1);
    expect(res).toEqual([
      { name: '书甲乙丙', author: '张三', kind: '', bookUrl: `${BASE}/book/1.html` },
      { name: '书丁戊己', author: '李四', kind: '', bookUrl: `${BASE}/book/2.html` },
    ]);
  });

  it('search：增强规则未配置 → author/kind 恒为空串', async () => {
    const { engine } = regexEngine();
    const rules = { ...regexRules };
    delete rules.searchAuthorPattern;
    const res = await engine.search(makeDoc(rules), '庆余年', 1);
    expect(res[0]).toEqual({
      name: '书甲乙丙',
      author: '',
      kind: '',
      bookUrl: `${BASE}/book/1.html`,
    });
  });

  it('search：增强规则配置但未命中 → 该字段空串', async () => {
    const { engine } = regexEngine();
    const res = await engine.search(
      makeDoc({ ...regexRules, searchAuthorPattern: '作家[：:]\\s*([^<]{1,30})' }),
      '庆余年',
      1,
    );
    expect(res[0].author).toBe('');
  });

  it('bookInfo：正则全字段（F6：extractText 正则分支剥标签）', async () => {
    const { engine } = regexEngine();
    const info = await engine.bookInfo(makeDoc(regexRules), BOOK_URL);
    expect(info).toEqual({
      title: '庆余年',
      author: '猫腻',
      category: '玄幻',
      cover: `${BASE}/book/5/c.jpg`,
      chapters: [
        { name: '第一章 起', url: `${BASE}/book/5/1.html` },
        { name: '第二章 承', url: `${BASE}/book/5/2.html` },
      ],
    });
  });

  it('chapterContent：正则取 m[1] 原文后 stripTags（标题/正文标签剥离一致）', async () => {
    const { engine } = regexEngine();
    const text = await engine.chapterContent(makeDoc(regexRules), CHAPTER_URL);
    expect(text).toBe('正文甲\n\n正文乙');
  });

  it('F6 回归：含标签的单值文本提取必须剥标签（不得复用不剥标签的 pickText 正则分支）', async () => {
    const http = new FakeHttp({ [BOOK_URL]: '<h1>庆<b>余</b>年</h1>' });
    const engine = new JsonRuleEngine(http);
    const doc = makeDoc({
      siteName: '样例站',
      bookTitlePattern: '<h1[^>]*>([\\s\\S]*?)</h1>',
    });
    // 模板 extractText 正则分支 stripTags(m[1]) → '庆余年'；若误用 pickText 会得到 '庆<b>余</b>年'
    const info = await engine.bookInfo(doc, BOOK_URL);
    expect(info.title).toBe('庆余年');
  });
});

// ── 搜索请求形态 ─────────────────────────────────────────────────────────────

describe('JsonRuleEngine — 搜索请求形态', () => {
  afterEach(() => localStorage.removeItem('pom.cssRules'));

  it('GET：{keyword} encodeURIComponent、{page} 原样替换', async () => {
    const url = `${BASE}/search?kw=%E5%BA%86%E4%BD%99%E5%B9%B4&page=2`;
    const http = new FakeHttp({ [url]: REGEX_SEARCH_HTML });
    const engine = new JsonRuleEngine(http);
    await engine.search(
      makeDoc({ siteName: '样例站', searchPath: '/search?kw={keyword}&page={page}' }),
      '庆余年',
      2,
    );
    expect(http.calls[0]).toMatchObject({ method: 'GET', url });
  });

  it('POST：buildFormBody 拼 form-urlencoded，缺省 Content-Type', async () => {
    const url = `${BASE}/search`;
    const http = new FakeHttp({ [url]: REGEX_SEARCH_HTML });
    const engine = new JsonRuleEngine(http);
    const res = await engine.search(
      makeDoc({
        siteName: '样例站',
        searchPath: '/search',
        searchMethod: 'POST',
        searchBodyParams: [
          { key: 'q', value: '{keyword}' },
          { key: 'p', value: '{page}' },
        ],
      }),
      '庆余年',
      2,
    );
    expect(http.calls[0]).toMatchObject({
      method: 'POST',
      url,
      body: 'q=%E5%BA%86%E4%BD%99%E5%B9%B4&p=2',
    });
    expect(http.calls[0].headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(res).toHaveLength(2);
  });

  it('POST：自定义 searchContentType 合并进 headers（Object.assign 语义，覆盖同名键）', async () => {
    const url = `${BASE}/search`;
    const http = new FakeHttp({ [url]: REGEX_SEARCH_HTML });
    const engine = new JsonRuleEngine(http);
    const doc = makeDoc({
      siteName: '样例站',
      searchPath: '/search',
      searchMethod: 'POST',
      searchBodyParams: [{ key: 'q', value: '{keyword}' }],
      searchContentType: 'application/x-www-form-urlencoded; charset=utf-8',
    });
    doc.headers = { 'X-Token': 't1', 'Content-Type': 'should-be-overridden' };
    await engine.search(doc, '庆余年', 1);
    expect(http.calls[0].headers).toEqual({
      'X-Token': 't1',
      'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
    });
  });

  it('POST_RAW：body 原文替换（keyword 不 encode），缺省 Content-Type=application/json', async () => {
    const url = `${BASE}/api/search`;
    const http = new FakeHttp({ [url]: REGEX_SEARCH_HTML });
    const engine = new JsonRuleEngine(http);
    await engine.search(
      makeDoc({
        siteName: '样例站',
        searchPath: '/api/search',
        searchMethod: 'POST_RAW',
        searchRawBody: '{"q":"{keyword}","p":{page}}',
      }),
      '庆余年',
      1,
    );
    expect(http.calls[0]).toMatchObject({
      method: 'POST',
      url,
      body: '{"q":"庆余年","p":1}',
    });
    expect(http.calls[0].headers['Content-Type']).toBe('application/json');
  });

  it('POST_RAW：自定义 searchContentType 生效', async () => {
    const url = `${BASE}/api/search`;
    const http = new FakeHttp({ [url]: REGEX_SEARCH_HTML });
    const engine = new JsonRuleEngine(http);
    await engine.search(
      makeDoc({
        siteName: '样例站',
        searchPath: '/api/search',
        searchMethod: 'POST_RAW',
        searchContentType: 'text/xml',
        searchRawBody: '<q>{keyword}</q>',
      }),
      '庆余年',
      1,
    );
    expect(http.calls[0].headers['Content-Type']).toBe('text/xml');
  });
});

// ── cssRules 止血门（F6c） ───────────────────────────────────────────────────

describe('JsonRuleEngine — cssRules=0 止血门（与沙箱同一文案）', () => {
  afterEach(() => localStorage.removeItem('pom.cssRules'));

  it('CSS 条目规则在 flag=0 时响亮失败（文案 = sandbox.service.ts:677）', async () => {
    localStorage.setItem('pom.cssRules', '0');
    const http = new FakeHttp({ [SEARCH_URL]: CSS_SEARCH_HTML });
    const engine = new JsonRuleEngine(http);
    await expect(
      engine.search(makeDoc({ siteName: '样例站', searchItemPattern: 'dl.list dd' }), '庆余年', 1),
    ).rejects.toThrow(CSS_RULES_DISABLED_MESSAGE);
    expect(CSS_RULES_DISABLED_MESSAGE).toBe('CSS 规则已禁用（localStorage pom.cssRules=0）');
  });

  it('CSS 单值规则（bookInfo）在 flag=0 时同样失败', async () => {
    localStorage.setItem('pom.cssRules', '0');
    const http = new FakeHttp({ [BOOK_URL]: CSS_DETAIL_HTML });
    const engine = new JsonRuleEngine(http);
    await expect(
      engine.bookInfo(makeDoc({ siteName: '样例站', bookTitlePattern: 'h1.title' }), BOOK_URL),
    ).rejects.toThrow(CSS_RULES_DISABLED_MESSAGE);
  });

  it('CSS 增强规则（条目规则为正则）在 flag=0 时也失败 —— 每条 CSS 路径都过门', async () => {
    localStorage.setItem('pom.cssRules', '0');
    const http = new FakeHttp({ [SEARCH_URL]: REGEX_SEARCH_HTML });
    const engine = new JsonRuleEngine(http);
    await expect(
      engine.search(
        makeDoc({
          siteName: '样例站',
          searchItemPattern: DEFAULT_PATTERNS.searchItemPattern,
          searchAuthorPattern: '.author',
        }),
        '庆余年',
        1,
      ),
    ).rejects.toThrow(CSS_RULES_DISABLED_MESSAGE);
  });

  it('flag=0 时纯正则规则不受影响', async () => {
    localStorage.setItem('pom.cssRules', '0');
    const http = new FakeHttp({ [SEARCH_URL]: REGEX_SEARCH_HTML });
    const engine = new JsonRuleEngine(http);
    const res = await engine.search(makeDoc({ siteName: '样例站' }), '庆余年', 1);
    expect(res).toHaveLength(2);
    expect(res[0].name).toBe('书甲乙丙');
  });
});

// ── guard 集成（引擎层生效） ─────────────────────────────────────────────────

describe('JsonRuleEngine — guard 集成', () => {
  afterEach(() => localStorage.removeItem('pom.cssRules'));

  it('搜索结果裁剪到 100 条（101 条 → 100）', async () => {
    const many = Array.from(
      { length: 101 },
      (_, i) => `<a href="/b/${i}.html">书名${i}号</a>`,
    ).join('');
    const http = new FakeHttp({ [SEARCH_URL]: many });
    const engine = new JsonRuleEngine(http);
    const res = await engine.search(makeDoc({ siteName: '样例站' }), '庆余年', 1);
    expect(res).toHaveLength(100);
  });

  it('HTML 超过 5MB 在进入提取前拒绝', async () => {
    const http = new FakeHttp({ [SEARCH_URL]: 'x'.repeat(HTML_MAX_LENGTH + 1) });
    const engine = new JsonRuleEngine(http);
    await expect(engine.search(makeDoc({ siteName: '样例站' }), '庆余年', 1)).rejects.toThrow(
      'HTML 超过 5MB 解析上限',
    );
  });

  it('超长规则串拒绝（报错含字段名）', async () => {
    const http = new FakeHttp({});
    const engine = new JsonRuleEngine(http);
    await expect(
      engine.search(
        makeDoc({ siteName: '样例站', searchItemPattern: `a{${'b'.repeat(600)}}` }),
        '庆余年',
        1,
      ),
    ).rejects.toThrow(/searchItemPattern/);
  });

  it('嵌套量词正则拒绝（灾难性回溯）', async () => {
    const http = new FakeHttp({});
    const engine = new JsonRuleEngine(http);
    await expect(
      engine.search(makeDoc({ siteName: '样例站', searchItemPattern: '(a+)+' }), '庆余年', 1),
    ).rejects.toThrow(/灾难性回溯/);
  });

  it('单次入口执行预算：http 不返回时按 budgetMs 超时（fake timers，不真等）', async () => {
    vi.useFakeTimers();
    try {
      const pending: RuleEngineHttp = {
        get: () => new Promise<string>(() => {}),
        post: () => new Promise<string>(() => {}),
      };
      const engine = new JsonRuleEngine(pending, { budgetMs: 1000 });
      const p = engine.search(makeDoc({ siteName: '样例站' }), '庆余年', 1);
      const assertion = expect(p).rejects.toThrow(/超过 1s 预算/);
      await vi.advanceTimersByTimeAsync(1000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── RuleTrace ────────────────────────────────────────────────────────────────

describe('JsonRuleEngine — RuleTrace', () => {
  afterEach(() => localStorage.removeItem('pom.cssRules'));

  it('search 成功：http → extract → done，带 URL/条数/耗时', async () => {
    const http = new FakeHttp({ [SEARCH_URL]: REGEX_SEARCH_HTML });
    const engine = new JsonRuleEngine(http);
    const traces: RuleTrace[] = [];
    await engine.search(makeDoc({ siteName: '样例站' }), '庆余年', 1, (t) => traces.push(t));
    expect(traces.map((t) => t.stage)).toEqual(['http', 'extract', 'done']);
    expect(traces[0]).toMatchObject({ phase: 'search', method: 'GET', url: SEARCH_URL });
    expect(traces[1]).toMatchObject({
      phase: 'search',
      ruleField: 'searchItemPattern',
      itemCount: 2,
    });
    expect(traces[2].error).toBeUndefined();
  });

  it('bookInfo：两次 http trace（详情页复抓）+ 失败时 done 带 error', async () => {
    const http = new FakeHttp({ [BOOK_URL]: REGEX_DETAIL_HTML });
    const engine = new JsonRuleEngine(http);
    const ok: RuleTrace[] = [];
    await engine.bookInfo(makeDoc({ siteName: '样例站' }), BOOK_URL, (t) => ok.push(t));
    expect(ok.filter((t) => t.stage === 'http')).toHaveLength(2);

    const failing = new FakeHttp({});
    const engine2 = new JsonRuleEngine({
      get: () => Promise.reject(new Error('网络失败')),
      post: () => Promise.reject(new Error('网络失败')),
    });
    void failing;
    const traces: RuleTrace[] = [];
    await expect(
      engine2.chapterList(makeDoc({ siteName: '样例站' }), BOOK_URL, (t) => traces.push(t)),
    ).rejects.toThrow('网络失败');
    const done = traces.find((t) => t.stage === 'done');
    expect(done?.error).toBe('网络失败');
  });
});

// ── 与模板的等价性（generateSourceCode 对照，3 组） ──────────────────────────

/** 编译模板代码并注入 mock legado（query 语义照抄 sandbox.service.ts toQueryItem/proxyQuery） */
function compileTemplate(code: string, routes: Record<string, string>) {
  const legado = {
    http: {
      get: async (url: string) => routes[url] ?? '',
      post: async (url: string) => routes[url] ?? '',
    },
    query: async (html: string, selector: string, baseUrl: string) => {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const abs = (h: string | null): string => {
        if (!h) return '';
        try {
          return new URL(h, baseUrl).href;
        } catch {
          return '';
        }
      };
      return Array.from(doc.querySelectorAll(selector)).map((el) => {
        const isA = el.tagName === 'A';
        const anchors = isA ? [el] : Array.from(el.querySelectorAll('a[href]'));
        const attrs: Record<string, string> = {};
        for (const a of Array.from(el.attributes)) attrs[a.name.toLowerCase()] = a.value;
        return {
          tag: el.tagName.toLowerCase(),
          text: (el.textContent ?? '').trim(),
          html: el.innerHTML,
          href: isA ? abs(el.getAttribute('href')) : '',
          links: anchors
            .map((a) => ({ href: abs(a.getAttribute('href')), text: (a.textContent ?? '').trim() }))
            .filter((l) => l.href),
          attrs,
        };
      });
    },
  };
  const factory = new Function(
    'legado',
    `${code}\n;return { search, bookInfo, chapterList, chapterContent };`,
  );
  return factory(legado) as {
    search: (k: string, p: number) => Promise<unknown>;
    bookInfo: (u: string) => Promise<unknown>;
    chapterList: (u: string) => Promise<unknown>;
    chapterContent: (u: string) => Promise<unknown>;
  };
}

describe('JsonRuleEngine — 与 generateSourceCode 模板等价', () => {
  afterEach(() => localStorage.removeItem('pom.cssRules'));

  it('① 正则 search（含作者增强）输出与模板逐字段一致', async () => {
    const rules: SourceRules = {
      siteName: '样例站',
      searchPath: '/search?keyword={keyword}',
      searchItemPattern: DEFAULT_PATTERNS.searchItemPattern,
      searchAuthorPattern: '作者[：:]\\s*([^<]{1,30})',
      bookTitlePattern: DEFAULT_PATTERNS.bookTitlePattern,
      bookAuthorPattern: DEFAULT_PATTERNS.bookAuthorPattern,
      chapterItemPattern: DEFAULT_PATTERNS.chapterItemPattern,
      contentPattern: DEFAULT_PATTERNS.contentPattern,
    };
    const routes = { [SEARCH_URL]: REGEX_SEARCH_HTML };
    const mod = compileTemplate(generateSourceCode(BASE, rules), routes);
    const engine = new JsonRuleEngine(new FakeHttp(routes));
    const [jsOut, tsOut] = await Promise.all([
      mod.search('庆余年', 1),
      engine.search(makeDoc(rules), '庆余年', 1),
    ]);
    expect(tsOut).toEqual(jsOut);
  });

  it('② CSS bookInfo（含 cover absUrl、章节复抓）输出与模板逐字段一致', async () => {
    const rules: SourceRules = {
      siteName: '样例站',
      searchPath: '/search?keyword={keyword}',
      searchItemPattern: 'dl.list dd',
      bookTitlePattern: 'h1.title',
      bookAuthorPattern: 'span.author',
      bookCategoryPattern: 'span.cat',
      coverUrlPattern: 'img.cover',
      chapterItemPattern: 'ul.toc a',
      contentPattern: 'div#content',
    };
    const routes = { [BOOK_URL]: CSS_DETAIL_HTML };
    const mod = compileTemplate(generateSourceCode(BASE, rules), routes);
    const engine = new JsonRuleEngine(new FakeHttp(routes));
    const [jsOut, tsOut] = await Promise.all([
      mod.bookInfo(BOOK_URL),
      engine.bookInfo(makeDoc(rules), BOOK_URL),
    ]);
    expect(tsOut).toEqual(jsOut);
  });

  it('③ 正则 chapterContent（含净化规则顺序）输出与模板一致', async () => {
    const rules: SourceRules = {
      siteName: '样例站',
      searchPath: '/search?keyword={keyword}',
      searchItemPattern: DEFAULT_PATTERNS.searchItemPattern,
      bookTitlePattern: DEFAULT_PATTERNS.bookTitlePattern,
      bookAuthorPattern: DEFAULT_PATTERNS.bookAuthorPattern,
      chapterItemPattern: DEFAULT_PATTERNS.chapterItemPattern,
      contentPattern: DEFAULT_PATTERNS.contentPattern,
      contentReplaceRules: [
        { rule: '正文甲', replace: '正文一' },
        { rule: '<[^>]+>', replace: '' },
      ],
    };
    const routes = { [CHAPTER_URL]: REGEX_CONTENT_HTML };
    const mod = compileTemplate(generateSourceCode(BASE, rules), routes);
    const engine = new JsonRuleEngine(new FakeHttp(routes));
    const [jsOut, tsOut] = await Promise.all([
      mod.chapterContent(CHAPTER_URL),
      engine.chapterContent(makeDoc(rules), CHAPTER_URL),
    ]);
    expect(tsOut).toEqual(jsOut);
    expect(tsOut).toBe('正文一\n\n正文乙');
  });
});
