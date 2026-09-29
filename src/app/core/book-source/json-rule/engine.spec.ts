/**
 * 引擎单测（书源 JSON 规则化 P1.3）
 *
 * 与 `differential/` 的分工：那边是"两引擎同输入比一致"（合入门禁），这边是**逐条钉住
 * 引擎自身的行为契约**——尤其是差分测不到的分支：
 *  ① 差分两侧共享同一实现/同一输入，某些分支在现有 fixture 里走不到（guard 上限、POST_RAW、
 *     文档级 headers 合并、超时预算）；
 *  ② 差分只能证明"两边一样"，不能证明"两边都对"（例如两边都返回空数组时差分是绿的）。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createRuleEngine, type EngineHttpRequest } from './engine';
import { CHAPTER_MAX_ITEMS, CONTENT_MAX_BYTES } from './guard';
import { resolveRuleDefaults } from '../smart-add/smart-rules';
import type { SourceRules } from '../smart-add/smart-rules';

const BASE = 'https://example.com';

const BASE_RULES: SourceRules = resolveRuleDefaults({
  siteName: '示例站点',
  searchPath: '/search?q={keyword}&page={page}',
  searchItemPattern: 'ul.list li',
  bookTitlePattern: 'h1',
  bookAuthorPattern: 'css:.author',
  chapterItemPattern: 'ul.chapter-list a',
  contentPattern: 'div#content',
});

/** 单 URL fixture HTTP：记录请求，便于断言"引擎发了什么" */
function fakeHttp(body: string): {
  http: (req: EngineHttpRequest) => Promise<{ status: number; body: string }>;
  seen: EngineHttpRequest[];
} {
  const seen: EngineHttpRequest[] = [];
  return {
    seen,
    http: async (req) => {
      seen.push(req);
      return { status: 200, body };
    },
  };
}

afterEach(() => localStorage.removeItem('pom.cssRules'));

describe('HTTP 契约：文档级 headers 逐方法下发', () => {
  it('GET 带上文档 headers', async () => {
    const { http, seen } = fakeHttp('<ul class="list"></ul>');
    const engine = createRuleEngine({
      rules: BASE_RULES,
      homepage: BASE,
      headers: { 'X-Token': 'abc' },
      http,
    });
    await engine.search('kw', 1);
    expect(seen[0].method).toBe('GET');
    expect(seen[0].headers).toEqual({ 'X-Token': 'abc' });
  });

  it('POST 的 Content-Type **只来自 searchContentType 规则**，文档 headers 压不住它', async () => {
    // 模板是 `Object.assign({}, HEADERS, { 'Content-Type': SEARCH_CONTENT_TYPE })` ——
    // 规则值在**后**，故覆盖同名文档头。引擎保持同一顺序，不改成"文档头优先"。
    const { http, seen } = fakeHttp('<ul class="list"></ul>');
    const engine = createRuleEngine({
      rules: {
        ...BASE_RULES,
        searchMethod: 'POST',
        searchBodyParams: [{ key: 'kw', value: '{keyword}' }],
        searchContentType: 'application/x-www-form-urlencoded',
      },
      homepage: BASE,
      headers: { 'X-Token': 'abc', 'Content-Type': 'text/plain' },
      http,
    });
    await engine.search('kw', 1);
    expect(seen[0].method).toBe('POST');
    expect(seen[0].headers).toEqual({
      'X-Token': 'abc',
      'Content-Type': 'application/x-www-form-urlencoded',
    });
    expect(seen[0].body).toBe('kw=kw');
  });

  it('POST_RAW：body 原文替换 {keyword}/{page}，**不做 encode**（由用户自管）', async () => {
    const { http, seen } = fakeHttp('<ul class="list"></ul>');
    // ⚠️ resolveRuleDefaults 必须在 searchMethod **定稿之后**调用：它用 `??` 推导 contentType，
    // 若先按 GET 解析过一次，POST_RAW 源会带着 form-urlencoded 的旧值进入引擎（静默漂移）。
    const rules = resolveRuleDefaults({
      ...BASE_RULES,
      searchMethod: 'POST_RAW',
      searchRawBody: '{"q":"{keyword}","p":{page}}',
      searchContentType: undefined,
    });
    const engine = createRuleEngine({ rules, homepage: BASE, http });
    await engine.search('测试', 2);
    expect(seen[0].body).toBe('{"q":"测试","p":2}');
    expect(seen[0].headers?.['Content-Type']).toBe('application/json');
  });

  it('缺 searchContentType 时引擎自身仍按方法兜底（不依赖上游一定过 resolveRuleDefaults）', async () => {
    const { http, seen } = fakeHttp('<ul class="list"></ul>');
    const engine = createRuleEngine({
      // 故意不走 resolveRuleDefaults，模拟"某条构造路径忘了过"
      rules: {
        ...BASE_RULES,
        searchMethod: 'POST_RAW',
        searchRawBody: '{}',
        searchContentType: undefined,
      },
      homepage: BASE,
      http,
    });
    await engine.search('kw', 1);
    expect(seen[0].headers?.['Content-Type']).toBe('application/json');
  });
});

