/**
 * crawlPaginatedPages 单元测试（设计 §6 表格第一行全场景）：
 * 固定 HTML 路由表 + 失败表驱动，fetch/sleep/trace 全注入，不走真网络与真时钟。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CONTENT_DEFAULT_MAX_PAGES,
  crawlPaginatedPages,
  TOC_DEFAULT_MAX_PAGES,
  type PaginationTraceEvent,
} from './pagination';
import { CSS_RULES_DISABLED_MESSAGE } from './guard';
import type { PaginationRule } from '../smart-add/smart-rules';

const BASE = 'https://www.sample.com';
const AREA = 'css:.pagination';

/** 页面模板：正文区可有可无，分页区域固定 class=pagination */
function page(areaLinks: string, body = ''): string {
  return `<html><body>${body}<div class="pagination">${areaLinks}</div></body></html>`;
}

interface FakeFetch {
  calls: string[];
  fetchPage: (url: string) => Promise<string>;
}

/** URL → 固定 HTML 的假 fetch；fails 表中的 URL 抛错 */
function fakeFetch(routes: Record<string, string>, fails: Record<string, string> = {}): FakeFetch {
  const calls: string[] = [];
  const fetchPage = async (url: string): Promise<string> => {
    calls.push(url);
    if (url in fails) throw new Error(fails[url]);
    if (!(url in routes)) throw new Error(`未配置路由：${url}`);
    return routes[url];
  };
  return { calls, fetchPage };
}

function crawl(
  startUrl: string,
  fetch: FakeFetch,
  pagination: PaginationRule = { area: AREA },
  extra: {
    events?: PaginationTraceEvent[];
    sleep?: (ms: number) => Promise<void>;
    minDelayMs?: number;
    defaultMaxPages?: number;
  } = {},
) {
  return crawlPaginatedPages(startUrl, pagination, {
    fetchPage: fetch.fetchPage,
    defaultMaxPages: extra.defaultMaxPages ?? TOC_DEFAULT_MAX_PAGES,
    minDelayMs: extra.minDelayMs ?? 0,
    sleep: extra.sleep,
    onTrace: extra.events ? (e) => extra.events!.push(e) : undefined,
  });
}

