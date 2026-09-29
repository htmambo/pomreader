/**
 * 差分测试（书源 JSON 规则化 P1.8 —— **P1 的合入门禁**）
 *
 * 同一个存量 JS 书源，分别喂给：
 *   ① 旧 JS 引擎（真实 `new Function` 隔离执行 + 真实 DOMParser，见 `legacy-runner.ts`）
 *   ② 新规则引擎（`createRuleEngine`，纯 TS，主线程）
 * 断言**四入口输出逐字段一致**，失败即打印字段级 diff（`toEqual` 自带）。
 *
 * ## 关键：规则来源闭环，无自证
 *
 * 新引擎吃的 `rules` 是 `parseJsSource(同一份 JS 源码)` 的产物 —— 即**由那份真实存量源码解析
 * 出来的规则**。所以这里比的不是"两份各自写的实现"，而是"同一份输入经两条链路是否等价"：
 * 解析器的 bug 会在两侧同时体现，差分仍然有效；而引擎的行为差异必然暴露。
 *
 * ## 失败也要比对
 *
 * 两侧都包成 `{ok,value} | {ok,error}` 再比较。方案的核心诉求是"把响亮失败换成静默错结果"，
 * 若只比成功值，"旧引擎报错、新引擎返回空"这种最危险的漂移会漏掉。
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  callLegacy,
  compileLegacySource,
  makeSampleJsSource,
  makeSamplePostSource,
  SAMPLE_HTML,
  type FixtureMap,
  type HttpFixture,
} from './legacy-runner';
import { createRuleEngine, type EngineHttpRequest } from '../engine';
import { parseJsSource } from '../../../logic/rule-parse';

const BASE = 'https://example.com';
const GET_SEARCH_URL = `${BASE}/search?q=${encodeURIComponent('测试')}&page=1`;
const POST_SEARCH_URL = `${BASE}/search`;
const DETAIL_URL = `${BASE}/book/1`;
const CHAPTER_URL = `${BASE}/chapter/1`;

/** 未登记 URL 直接抛错：绝不让"引擎请求了没准备的地址"伪装成"两边都是空结果" */
const FIXTURES: FixtureMap = {
  [GET_SEARCH_URL]: { body: SAMPLE_HTML.search },
  [POST_SEARCH_URL]: { body: SAMPLE_HTML.search },
  [DETAIL_URL]: { body: SAMPLE_HTML.detail },
  [CHAPTER_URL]: { body: SAMPLE_HTML.chapter },
};

/** 新引擎侧 HTTP：与基座同源的 fixture 策略 */
const makeHttp = (map: FixtureMap = FIXTURES) => {
  const seen: EngineHttpRequest[] = [];
  const http = async (req: EngineHttpRequest): Promise<{ status: number; body: string }> => {
    seen.push(req);
    const f: HttpFixture | undefined = map[req.url];
    if (!f) throw new Error(`差分基座：URL 未登记 fixture → ${req.url}`);
    return { status: f.status ?? 200, body: f.body };
  };
  return { http, seen };
};

