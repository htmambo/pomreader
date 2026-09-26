/**
 * Legado → pomreader JS 源 翻译器测试
 *
 * 覆盖：
 *  - 全 CSS 规则源：成功翻译（isSkeleton=false）
 *  - 翻译失败：返回骨架 JS（isSkeleton=true），含原始 JSON 注释 + 空函数 stub
 *  - 骨架默认 @enabled false（避免未完成的源进入搜索）
 *  - 含 jsLib / loginUrl / loginUi / eventListener：骨架
 *  - 含 java.* 桥接：骨架
 *  - 含 <js>/{{}}/$.jsonpath 规则：骨架
 *  - ruleToc.chapterList 不是 CSS：骨架
 *  - searchUrl 含 {key}：替换为 {keyword}
 *  - header JSON 字符串：注入到 HEADERS 常量
 *  - header 非 JSON 容错：HEADERS = {}
 *  - 翻译后的 JS 用 sandbox-style 验证：暴露 search / bookInfo / chapterContent 函数 + const HEADERS
 */
import { describe, it, expect } from 'vitest';
import { translateLegadoToJs } from './legado-translator';
import { LegadoSource } from './legado-types';

function makeSimpleLegadoSource(overrides: Partial<LegadoSource> = {}): LegadoSource {
  return {
    bookSourceName: '示例书源',
    bookSourceUrl: 'https://example.com',
    bookSourceType: 0,
    searchUrl: '/search?key={key}',
    ruleSearch: {
      bookList: '.result-list li',
      name: '.title',
      author: '.author',
    },
    ruleBookInfo: {
      name: 'h1.title',
      author: '.author',
      kind: '.category',
    },
    ruleToc: {
      chapterList: '.chapter-list a',
    },
    ruleContent: {
      content: '#content',
    },
    header: '{"User-Agent":"Mozilla/5.0"}',
    ...overrides,
  };
}