describe('crawlPaginatedPages — 链接图遍历', () => {
  afterEach(() => localStorage.removeItem('pom.cssRules'));

  it('链式分页：逐页推进直到「下一页」指向自身/# 后收敛', async () => {
    const fetch = fakeFetch({
      [`${BASE}/read/1`]: page('<a href="/read/2">下一页</a>'),
      [`${BASE}/read/2`]: page('<a href="/read/1">上一页</a><a href="/read/3">下一页</a>'),
      [`${BASE}/read/3`]: page('<a href="/read/2">上一页</a><a href="#">下一页</a>'),
    });
    const r = await crawl(`${BASE}/read/1`, fetch);
    expect(r.pages.map((p) => p.url)).toEqual([
      `${BASE}/read/1`,
      `${BASE}/read/2`,
      `${BASE}/read/3`,
    ]);
    expect(r.truncated).toBe(false);
    expect(r.order).toBe('page-number');
    expect(r.inferredPosition).toEqual({ kind: 'path', index: 2 });
    expect(fetch.calls).toHaveLength(3);
  });

  it('星型分页：首页部分列出页码，剩余页在后续页区域补全', async () => {
    const fetch = fakeFetch({
      [`${BASE}/list/1`]: page('<a href="/list/3">3</a><a href="/list/2">2</a>'),
      [`${BASE}/list/3`]: page('<a href="/list/2">2</a><a href="/list/4">4</a>'),
      [`${BASE}/list/2`]: page('<a href="/list/4">4</a>'),
      [`${BASE}/list/4`]: page('<a href="/list/1">1</a>'),
    });
    const r = await crawl(`${BASE}/list/1`, fetch);
    // 发现序 1,3,2,4 → 按页码位数字升序恢复
    expect(fetch.calls).toEqual([
      `${BASE}/list/1`,
      `${BASE}/list/3`,
      `${BASE}/list/2`,
      `${BASE}/list/4`,
    ]);
    expect(r.pages.map((p) => p.url)).toEqual([
      `${BASE}/list/1`,
      `${BASE}/list/2`,
      `${BASE}/list/3`,
      `${BASE}/list/4`,
    ]);
  });

  it('path 段页码位推断：形状不符/非纯数字/外站链接全部排除', async () => {
    const fetch = fakeFetch({
      [`${BASE}/list/1`]: page(
        '<a href="/list/2">2</a><a href="/list/3">3</a>' +
          '<a href="/about">关于</a>' + // path 段数不同
          '<a href="/list/abc">非数字</a>' + // 差异值非纯数字
          '<a href="https://other.com/list/2">外站</a>', // origin 不同
      ),
      [`${BASE}/list/2`]: page(''),
      [`${BASE}/list/3`]: page(''),
    });
    const r = await crawl(`${BASE}/list/1`, fetch);
    expect(r.pages.map((p) => p.url)).toEqual([
      `${BASE}/list/1`,
      `${BASE}/list/2`,
      `${BASE}/list/3`,
    ]);
    expect(r.inferredPosition).toEqual({ kind: 'path', index: 2 });
  });

  it('query 值页码位推断：键集合不符（追踪参数/换键）排除', async () => {
    const fetch = fakeFetch({
      [`${BASE}/list?page=1`]: page(
        '<a href="/list?page=2">2</a><a href="/list?page=3">3</a>' +
          '<a href="/list?page=2&t=9">带追踪参数</a>' + // query 键集合不同
          '<a href="/list?sort=asc">换键</a>', // query 键不同
      ),
      [`${BASE}/list?page=2`]: page(''),
      [`${BASE}/list?page=3`]: page(''),
    });
    const r = await crawl(`${BASE}/list?page=1`, fetch);
    expect(r.pages.map((p) => p.url)).toEqual([
      `${BASE}/list?page=1`,
      `${BASE}/list?page=2`,
      `${BASE}/list?page=3`,
    ]);
    expect(r.inferredPosition).toEqual({ kind: 'query', key: 'page' });
  });

  it('推断失败：区域链接形状各异 → 不跟随任何链接并发 inference-failed trace', async () => {
    const events: PaginationTraceEvent[] = [];
    const fetch = fakeFetch({
      [`${BASE}/list/1`]: page(
        '<a href="/list/abc">非数字</a><a href="/other/2">两段不同</a><a href="/list/1?ref=x">带参</a>',
      ),
    });
    const r = await crawl(`${BASE}/list/1`, fetch, { area: AREA }, { events });
    expect(r.pages.map((p) => p.url)).toEqual([`${BASE}/list/1`]);
    expect(r.inferredPosition).toBeUndefined();
    expect(r.order).toBe('dom-discovery');
    expect(events).toEqual([{ type: 'inference-failed' }]);
    expect(fetch.calls).toHaveLength(1);
  });

  it('linkPattern 优先：形状无关链接可跟随，按首个数字组升序', async () => {
    const fetch = fakeFetch({
      [`${BASE}/toc/abc`]: page(
        '<a href="/toc/abc-10.html">10</a><a href="/toc/abc-2.html">2</a><a href="/toc/xyz">不命中</a>',
      ),
      [`${BASE}/toc/abc-10.html`]: page('<a href="/toc/abc-2.html">2</a>'),
      [`${BASE}/toc/abc-2.html`]: page(''),
    });
    const r = await crawl(`${BASE}/toc/abc`, fetch, {
      area: AREA,
      linkPattern: 'abc-(\\d+)\\.html',
    });
    // 发现序 start,10,2 → 按 linkPattern 数字组升序；起始页无数字组恒最前
    expect(r.pages.map((p) => p.url)).toEqual([
      `${BASE}/toc/abc`,
      `${BASE}/toc/abc-2.html`,
      `${BASE}/toc/abc-10.html`,
    ]);
    expect(r.order).toBe('link-pattern-number');
    expect(r.inferredPosition).toBeUndefined();
  });

  it('URL 归一化去重：相对路径/绝对 URL/#hash 指向同页只抓一次', async () => {
    const fetch = fakeFetch({
      [`${BASE}/list/1`]: page(
        '<a href="/list/2">2</a><a href="/list/2#top">hash</a>' +
          `<a href="${BASE}/list/2">绝对</a><a href="2">相对</a>`,
      ),
      [`${BASE}/list/2`]: page(''),
    });
    const r = await crawl(`${BASE}/list/1`, fetch);
    expect(fetch.calls).toEqual([`${BASE}/list/1`, `${BASE}/list/2`]);
    expect(r.pages).toHaveLength(2);
  });

  it('页序：起始页无页码值（bookUrl 无页码段）时恒排最前', async () => {
    const fetch = fakeFetch({
      [`${BASE}/list/home`]: page('<a href="/list/2">2</a><a href="/list/3">3</a>'),
      [`${BASE}/list/2`]: page('<a href="/list/3">3</a>'),
      [`${BASE}/list/3`]: page(''),
    });
    const r = await crawl(`${BASE}/list/home`, fetch);
    expect(r.pages.map((p) => p.url)).toEqual([
      `${BASE}/list/home`,
      `${BASE}/list/2`,
      `${BASE}/list/3`,
    ]);
    expect(r.order).toBe('page-number');
  });

  it('页序：linkPattern 无数字捕获组 → DOM 发现序并标记 dom-discovery', async () => {
    const fetch = fakeFetch({
      [`${BASE}/p/start`]: page('<a href="/p/page-b">b</a><a href="/p/page-a">a</a>'),
      [`${BASE}/p/page-b`]: page(''),
      [`${BASE}/p/page-a`]: page(''),
    });
    const r = await crawl(`${BASE}/p/start`, fetch, { area: AREA, linkPattern: 'page-\\w+' });
    expect(r.pages.map((p) => p.url)).toEqual([
      `${BASE}/p/start`,
      `${BASE}/p/page-b`,
      `${BASE}/p/page-a`,
    ]);
    expect(r.order).toBe('dom-discovery');
  });

  it('maxPages 截断：撞限停止并 trace truncated，返回已抓部分', async () => {
    const events: PaginationTraceEvent[] = [];
    const chain: Record<string, string> = {};
    for (let i = 1; i <= 5; i++) {
      chain[`${BASE}/c/${i}`] = page(i < 5 ? `<a href="/c/${i + 1}">下一页</a>` : '');
    }
    const fetch = fakeFetch(chain);
    const r = await crawl(`${BASE}/c/1`, fetch, { area: AREA, maxPages: 2 }, { events });
    expect(r.pages.map((p) => p.url)).toEqual([`${BASE}/c/1`, `${BASE}/c/2`]);
    expect(r.truncated).toBe(true);
    expect(events).toEqual([{ type: 'truncated', maxPages: 2 }]);
  });

  it('maxPages 缺省值由调用方传入（正文缺省 20）', async () => {
    const chain: Record<string, string> = {};
    for (let i = 1; i <= 25; i++) {
      chain[`${BASE}/c/${i}`] = page(i < 25 ? `<a href="/c/${i + 1}">下一页</a>` : '');
    }
    const fetch = fakeFetch(chain);
    const r = await crawl(
      `${BASE}/c/1`,
      fetch,
      { area: AREA },
      {
        defaultMaxPages: CONTENT_DEFAULT_MAX_PAGES,
      },
    );
    expect(r.pages).toHaveLength(20);
    expect(r.truncated).toBe(true);
  });

  it('单页失败（非首页）：终止循环返回已抓部分，error 携带错误不 throw', async () => {
    const fetch = fakeFetch(
      {
        [`${BASE}/c/1`]: page('<a href="/c/2">下一页</a>'),
        [`${BASE}/c/3`]: page(''),
      },
      { [`${BASE}/c/2`]: '网关超时' },
    );
    const r = await crawl(`${BASE}/c/1`, fetch);
    expect(r.pages.map((p) => p.url)).toEqual([`${BASE}/c/1`]);
    expect(r.error).toBe('网关超时');
    expect(r.truncated).toBe(false);
  });

  it('首页失败直接 throw（与现状单页行为一致）', async () => {
    const fetch = fakeFetch({}, { [`${BASE}/c/1`]: '首页超时' });
    await expect(crawl(`${BASE}/c/1`, fetch)).rejects.toThrow('首页超时');
  });

  it('正文守卫：后续页的「下一章」链接与起始页形状不符被挡在门外', async () => {
    const fetch = fakeFetch({
      [`${BASE}/book/100/1`]: page('<a href="/book/100/2">下一页</a>'),
      [`${BASE}/book/100/2`]: page(
        '<a href="/book/100/3">下一页</a><a href="/book/101/1">下一章</a>',
      ),
      [`${BASE}/book/100/3`]: page('<a href="/book/102/1">下一章</a>'),
    });
    const r = await crawl(`${BASE}/book/100/1`, fetch);
    expect(fetch.calls).toEqual([`${BASE}/book/100/1`, `${BASE}/book/100/2`, `${BASE}/book/100/3`]);
    expect(r.pages.map((p) => p.url)).toEqual([
      `${BASE}/book/100/1`,
      `${BASE}/book/100/2`,
      `${BASE}/book/100/3`,
    ]);
  });

  it('无分页区域（area 未命中）= 单页', async () => {
    const fetch = fakeFetch({ [`${BASE}/plain`]: '<html><body>无区域</body></html>' });
    const r = await crawl(`${BASE}/plain`, fetch);
    expect(r.pages).toHaveLength(1);
    expect(fetch.calls).toHaveLength(1);
  });

  it('页间 minDelayMs：首页之后每页前等待（注入假 sleep）', async () => {
    const sleep = vi.fn((ms: number) => {
      void ms;
      return Promise.resolve();
    });
    const fetch = fakeFetch({
      [`${BASE}/c/1`]: page('<a href="/c/2">2</a>'),
      [`${BASE}/c/2`]: page('<a href="/c/3">3</a>'),
      [`${BASE}/c/3`]: page(''),
    });
    await crawl(`${BASE}/c/1`, fetch, { area: AREA }, { minDelayMs: 50, sleep });
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(50);
  });

  it('F6c 门：cssRules=0 时 CSS 区域规则响亮失败', async () => {
    localStorage.setItem('pom.cssRules', '0');
    const fetch = fakeFetch({ [`${BASE}/c/1`]: page('') });
    await expect(crawl(`${BASE}/c/1`, fetch)).rejects.toThrow(CSS_RULES_DISABLED_MESSAGE);
  });
});
