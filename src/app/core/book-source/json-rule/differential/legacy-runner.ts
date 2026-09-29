/**
 * 差分测试基座 —— **旧 JS 引擎侧**（书源 JSON 规则化 P1.8）
 *
 * ## 为什么要这个文件
 *
 * P1 的合入门禁是"两引擎四入口输出逐条一致"（方案 §7.1）。要比较就必须让**真实的存量 JS 源码**
 * 真的跑起来。直接起 Worker 需要 postMessage 管道 + 真实网络，既不稳定也无法离线。
 *
 * ## 关键设计：与真实 Worker **同构**，只把网络换成本地 fixture
 *
 * `sandbox.worker.ts:compileModule` 用 `new Function('legado', source + 导出表)` 隔离执行，
 * 并注入 `legado.http.{get,post,request}` 与 `legado.query` 两个能力。本基座**逐字复刻**：
 * 同样的 `new Function` 隔离、同样的导出表、同样的 shim 签名与失败语义（query 失败 → reject，
 * 见 `sandbox.worker.ts:416-420`）。
 *
 * ⚠️ `legado.query` 必须走**真实实现**（`runQuery`，从 `sandbox.service.ts` 提取导出），
 * 不能在这里另写一份 DOM 解析 —— 否则新引擎就是在跟"我自己抄的代码"比，
 * 等于拿自己测自己（方案 §7.1 明确点名了这个陷阱）。唯一被替换的是 HTTP：真实链路走
 * preload 的 `booksourceHttpProxy`，基座改为按 URL 匹配本地 HTML。
 */
import { runQuery } from '../../js-source/sandbox.service';
import { generateSourceCode } from '../../smart-add/smart-rules';
import type { SourceRules } from '../../smart-add/smart-rules';

// ── 契约类型（与 js-source.adapter.ts / sandbox.service.ts 对齐）──

export interface QueryItem {
  tag: string;
  text: string;
  html: string;
  href: string;
  links: { href: string; text: string }[];
  attrs?: Record<string, string>;
}

export interface RawSearchItem {
  name: string;
  author: string;
  kind: string;
  bookUrl: string;
}

export interface BookInfoLike {
  title: string;
  author: string;
  category: string;
  cover: string;
  /** 形态为 `{name,url}`（模板 `extractLinks` 的真实返回，不是 `{title,url}`） */
  chapters: { name: string; url: string }[];
}

/** 基座导出的模块表 —— 与 `sandbox.worker.ts:255-264` 的导出表逐字一致 */
export interface LegacyModule {
  search?: (keyword: string, page: number) => Promise<RawSearchItem[]>;
  bookInfo?: (url: string) => Promise<BookInfoLike>;
  chapterList?: (url: string) => Promise<{ name: string; url: string }[]>;
  chapterContent?: (url: string) => Promise<string>;
}

/** 统一结果包络：失败也参与比对（"响亮失败"与"静默错结果"必须被差分看见） */
export type Diffable<T> = { ok: true; value: T } | { ok: false; error: string };

// ── fixture ──

export interface HttpFixture {
  status?: number;
  headers?: Record<string, string>;
  body: string;
  cfChallenge?: boolean;
}

/** URL → HTML 的本地映射。命中不到时按 `onMissing` 决定行为 */
export type FixtureMap = Record<string, HttpFixture>;

export interface RunOptions {
  /** URL 未命中 fixture 时的行为：throw 让差分立刻暴露"引擎发了我们没准备的请求" */
  onMissing?: 'throw' | 'empty';
}

// ── 编译 ──

/**
 * 导出表 —— 与 `sandbox.worker.ts:255-264` 逐字一致（含骨架源兼容的 toc/content/explore 探测）
 */
const EXPORT_TABLE = `
;return {
  search: typeof search === "function" ? search : undefined,
  bookInfo: typeof bookInfo === "function" ? bookInfo : undefined,
  toc: typeof toc === "function" ? toc : undefined,
  chapterList: typeof chapterList === "function" ? chapterList : undefined,
  content: typeof content === "function" ? content : undefined,
  chapterContent: typeof chapterContent === "function" ? chapterContent : undefined,
  explore: typeof explore === "function" ? explore : undefined
};`;

/** 编译存量 JS 书源。失败（语法错等）以模块缺失 + 错误记录体现，不静默 */
export function compileLegacySource(
  source: string,
  fixtures: FixtureMap,
  options: RunOptions = {},
): LegacyModule {
  const onMissing = options.onMissing ?? 'throw';
  const shim = buildShim(fixtures, onMissing);
  const factory = new Function('legado', `${source}\n${EXPORT_TABLE}`);
  return factory(shim) as LegacyModule;
}

/**
 * legado shim：签名与语义对齐 `sandbox.worker.ts:buildShim`
 *
 * `http` 刻意**声明成具体形状**而不是 `Record<string, (...args: unknown[]) => …>`：
 * 后者要求函数能吃任意入参（逆变），与 `(url: string) => …` 不兼容 —— 正因如此，
 * `sandbox.worker.ts:275` 只好写 `as unknown as (req: unknown) => …` 硬转。
 * 这里给的是测试基座，直接写真实签名，不需要那层逃逸。
 */
interface ShimHttp {
  get: (url: string) => Promise<string>;
  post: (url: string) => Promise<string>;
  request: (request: { url: string }) => Promise<string>;
}