describe('translateLegadoToJs', () => {
  it('全 CSS 规则源：成功翻译（isSkeleton=false）', () => {
    const r = translateLegadoToJs(makeSimpleLegadoSource());
    expect(r.error).toBeNull();
    expect(r.isSkeleton).toBe(false);
    expect(r.js).toBeTruthy();
    expect(r.js).toContain('async function search');
    expect(r.js).toContain('async function bookInfo');
    expect(r.js).toContain('async function chapterContent');
  });

  it('翻译结果含文件头 @name / @tags / @type / @uuid', () => {
    const r = translateLegadoToJs(makeSimpleLegadoSource());
    expect(r.js).toContain('// @name        示例书源');
    expect(r.js).toContain('// @tags        legado-import');
    expect(r.js).toContain('// @type        novel');
    expect(r.js).toMatch(/\/\/ @uuid\s+legado-[0-9a-f]{8}/);
  });

  it('searchUrl 的 {key} 替换为 {keyword}', () => {
    const r = translateLegadoToJs(
      makeSimpleLegadoSource({ searchUrl: '/api/search?q={key}&p={page}' }),
    );
    expect(r.error).toBeNull();
    expect(r.js).toContain('const SEARCH_PATH = "/api/search?q={keyword}&p={page}"');
  });

  it('header JSON 注入到 const HEADERS', () => {
    const r = translateLegadoToJs(
      makeSimpleLegadoSource({ header: '{"User-Agent":"X","Referer":"https://r.com"}' }),
    );
    expect(r.js).toContain('const HEADERS = {"User-Agent":"X","Referer":"https://r.com"}');
  });

  it('header 非 JSON → HEADERS = {}', () => {
    const r = translateLegadoToJs(makeSimpleLegadoSource({ header: '{not valid' }));
    expect(r.js).toContain('const HEADERS = {}');
  });

  it('header 缺省 → HEADERS = {}', () => {
    const r = translateLegadoToJs(makeSimpleLegadoSource({ header: undefined }));
    expect(r.js).toContain('const HEADERS = {}');
  });

  it('含 jsLib → 返回骨架（js 非 null + isSkeleton=true）', () => {
    const r = translateLegadoToJs(makeSimpleLegadoSource({ jsLib: 'var x = 1;' }));
    expect(r.js).toBeTruthy();
    expect(r.isSkeleton).toBe(true);
    expect(r.error).toMatch(/jsLib/);
  });

  it('含 loginUrl → 骨架', () => {
    const r = translateLegadoToJs(makeSimpleLegadoSource({ loginUrl: 'console.log("x")' }));
    expect(r.js).toBeTruthy();
    expect(r.isSkeleton).toBe(true);
    expect(r.error).toMatch(/loginUrl/);
  });

  it('含 loginUi → 骨架', () => {
    const r = translateLegadoToJs(makeSimpleLegadoSource({ loginUi: '[{"name":"x"}]' }));
    expect(r.js).toBeTruthy();
    expect(r.isSkeleton).toBe(true);
    expect(r.error).toMatch(/loginUi/);
  });

  it('含 eventListener → 骨架', () => {
    const r = translateLegadoToJs(makeSimpleLegadoSource({ eventListener: true }));
    expect(r.js).toBeTruthy();
    expect(r.isSkeleton).toBe(true);
    expect(r.error).toMatch(/eventListener/);
  });

  it('含 enabledCookieJar → 骨架', () => {
    const r = translateLegadoToJs(makeSimpleLegadoSource({ enabledCookieJar: true }));
    expect(r.js).toBeTruthy();
    expect(r.isSkeleton).toBe(true);
    expect(r.error).toMatch(/cookieJar/);
  });

  it('ruleBookInfo 含 java.* → 骨架', () => {
    const r = translateLegadoToJs(
      makeSimpleLegadoSource({
        ruleBookInfo: { name: '<js>\njava.ajax(url)\n</js>' },
      }),
    );
    expect(r.js).toBeTruthy();
    expect(r.isSkeleton).toBe(true);
    expect(r.error).toMatch(/ruleBookInfo.*java/);
  });

  it('ruleContent 含 <js> + java.* → 骨架（按 java bridge 优先报错）', () => {
    const r = translateLegadoToJs(
      makeSimpleLegadoSource({
        ruleContent: { content: '<js>java.log(result)</js>' },
      }),
    );
    expect(r.isSkeleton).toBe(true);
    expect(r.error).toMatch(/ruleContent.*java/);
  });

  it('ruleContent 含纯 <js>（无 java bridge） → 骨架', () => {
    const r = translateLegadoToJs(
      makeSimpleLegadoSource({
        ruleContent: { content: '<js>result.replace(/\\n/g, "<br>")</js>' },
      }),
    );
    expect(r.isSkeleton).toBe(true);
    expect(r.error).toMatch(/ruleContent/);
  });

  it('ruleSearch.bookList 是 JSONPath → 骨架', () => {
    const r = translateLegadoToJs(
      makeSimpleLegadoSource({
        ruleSearch: { bookList: '$.data' },
      }),
    );
    expect(r.isSkeleton).toBe(true);
    expect(r.error).toMatch(/ruleSearch.*jsonpath/);
  });

  it('ruleToc.chapterList 不是 CSS → 骨架', () => {
    const r = translateLegadoToJs(
      makeSimpleLegadoSource({
        ruleToc: { chapterList: '<js>result.map(...)</js>' },
      }),
    );
    expect(r.isSkeleton).toBe(true);
    expect(r.error).toMatch(/ruleToc/);
  });

  it('ruleToc.chapterList 缺省 → 骨架', () => {
    const r = translateLegadoToJs(makeSimpleLegadoSource({ ruleToc: {} }));
    expect(r.isSkeleton).toBe(true);
    expect(r.error).toMatch(/chapterList/);
  });

  it('bookSourceType=1 翻译为 @type music', () => {
    const r = translateLegadoToJs(makeSimpleLegadoSource({ bookSourceType: 1 }));
    expect(r.js).toContain('// @type        music');
  });

  it('bookSourceGroup 写入 @tags', () => {
    const r = translateLegadoToJs(makeSimpleLegadoSource({ bookSourceGroup: '我的分组' }));
    expect(r.js).toContain('// @tags        legado-import,我的分组');
  });

  it('搜索结果书源名带 emoji / 特殊字符 → 文件头正常写入', () => {
    const r = translateLegadoToJs(
      makeSimpleLegadoSource({ bookSourceName: '🍅大灰狼/聚合 5.9.26' }),
    );
    expect(r.error).toBeNull();
    expect(r.js).toContain('// @name        🍅大灰狼/聚合 5.9.26');
  });

  it('disabled（enabled=false）→ @enabled false（成功翻译路径）', () => {
    const r = translateLegadoToJs(makeSimpleLegadoSource({ enabled: false }));
    expect(r.js).toContain('// @enabled     false');
    expect(r.isSkeleton).toBe(false);
  });

  it('搜索结果含 User-Agent header 时，每个 legado.http.get 都带 HEADERS', () => {
    const r = translateLegadoToJs(makeSimpleLegadoSource());
    expect(r.js).toMatch(/legado\.http\.get\(pageUrl, HEADERS\)/);
    expect(r.js).toMatch(/legado\.http\.get\(bookUrl, HEADERS\)/);
    expect(r.js).toMatch(/legado\.http\.get\(chapterUrl, HEADERS\)/);
  });

  // ── 骨架特性 ────────────────────────────────────────────────────────

  it('骨架包含原始 Legado JSON（便于用户编辑时参考）', () => {
    const r = translateLegadoToJs(makeSimpleLegadoSource({ jsLib: 'var x = 1;' }));
    expect(r.js).toContain('"bookSourceName": "示例书源"');
    expect(r.js).toContain('"jsLib": "var x = 1;"');
  });

  it('骨架 @enabled false（避免未完成源被 registry 加载）', () => {
    const r = translateLegadoToJs(makeSimpleLegadoSource({ jsLib: 'var x = 1;' }));
    expect(r.js).toMatch(/\/\/ @enabled\s+false/);
  });

  it('骨架含 4 个空函数 stub（search / bookInfo / chapterList / chapterContent）', () => {
    const r = translateLegadoToJs(makeSimpleLegadoSource({ jsLib: 'var x = 1;' }));
    expect(r.js).toMatch(/async function search\([^)]*\) \{[\s\S]*throw new Error/);
    expect(r.js).toMatch(/async function bookInfo\([^)]*\) \{[\s\S]*throw new Error/);
    expect(r.js).toMatch(/async function chapterList\([^)]*\) \{[\s\S]*throw new Error/);
    expect(r.js).toMatch(/async function chapterContent\([^)]*\) \{[\s\S]*throw new Error/);
  });

  it('骨架错误信息含失败原因', () => {
    const r = translateLegadoToJs(makeSimpleLegadoSource({ jsLib: 'var x = 1;' }));
    expect(r.js).toContain('源含 jsLib');
  });

  it('骨架文件头仍写入 @uuid / @tags / @type（确保 list 页能识别）', () => {
    const r = translateLegadoToJs(makeSimpleLegadoSource({ jsLib: 'var x = 1;' }));
    expect(r.js).toMatch(/\/\/ @uuid\s+legado-[0-9a-f]{8}/);
    expect(r.js).toContain('// @type        novel');
  });
});
