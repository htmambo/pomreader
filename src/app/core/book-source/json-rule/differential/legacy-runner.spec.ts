import { describe, it, expect } from 'vitest';
import {
  callLegacy,
  compileLegacySource,
  makeSampleJsSource,
  SAMPLE_HTML,
  SAMPLE_RULES_CSS,
  type FixtureMap,
  type BookInfoLike,
  type RawSearchItem,
} from './legacy-runner';
import { parseJsSource } from '../../../logic/rule-parse';

const BASE = 'https://example.com';
// 引擎对 {keyword} 做 encodeURIComponent，fixture 键必须用编码后的形态，
// 否则基座的"未登记即报错"设计会先炸出来（这正是它该有的行为）
const SEARCH_URL = `${BASE}/search?q=${encodeURIComponent('测试')}&page=1`;
const DETAIL_URL = `${BASE}/book/1`;
const CHAPTER_URL = `${BASE}/chapter/1`;

const FIXTURES: FixtureMap = {
  [SEARCH_URL]: { body: SAMPLE_HTML.search },
  [DETAIL_URL]: { body: SAMPLE_HTML.detail },
  [CHAPTER_URL]: { body: SAMPLE_HTML.chapter },
};

describe('差分基座 — 旧 JS 引擎侧', () => {
  const mod = compileLegacySource(makeSampleJsSource(), FIXTURES);

  it('样例源码确实是「少两个可选常量」的旧模板形态', () => {
    const parsed = parseJsSource(makeSampleJsSource());
    expect(parsed.missingConsts).toEqual(['SEARCH_AUTHOR_RULE', 'SEARCH_CATEGORY_RULE']);
    // 基座用的就是解析器认得的常量形态
    expect(parsed.rules.searchItemPattern).toBe(SAMPLE_RULES_CSS.searchItemPattern);
  });

  it('search：走真实 JS + 真实 DOMParser，抽出条目结构完整', async () => {
    const r = await callLegacy<RawSearchItem[]>(mod, 'search', ['测试', 1]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual([
      { name: '示例书一', author: '', kind: '', bookUrl: `${BASE}/book/1` },
      { name: '示例书二', author: '', kind: '', bookUrl: `${BASE}/book/2` },
    ]);
  });

  it('bookInfo：标题 / 作者 / 分类 / 封面（绝对化）/ 章节列表', async () => {
    const r = await callLegacy<BookInfoLike>(mod, 'bookInfo', [DETAIL_URL]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.title).toBe('示例书一');
    expect(r.value.author).toBe('作者甲');
    expect(r.value.category).toBe('玄幻');
    // COVER_RULE 是 css:div.cover img → 取 img 的 src 并绝对化
    expect(r.value.cover).toBe(`${BASE}/cover/1.jpg`);
    expect(r.value.chapters.map((c) => c.name)).toEqual(['第一章', '第二章']);
  });

  it('chapterList：绝对化章节链接', async () => {
    const r = await callLegacy<{ name: string; url: string }[]>(mod, 'chapterList', [DETAIL_URL]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual([
      { name: '第一章', url: `${BASE}/chapter/1` },
      { name: '第二章', url: `${BASE}/chapter/2` },
    ]);
  });

  it('chapterContent：剥标签 + 正文净化规则生效', async () => {
    const r = await callLegacy<string>(mod, 'chapterContent', [CHAPTER_URL]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toContain('正文第一段');
    // CONTENT_REPLACE_RULES 把"一秒记住…"整条广告删掉
    expect(r.value).not.toContain('一秒记住');
  });
});

describe('差分基座 — 错误语义必须与真实链路一致', () => {
  it('空选择器 → reject 且带真实报错文案（与 SandboxService 同源）', async () => {
    // 规则全空 → 引擎必然发空选择器查询
    const empty =
      'async function bookInfo(u){ const h = await legado.http.get(u); return await legado.query(h, "", u); }';
    const mod = compileLegacySource(empty, { [DETAIL_URL]: { body: SAMPLE_HTML.detail } });
    const r = await callLegacy(mod, 'bookInfo', [DETAIL_URL]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('选择器为空');
  });

  it('URL 未登记 fixture → 立刻报错，绝不静默返回空 HTML', async () => {
    const src = 'async function chapterContent(u){ return await legado.http.get(u); }';
    const mod = compileLegacySource(src, {}, { onMissing: 'throw' });
    const r = await callLegacy(mod, 'chapterContent', ['https://example.com/never-registered']);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('未登记 fixture');
  });

  it('缺失入口 → 明确报"未导出"，不是 undefined 崩溃', async () => {
    const r = await callLegacy(compileLegacySource('const A = 1;', {}), 'search', ['x', 1]);
    expect(r).toEqual({ ok: false, error: '旧引擎未导出入口 search' });
  });
});

describe('差分基座 — pom.cssRules 止血开关必须真的生效（F6c）', () => {
  afterEach(() => localStorage.removeItem('pom.cssRules'));

  it('localStorage pom.cssRules=0 时 query 抛错 —— 这是用户当前可观察到的行为', async () => {
    localStorage.setItem('pom.cssRules', '0');
    const src =
      'async function chapterList(u){ const h = await legado.http.get(u); const a = await legado.query(h, "ul.chapter-list li a", u); return a.length; }';
    const mod = compileLegacySource(src, { [DETAIL_URL]: { body: SAMPLE_HTML.detail } });
    const r = await callLegacy(mod, 'chapterList', [DETAIL_URL]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('CSS 规则已禁用');
  });

  it('默认（未设置）时正常返回', async () => {
    const src =
      'async function chapterList(u){ const h = await legado.http.get(u); const a = await legado.query(h, "ul.chapter-list li a", u); return a.length; }';
    const mod = compileLegacySource(src, { [DETAIL_URL]: { body: SAMPLE_HTML.detail } });
    const r = await callLegacy(mod, 'chapterList', [DETAIL_URL]);
    expect(r).toEqual({ ok: true, value: 2 });
  });
});