/** 统一包络，两侧同一套调用约定 */
async function callEngine<T>(
  rules: Parameters<typeof createRuleEngine>[0]['rules'],
  entry: 'search' | 'bookInfo' | 'chapterList' | 'chapterContent',
  args: unknown[],
  map: FixtureMap = FIXTURES,
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  const { http } = makeHttp(map);
  const engine = createRuleEngine({ rules, homepage: BASE, http });
  const fn = engine[entry] as (...a: unknown[]) => Promise<T>;
  try {
    return { ok: true, value: await fn(...args) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

afterEach(() => localStorage.removeItem('pom.cssRules'));

describe('差分：GET 形态（四入口逐字段一致）', () => {
  const source = makeSampleJsSource();
  const { rules, headers, baseUrl } = parseJsSource(source);
  const legacy = compileLegacySource(source, FIXTURES);

  it('前置：解析器确实还原了这份源码的规则，且首页一致', () => {
    expect(baseUrl).toBe(BASE);
    expect(rules.searchMethod).toBe('GET');
    expect(headers).toEqual({});
  });

  it('search', async () => {
    const [a, b] = await Promise.all([
      callLegacy<unknown>(legacy, 'search', ['测试', 1]),
      callEngine<unknown>(rules, 'search', ['测试', 1]),
    ]);
    expect(b).toEqual(a);
  });

  it('bookInfo —— 含**正则分支剥标签**这条不等价点（标题含 <em>）', async () => {
    const [a, b] = await Promise.all([
      callLegacy<unknown>(legacy, 'bookInfo', [DETAIL_URL]),
      callEngine<unknown>(rules, 'bookInfo', [DETAIL_URL]),
    ]);
    expect(b).toEqual(a);
    // 显式钉住这条语义：模板正则分支剥标签，若引擎照搬 pickText 就会带 <em> 进来
    if (a.ok) expect((a.value as { title: string }).title).toBe('示例书一');
  });

  it('chapterList', async () => {
    const [a, b] = await Promise.all([
      callLegacy<unknown>(legacy, 'chapterList', [DETAIL_URL]),
      callEngine<unknown>(rules, 'chapterList', [DETAIL_URL]),
    ]);
    expect(b).toEqual(a);
  });

  it('chapterContent —— 含正文净化规则', async () => {
    const [a, b] = await Promise.all([
      callLegacy<unknown>(legacy, 'chapterContent', [CHAPTER_URL]),
      callEngine<unknown>(rules, 'chapterContent', [CHAPTER_URL]),
    ]);
    expect(b).toEqual(a);
  });
});

describe('差分：POST 形态', () => {
  const source = makeSamplePostSource();
  const { rules } = parseJsSource(source);
  const legacy = compileLegacySource(source, FIXTURES);

  it('search（POST + body params + Content-Type）', async () => {
    const [a, b] = await Promise.all([
      callLegacy<unknown>(legacy, 'search', ['测试', 1]),
      callEngine<unknown>(rules, 'search', ['测试', 1]),
    ]);
    expect(b).toEqual(a);
  });

  it('请求本身也一致：方法 / 头 / body', async () => {
    const { http, seen } = makeHttp();
    const engine = createRuleEngine({ rules, homepage: BASE, http });
    await engine.search('测试', 1);
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe(POST_SEARCH_URL);
    expect(seen[0].method).toBe('POST');
    expect(seen[0].headers?.['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(seen[0].body).toBe('type=articlename&kw=%E6%B5%8B%E8%AF%95&page=1');
  });
});

describe('差分：失败路径同样必须一致（响亮失败不许退化成静默错）', () => {
  it('空选择器：两侧都失败且报错文案相同', async () => {
    const emptySource =
      'async function bookInfo(u){ const h = await legado.http.get(u); return await legado.query(h, "", u); }';
    const legacy = compileLegacySource(emptySource, FIXTURES);
    const [a, b] = await Promise.all([
      callLegacy<unknown>(legacy, 'bookInfo', [DETAIL_URL]),
      callEngine<unknown>(
        { ...parseJsSource(makeSampleJsSource()).rules, bookTitlePattern: '' },
        'bookInfo',
        [DETAIL_URL],
      ),
    ]);
    expect(b).toEqual(a);
    expect(b.ok).toBe(false);
  });

  it('URL 未登记 fixture：两侧都失败', async () => {
    const src = 'async function chapterContent(u){ return await legado.http.get(u); }';
    const legacy = compileLegacySource(src, FIXTURES);
    const { rules } = parseJsSource(makeSampleJsSource());
    const [a, b] = await Promise.all([
      callLegacy<unknown>(legacy, 'chapterContent', ['https://example.com/never-registered']),
      callEngine<unknown>(rules, 'chapterContent', ['https://example.com/never-registered']),
    ]);
    expect(b).toEqual(a);
    expect(b.ok).toBe(false);
  });

  it('HTTP 5xx：两侧都失败且文案相同（`HTTP <status>`，不拿错误页当正文解析）', async () => {
    const errUrl = 'https://example.com/boom';
    const errFixtures: FixtureMap = {
      ...FIXTURES,
      [errUrl]: { status: 503, body: '<html><body>服务不可用</body></html>' },
    };
    const src = 'async function chapterContent(u){ return await legado.http.get(u); }';
    const legacy = compileLegacySource(src, errFixtures);
    const { rules } = parseJsSource(makeSampleJsSource());
    const [a, b] = await Promise.all([
      callLegacy<unknown>(legacy, 'chapterContent', [errUrl]),
      callEngine<unknown>(rules, 'chapterContent', [errUrl], errFixtures),
    ]);
    expect(b).toEqual(a);
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.error).toBe('HTTP 503');
  });

  it('HTTP 3xx/4xx 同样不被当成功：302 一条也没有静默通过', async () => {
    const badUrl = 'https://example.com/redirect';
    const badFixtures: FixtureMap = { ...FIXTURES, [badUrl]: { status: 302, body: '' } };
    const src = 'async function chapterContent(u){ return await legado.http.get(u); }';
    const legacy = compileLegacySource(src, badFixtures);
    const { rules } = parseJsSource(makeSampleJsSource());
    const [a, b] = await Promise.all([
      callLegacy<unknown>(legacy, 'chapterContent', [badUrl]),
      callEngine<unknown>(rules, 'chapterContent', [badUrl], badFixtures),
    ]);
    expect(b.ok).toBe(false);
    expect(b).toEqual(a);
  });
});

describe('差分矩阵：pom.cssRules 止血开关两列（F6c —— 门是现状生产行为）', () => {
  const source = makeSampleJsSource();
  const { rules } = parseJsSource(source);

  it('flag=0：两侧都按同一文案抛错（不是一边报错一边静默解析）', async () => {
    localStorage.setItem('pom.cssRules', '0');
    const legacy = compileLegacySource(source, FIXTURES);
    const [a, b] = await Promise.all([
      callLegacy<unknown>(legacy, 'chapterList', [DETAIL_URL]),
      callEngine<unknown>(rules, 'chapterList', [DETAIL_URL]),
    ]);
    expect(b).toEqual(a);
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.error).toContain('CSS 规则已禁用');
  });

  it('flag 未设置（默认开启）：两侧都正常返回', async () => {
    const legacy = compileLegacySource(source, FIXTURES);
    const [a, b] = await Promise.all([
      callLegacy<unknown>(legacy, 'chapterList', [DETAIL_URL]),
      callEngine<unknown>(rules, 'chapterList', [DETAIL_URL]),
    ]);
    expect(b).toEqual(a);
    expect(b.ok).toBe(true);
  });
});