describe('search：条目过滤与增强规则', () => {
  const html = `<ul class="list">
    <li><a href="/book/1">书一</a><span class="author">甲</span></li>
    <li><a href="/book/2">书二</a></li>
    <li><a>无链接不产出</a></li>
  </ul>`;

  it('name/url 任一为空即丢弃该条目', async () => {
    const { http } = fakeHttp(html);
    const engine = createRuleEngine({ rules: BASE_RULES, homepage: BASE, http });
    const items = await engine.search('kw', 1);
    expect(items.map((i) => i.name)).toEqual(['书一', '书二']);
  });

  it('作者/分类规则未配置时恒为空串（老源缺这两个常量是常态，不报错）', async () => {
    const { http } = fakeHttp(html);
    const engine = createRuleEngine({ rules: BASE_RULES, homepage: BASE, http });
    const items = await engine.search('kw', 1);
    expect(items[0].author).toBe('');
    expect(items[0].kind).toBe('');
  });

  it('作者规则作用域是**条目内部**（第一条有甲、第二条无则空），不是整页', async () => {
    const { http } = fakeHttp(html);
    const engine = createRuleEngine({
      rules: { ...BASE_RULES, searchAuthorPattern: 'css:.author' },
      homepage: BASE,
      http,
    });
    const items = await engine.search('kw', 1);
    expect(items[0].author).toBe('甲');
    expect(items[1].author).toBe('');
  });

  it('关键字与页码进 URL，且经 encodeURIComponent', async () => {
    const { http, seen } = fakeHttp(html);
    const engine = createRuleEngine({ rules: BASE_RULES, homepage: BASE, http });
    await engine.search('测试', 3);
    expect(seen[0].url).toBe(`${BASE}/search?q=%E6%B5%8B%E8%AF%95&page=3`);
  });
});

describe('bookInfo', () => {
  const detail = `<h1>示例书</h1><p class="author">作者甲</p>
    <div class="cover"><img src="/cover/a.jpg"></div>
    <ul class="chapter-list"><li><a href="/c/1">第一章</a></li><li><a href="/c/2">第二章</a></li></ul>`;

  it('封面走 absUrl 绝对化（extractAttr 自身不做绝对化）', async () => {
    const { http } = fakeHttp(detail);
    const engine = createRuleEngine({
      rules: { ...BASE_RULES, coverUrlPattern: 'css:.cover img' },
      homepage: BASE,
      http,
    });
    const info = await engine.bookInfo(`${BASE}/book/1`);
    expect(info.cover).toBe(`${BASE}/cover/a.jpg`);
  });

  it('章节走 chapterList，同一 bookUrl 会抓第二次（与模板 bookInfo 一致）', async () => {
    const { http, seen } = fakeHttp(detail);
    const engine = createRuleEngine({ rules: BASE_RULES, homepage: BASE, http });
    const info = await engine.bookInfo(`${BASE}/book/1`);
    expect(info.chapters).toEqual([
      { name: '第一章', url: `${BASE}/c/1` },
      { name: '第二章', url: `${BASE}/c/2` },
    ]);
    expect(seen).toHaveLength(2);
    expect(seen[0].url).toBe(`${BASE}/book/1`);
    expect(seen[1].url).toBe(`${BASE}/book/1`);
  });

  it('标题规则为正则时**剥标签**（与 pickText 的差异点，差分基座也钉了这一条）', async () => {
    const { http } = fakeHttp('<h1><em>带标签标题</em></h1>');
    const engine = createRuleEngine({
      rules: { ...BASE_RULES, bookTitlePattern: '<h1[^>]*>([\\s\\S]*?)<\\/h1>' },
      homepage: BASE,
      http,
    });
    const info = await engine.bookInfo(`${BASE}/book/1`);
    expect(info.title).toBe('带标签标题');
  });
});