function buildShim(
  fixtures: FixtureMap,
  onMissing: 'throw' | 'empty',
): {
  http: ShimHttp;
  query: (html: string, selector: string, baseUrl: string) => Promise<QueryItem[]>;
} {
  const hit = (url: string): HttpFixture => {
    const f = fixtures[url];
    if (f) return f;
    // URL 精确匹配失败时给一次明确报错，而不是静默返回空 HTML ——
    // 静默会让"引擎请求了 fixture 没覆盖的地址"伪装成"两边都返回空结果"，差分就瞎了
    if (onMissing === 'throw') throw new Error(`差分基座：URL 未登记 fixture → ${url}`);
    return { body: '' };
  };
  return {
    http: {
      get: (url: string) => respond(hit(url)),
      post: (url: string) => respond(hit(url)),
      request: (request: { url: string }) => respond(hit(request.url)),
    },
    // 真实 DOMParser 实现；ok:false 时 reject，与 `sandbox.worker.ts:416-420` 一致
    query: (html: string, selector: string, baseUrl: string) => {
      const r = runQuery(html, selector, baseUrl);
      return r.ok ? Promise.resolve(r.items) : Promise.reject(new Error(r.error));
    },
  };
}

/**
 * 2xx 才 resolve，否则 `reject('HTTP <status>')` —— 逐字对齐 `sandbox.worker.ts:405-409`。
 *
 * 少了这道门，基座对 5xx 仍然"成功返回正文"，于是差分会把"引擎抛错 / 旧引擎不抛"判成漂移，
 * 或者反过来把真实漂移掩盖掉。fixture 里的 `status` 因此不是装饰字段。
 */
function respond(f: HttpFixture): Promise<string> {
  const status = f.status ?? 200;
  if (status >= 200 && status < 300) return Promise.resolve(f.body);
  // ⚠️ 文案逐字对齐规则引擎的 2xx 门（`engine.ts` 的 `HTTP <status>`）：
  // 差分基座的职责就是比对**两侧错误文案是否相同**，往这里"顺手加点信息"
  // （我一度加了 URL）会单边改变可观测行为 —— 那正是 T-18 那 4 处怪癖的同款错误：
  // 一侧"修好"制造漂移。定位靠 fixture 名称，不靠错误串。
  return Promise.reject(new Error(`HTTP ${status}`));
}

// ── 调用（统一包络，供差分比对）──

/** 调用一个入口并把异常收敛为 `{ok:false,error}`；两侧用同一函数，错误语义可比 */
export async function callLegacy<T>(
  module: LegacyModule,
  entry: keyof LegacyModule,
  args: unknown[],
): Promise<Diffable<T>> {
  const fn = module[entry] as ((...a: unknown[]) => Promise<T>) | undefined;
  if (!fn) return { ok: false, error: `旧引擎未导出入口 ${String(entry)}` };
  try {
    return { ok: true, value: await fn(...args) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// ── 脱敏 fixture（AGENTS.md：测试数据一律用中性占位，不得出现真实站点标识）──

/** 覆盖「CSS 单模」形态的样例规则；站点一律 example.com */
export const SAMPLE_RULES_CSS: SourceRules = {
  siteName: '示例站点',
  searchPath: '/search?q={keyword}&page={page}',
  searchMethod: 'GET',
  searchItemPattern: 'ul.result-list li.result-item',
  searchAuthorPattern: 'css:.author',
  searchCategoryPattern: 'css:.kind',
  bookTitlePattern: '<h1[^>]*>([\\s\\S]*?)<\\/h1>',
  bookAuthorPattern: '作者[：:]\\s*(?:<[^>]+>)*([^<]{1,30})',
  chapterItemPattern: 'ul.chapter-list li a',
  contentPattern: 'div#content',
  contentReplaceRules: [{ rule: '一秒记住[\\s\\S]{0,20}', replace: '' }],
  bookCategoryPattern: '分类[：:]\\s*(?:<[^>]+>)*([^<]{1,20})',
  coverUrlPattern: 'css:div.cover img',
};

export const SAMPLE_HTML = {
  search: `<!doctype html><html><body>
<ul class="result-list">
  <li class="result-item"><a href="/book/1">示例书一</a><span class="author">作者甲</span><span class="kind">玄幻</span></li>
  <li class="result-item"><a href="/book/2">示例书二</a><span class="author">作者乙</span><span class="kind">都市</span></li>
</ul>
</body></html>`,
  detail: `<!doctype html><html><body>
<div class="cover"><img src="/cover/1.jpg"></div>
<h1><em>示例书一</em></h1>
<p>作者：作者甲</p>
<p>分类：玄幻</p>
<ul class="chapter-list"><li><a href="/chapter/1">第一章</a></li><li><a href="/chapter/2">第二章</a></li></ul>
</body></html>`,
  chapter: `<!doctype html><html><body>
<div id="content">　　正文第一段，含广告。<br>　　正文第二段。一秒记住本站名，更新快！</div>
</body></html>`,
} as const;

export const SAMPLE_RULES_POST: SourceRules = {
  ...SAMPLE_RULES_CSS,
  searchMethod: 'POST',
  searchPath: '/search',
  searchBodyParams: [
    { key: 'type', value: 'articlename' },
    { key: 'kw', value: '{keyword}' },
    { key: 'page', value: '{page}' },
  ],
  searchContentType: 'application/x-www-form-urlencoded',
};

/** POST 形态的样例源码 */
export function makeSamplePostSource(): string {
  return generateSourceCode('https://example.com', SAMPLE_RULES_POST);
}

/** 生成一份"看起来像存量产物"的 JS 书源（与 P0 实测的 1.1.0 形态同源：少两个可选常量） */
export function makeSampleJsSource(): string {
  const src = generateSourceCode('https://example.com', SAMPLE_RULES_CSS);
  // 去掉两个可选常量，模拟 v1.1.0 之前的模板产物
  return src
    .replace(/^const SEARCH_AUTHOR_RULE = .*$/m, '')
    .replace(/^const SEARCH_CATEGORY_RULE = .*$/m, '');
}
