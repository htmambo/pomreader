/**
 * Legado → pomreader BookSourceDoc 翻译器测试
 *
 * 覆盖：
 *  - 全 CSS 规则源：成功翻译（isSkeleton=false），rules/meta/headers 字段映射
 *  - 翻译失败：返回骨架 doc（isSkeleton=true）：enabled:false + legadoRaw + 占位 rules
 *    + description 写明拒绝原因
 *  - 骨架默认 enabled:false（避免未完成的源进入搜索）
 *  - 含 jsLib / loginUrl / loginUi / eventListener / cookieJar：骨架
 *  - 含 java.* 桥接 / <js>/{{}}/$.jsonpath 规则：骨架
 *  - ruleToc.chapterList 缺失或不是 CSS：骨架
 *  - searchUrl 含 {key}：替换为 {keyword}
 *  - header JSON 字符串：进 doc.headers（F7）；非 JSON / 缺省容错为 {}
 *  - 成功与骨架产物均过 BookSourceDocSchema 校验
 */
import { describe, it, expect } from 'vitest';
import * as v from 'valibot';
import { translateLegadoToDoc } from './legado-translator';
import { LegadoSource } from './legado-types';
import { BookSourceDocSchema } from '../../models/book-source-doc.model';

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

describe('translateLegadoToDoc', () => {
  it('全 CSS 规则源：成功翻译（isSkeleton=false），产物过 schema 校验', () => {
    const r = translateLegadoToDoc(makeSimpleLegadoSource());
    expect(r.error).toBeNull();
    expect(r.isSkeleton).toBe(false);
    expect(v.safeParse(BookSourceDocSchema, r.doc).success).toBe(true);
    expect(r.doc.rules.searchItemPattern).toBeTruthy();
    expect(r.doc.rules.chapterItemPattern).toBeTruthy();
    expect(r.doc.rules.contentPattern).toBeTruthy();
  });

  it('meta 字段：name / tags / sourceType / uuid / format / schemaVersion', () => {
    const r = translateLegadoToDoc(makeSimpleLegadoSource());
    expect(r.doc.format).toBe('pomreader.booksource');
    expect(r.doc.schemaVersion).toBe(1);
    expect(r.doc.name).toBe('示例书源');
    expect(r.doc.tags).toContain('legado-import');
    expect(r.doc.sourceType).toBe('novel');
    expect(r.doc.uuid).toMatch(/^legado-[0-9a-f]{8}$/);
    expect(r.doc.author).toBe('legado-import');
    expect(r.doc.homepage).toBe('https://example.com');
    expect(r.doc.urls).toEqual(['https://example.com']);
    expect(r.doc.enabled).toBe(true);
  });

  it('searchUrl 的 {key} 替换为 {keyword}', () => {
    const r = translateLegadoToDoc(
      makeSimpleLegadoSource({ searchUrl: '/api/search?q={key}&p={page}' }),
    );
    expect(r.error).toBeNull();
    expect(r.doc.rules.searchPath).toBe('/api/search?q={keyword}&p={page}');
  });

  it('rule 字段映射：ruleSearch/ruleBookInfo/ruleToc/ruleContent → rules', () => {
    const r = translateLegadoToDoc(makeSimpleLegadoSource());
    expect(r.doc.rules.searchItemPattern).toContain('.result-list li');
    expect(r.doc.rules.searchAuthorPattern).toContain('.author');
    expect(r.doc.rules.bookTitlePattern).toContain('h1.title');
    expect(r.doc.rules.chapterItemPattern).toContain('.chapter-list a');
    expect(r.doc.rules.contentPattern).toContain('#content');
    expect(r.doc.rules.bookCategoryPattern).toContain('.category');
  });

  it('header JSON → doc.headers（F7）', () => {
    const r = translateLegadoToDoc(
      makeSimpleLegadoSource({ header: '{"User-Agent":"X","Referer":"https://r.com"}' }),
    );
    expect(r.doc.headers).toEqual({ 'User-Agent': 'X', Referer: 'https://r.com' });
  });

  it('header 非 JSON → headers = {}', () => {
    const r = translateLegadoToDoc(makeSimpleLegadoSource({ header: '{not valid' }));
    expect(r.doc.headers).toEqual({});
  });

  it('header 缺省 → headers = {}', () => {
    const r = translateLegadoToDoc(makeSimpleLegadoSource({ header: undefined }));
    expect(r.doc.headers).toEqual({});
  });

  it('含 jsLib → 返回骨架（isSkeleton=true + error）', () => {
    const r = translateLegadoToDoc(makeSimpleLegadoSource({ jsLib: 'var x = 1;' }));
    expect(r.isSkeleton).toBe(true);
    expect(r.error).toMatch(/jsLib/);
  });

  it('含 loginUrl → 骨架', () => {
    const r = translateLegadoToDoc(makeSimpleLegadoSource({ loginUrl: 'console.log("x")' }));
    expect(r.isSkeleton).toBe(true);
    expect(r.error).toMatch(/loginUrl/);
  });

  it('含 loginUi → 骨架', () => {
    const r = translateLegadoToDoc(makeSimpleLegadoSource({ loginUi: '[{"name":"x"}]' }));
    expect(r.isSkeleton).toBe(true);
    expect(r.error).toMatch(/loginUi/);
  });

  it('含 eventListener → 骨架', () => {
    const r = translateLegadoToDoc(makeSimpleLegadoSource({ eventListener: true }));
    expect(r.isSkeleton).toBe(true);
    expect(r.error).toMatch(/eventListener/);
  });

  it('含 enabledCookieJar → 骨架', () => {
    const r = translateLegadoToDoc(makeSimpleLegadoSource({ enabledCookieJar: true }));
    expect(r.isSkeleton).toBe(true);
    expect(r.error).toMatch(/cookieJar/);
  });

  it('ruleBookInfo 含 java.* → 骨架', () => {
    const r = translateLegadoToDoc(
      makeSimpleLegadoSource({
        ruleBookInfo: { name: '<js>\njava.ajax(url)\n</js>' },
      }),
    );
    expect(r.isSkeleton).toBe(true);
    expect(r.error).toMatch(/ruleBookInfo.*java/);
  });

  it('ruleContent 含 <js> + java.* → 骨架（按 java bridge 优先报错）', () => {
    const r = translateLegadoToDoc(
      makeSimpleLegadoSource({
        ruleContent: { content: '<js>java.log(result)</js>' },
      }),
    );
    expect(r.isSkeleton).toBe(true);
    expect(r.error).toMatch(/ruleContent.*java/);
  });

  it('ruleContent 含纯 <js>（无 java bridge） → 骨架', () => {
    const r = translateLegadoToDoc(
      makeSimpleLegadoSource({
        ruleContent: { content: '<js>result.replace(/\\n/g, "<br>")</js>' },
      }),
    );
    expect(r.isSkeleton).toBe(true);
    expect(r.error).toMatch(/ruleContent/);
  });

  it('ruleSearch.bookList 是 JSONPath → 骨架', () => {
    const r = translateLegadoToDoc(
      makeSimpleLegadoSource({
        ruleSearch: { bookList: '$.data' },
      }),
    );
    expect(r.isSkeleton).toBe(true);
    expect(r.error).toMatch(/ruleSearch.*jsonpath/);
  });

  it('ruleToc.chapterList 不是 CSS → 骨架', () => {
    const r = translateLegadoToDoc(
      makeSimpleLegadoSource({
        ruleToc: { chapterList: '<js>result.map(...)</js>' },
      }),
    );
    expect(r.isSkeleton).toBe(true);
    expect(r.error).toMatch(/ruleToc/);
  });

  it('ruleToc.chapterList 缺省 → 骨架', () => {
    const r = translateLegadoToDoc(makeSimpleLegadoSource({ ruleToc: {} }));
    expect(r.isSkeleton).toBe(true);
    expect(r.error).toMatch(/chapterList/);
  });

  it('bookSourceType=1 翻译为 sourceType music', () => {
    const r = translateLegadoToDoc(makeSimpleLegadoSource({ bookSourceType: 1 }));
    expect(r.doc.sourceType).toBe('music');
  });

  it('bookSourceGroup 写入 tags', () => {
    const r = translateLegadoToDoc(makeSimpleLegadoSource({ bookSourceGroup: '我的分组' }));
    expect(r.doc.tags).toEqual(['legado-import', '我的分组']);
  });

  it('书源名带 emoji / 特殊字符 → name 原样写入', () => {
    const r = translateLegadoToDoc(
      makeSimpleLegadoSource({ bookSourceName: '🍅大灰狼/聚合 5.9.26' }),
    );
    expect(r.error).toBeNull();
    expect(r.doc.name).toBe('🍅大灰狼/聚合 5.9.26');
  });

  it('disabled（enabled=false）→ doc.enabled false（成功翻译路径）', () => {
    const r = translateLegadoToDoc(makeSimpleLegadoSource({ enabled: false }));
    expect(r.doc.enabled).toBe(false);
    expect(r.isSkeleton).toBe(false);
  });

  it('bookSourceComment 写入 description（截首行 80 字符）', () => {
    const r = translateLegadoToDoc(
      makeSimpleLegadoSource({ bookSourceComment: '这是注释\n第二行' }),
    );
    expect(r.doc.description).toBe('由 legado JSON 导入：这是注释');
  });

  it('无 comment 且含 header → description 标注含自定义 HTTP header', () => {
    const r = translateLegadoToDoc(makeSimpleLegadoSource());
    expect(r.doc.description).toBe('由 legado JSON 导入（含自定义 HTTP header）');
  });

  // ── 骨架特性（F8） ────────────────────────────────────────────────────

  it('骨架 legadoRaw 内嵌原始 Legado JSON（便于用户编辑时参考）', () => {
    const r = translateLegadoToDoc(makeSimpleLegadoSource({ jsLib: 'var x = 1;' }));
    expect(r.doc.legadoRaw).toContain('"bookSourceName": "示例书源"');
    expect(r.doc.legadoRaw).toContain('"jsLib": "var x = 1;"');
  });

  it('骨架 enabled:false（避免未完成源被规则引擎加载）', () => {
    const r = translateLegadoToDoc(makeSimpleLegadoSource({ jsLib: 'var x = 1;' }));
    expect(r.doc.enabled).toBe(false);
  });

  it('骨架 description 写明拒绝原因', () => {
    const r = translateLegadoToDoc(makeSimpleLegadoSource({ jsLib: 'var x = 1;' }));
    expect(r.doc.description).toContain('源含 jsLib');
    expect(r.doc.description).toContain('未能自动转换');
  });

  it('骨架 rules 为无害占位（css:body），产物过 schema 校验', () => {
    const r = translateLegadoToDoc(makeSimpleLegadoSource({ jsLib: 'var x = 1;' }));
    expect(r.doc.rules.searchItemPattern).toBe('css:body');
    expect(r.doc.rules.bookTitlePattern).toBe('css:body');
    expect(r.doc.rules.bookAuthorPattern).toBe('css:body');
    expect(r.doc.rules.chapterItemPattern).toBe('css:body');
    expect(r.doc.rules.contentPattern).toBe('css:body');
    expect(v.safeParse(BookSourceDocSchema, r.doc).success).toBe(true);
  });

  it('骨架 meta 仍写入 uuid / tags / sourceType（确保列表页能识别）', () => {
    const r = translateLegadoToDoc(makeSimpleLegadoSource({ jsLib: 'var x = 1;' }));
    expect(r.doc.uuid).toMatch(/^legado-[0-9a-f]{8}$/);
    expect(r.doc.tags).toContain('legado-import');
    expect(r.doc.sourceType).toBe('novel');
    expect(r.doc.name).toBe('示例书源');
  });

  it('uuid 派生稳定：同名源重复导入 uuid 一致（D6）', () => {
    const a = translateLegadoToDoc(makeSimpleLegadoSource());
    const b = translateLegadoToDoc(makeSimpleLegadoSource({ searchUrl: '/other?q={key}' }));
    expect(a.doc.uuid).toBe(b.doc.uuid);
  });
});