describe('guard 上限在引擎层真的生效（不是只定义了常量）', () => {
  /**
   * ⚠️ 章节数真正生效的上限是 **500**（模板常量 `MAX_EXTRACT_LINKS`），不是 guard 表里的
   * `CHAPTER_MAX_ITEMS=20000`：链接提取在 CSS 与正则两个分支都先被 500 截断
   * （`extractLinks` / `matchAll`），20000 那道永远轮不到。
   * 保留 20000 是**冗余兜底**（防御将来调高提取上限时漏掉这道），但它今天不可达 ——
   * 所以这里断言真实行为 500，**不**伪造一个 20000 的用例。
   */
  it('章节数被模板常量 MAX_EXTRACT_LINKS=500 截断（与旧引擎同上限）', async () => {
    const many = Array.from(
      { length: 620 },
      (_, i) => `<li><a href="/c/${i}">第${i}章</a></li>`,
    ).join('');
    const { http } = fakeHttp(`<ul class="chapter-list">${many}</ul>`);
    const engine = createRuleEngine({ rules: BASE_RULES, homepage: BASE, http });
    const list = await engine.chapterList(`${BASE}/book/1`);
    expect(list).toHaveLength(500);
    expect(list[499].url).toBe(`${BASE}/c/499`);
  });

  it('CHAPTER_MAX_ITEMS 今天恒不可达（提取上限 500 < 20000），即它是冗余兜底而非生效门', () => {
    expect(500).toBeLessThan(CHAPTER_MAX_ITEMS);
  });

  it('章节数在上限内不裁（不误伤）', async () => {
    const { http } = fakeHttp('<ul class="chapter-list"><li><a href="/c/1">第一章</a></li></ul>');
    const engine = createRuleEngine({ rules: BASE_RULES, homepage: BASE, http });
    expect(await engine.chapterList(`${BASE}/book/1`)).toHaveLength(1);
  });

  it(`单章正文裁到 ${CONTENT_MAX_BYTES} 字符`, async () => {
    const { http } = fakeHttp(`<div id="content">${'字'.repeat(CONTENT_MAX_BYTES + 100)}</div>`);
    const engine = createRuleEngine({ rules: BASE_RULES, homepage: BASE, http });
    const text = await engine.chapterContent(`${BASE}/c/1`);
    expect(text).toHaveLength(CONTENT_MAX_BYTES);
  });

  it('截断点落在代理对中间时退一格，不留半个 emoji（外部评审 R1）', async () => {
    // 上限 + 1 个 code unit 的 ASCII 占位，再接一个 emoji（高+低代理各 1 个 code unit）
    const filler = 'a'.repeat(CONTENT_MAX_BYTES - 1);
    const { http } = fakeHttp(`<div id="content">${filler}😀</div>`);
    const engine = createRuleEngine({ rules: BASE_RULES, homepage: BASE, http });
    const text = await engine.chapterContent(`${BASE}/c/1`);
    // 切点正好劈在 😀 的高代理上 → 退一格，整对 emoji 都不出现，且无孤立代理
    expect(text).toHaveLength(CONTENT_MAX_BYTES - 1);
    expect(text.endsWith('\ud83d')).toBe(false);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(text)).toBe(false);
  });

  it('正文上限在**净化之后**判定：被删干净的正文不会被误裁', async () => {
    const body = 'x'.repeat(CONTENT_MAX_BYTES + 50) + '广告';
    const { http } = fakeHttp(`<div id="content">${body}</div>`);
    const engine = createRuleEngine({
      rules: { ...BASE_RULES, contentReplaceRules: [{ rule: '广告$', replace: '' }] },
      homepage: BASE,
      http,
    });
    // 净化后 = CONTENT_MAX_BYTES 长度，未超限 → 完整返回
    expect(await engine.chapterContent(`${BASE}/c/1`)).toHaveLength(CONTENT_MAX_BYTES);
  });

  it('规则串超长时 createRuleEngine 直接抛（事前拦，事后无法中断主线程回溯）', () => {
    const { http } = fakeHttp('');
    expect(() =>
      createRuleEngine({
        rules: { ...BASE_RULES, contentPattern: 'a'.repeat(513) },
        homepage: BASE,
        http,
      }),
    ).toThrow(/contentPattern/);
  });

  it('危险正则在 createRuleEngine 阶段就被拦，不等到执行', () => {
    const { http } = fakeHttp('');
    expect(() =>
      createRuleEngine({
        rules: { ...BASE_RULES, chapterItemPattern: '(a|a)+' },
        homepage: BASE,
        http,
      }),
    ).toThrow(/歧义重复/);
  });

  it('**净化规则里的正则同样过守卫**（外部评审 R1：数组字段被 typeof 过滤掉，等于留了条绕过的路）', () => {
    const { http } = fakeHttp('');
    expect(() =>
      createRuleEngine({
        rules: {
          ...BASE_RULES,
          contentReplaceRules: [
            { rule: '正常规则', replace: '' },
            { rule: '(a+)+', replace: '' },
          ],
        },
        homepage: BASE,
        http,
      }),
    ).toThrow(/contentReplaceRules\[1\]/);
  });

  it('净化规则里的超长正则也被拦', () => {
    const { http } = fakeHttp('');
    expect(() =>
      createRuleEngine({
        rules: { ...BASE_RULES, contentReplaceRules: [{ rule: 'a'.repeat(513), replace: '' }] },
        homepage: BASE,
        http,
      }),
    ).toThrow(/contentReplaceRules\[0\]/);
  });

  it('净化规则里的空 rule 不算违规（`applyContentReplaceRules` 本就会跳过它）', () => {
    const { http } = fakeHttp('');
    expect(() =>
      createRuleEngine({
        rules: { ...BASE_RULES, contentReplaceRules: [{ rule: '', replace: 'x' }] },
        homepage: BASE,
        http,
      }),
    ).not.toThrow();
  });

  it('`searchContentType` 不当选择器过 guard（它是 MIME，不是选择器/正则）', () => {
    const { http } = fakeHttp('');
    expect(() =>
      createRuleEngine({
        rules: { ...BASE_RULES, searchContentType: 'application/x-www-form-urlencoded' },
        homepage: BASE,
        http,
      }),
    ).not.toThrow();
  });
});

describe('CSS 规则门（pom.cssRules=0）与上限报错是响亮失败', () => {
  it('flag=0 时 CSS 入口抛错（不是静默按正则解析）', async () => {
    localStorage.setItem('pom.cssRules', '0');
    const { http } = fakeHttp('<ul class="chapter-list"><li><a href="/c/1">第一章</a></li></ul>');
    const engine = createRuleEngine({ rules: BASE_RULES, homepage: BASE, http });
    await expect(engine.chapterList(`${BASE}/book/1`)).rejects.toThrow(/CSS 规则已禁用/);
  });

  it('flag=0 时正则入口照常（门只管 CSS 形态，与现状一致）', async () => {
    localStorage.setItem('pom.cssRules', '0');
    const { http } = fakeHttp('<div id="content">正文内容</div>');
    const engine = createRuleEngine({
      // contentPattern 必须是非 CSS 形态：门是**全局**的，bookInfo 里任一 CSS 查询失败
      // 整个入口就失败（旧引擎同此行为，门不是只作用于"当前这条规则"）
      rules: { ...BASE_RULES, contentPattern: '<div[^>]+id="content"[^>]*>([\\s\\S]*?)<\\/div>' },
      homepage: BASE,
      http,
    });
    expect(await engine.chapterContent(`${BASE}/c/1`)).toBe('正文内容');
  });
});

describe('章节列表去重（CSS 形态按 href 合并，后出现的非空名补位）', () => {
  it('同一 href 出现两次，第一次无文字第二次有 → 补上名字', async () => {
    const { http } = fakeHttp(
      '<ul class="chapter-list"><li><a href="/c/1"></a></li><li><a href="/c/1">第一章</a></li></ul>',
    );
    const engine = createRuleEngine({ rules: BASE_RULES, homepage: BASE, http });
    const list = await engine.chapterList(`${BASE}/book/1`);
    expect(list).toEqual([{ name: '第一章', url: `${BASE}/c/1` }]);
  });
});
