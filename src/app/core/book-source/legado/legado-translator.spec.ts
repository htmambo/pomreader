/**
 * Legado → pomreader 书源 JSON 文档 翻译器测试
 *
 * 覆盖：
 *  - 全 CSS 规则源：成功翻译（isSkeleton=false），产出**合法 BookSourceDoc**
 *  - 翻译失败：返回骨架文档（isSkeleton=true），`enabled:false` + `legadoRaw` 内嵌原始 JSON
 *  - 骨架默认 enabled false（避免未完成的源被 registry 注册）
 *  - 含 jsLib / loginUrl / loginUi / eventListener / cookieJar：骨架
 *  - 含 java.* 桥接：骨架
 *  - 含 <js>/{{}}/$.jsonpath 规则：骨架
 *  - ruleToc.chapterList 不是 CSS / 缺省：骨架
 *  - searchUrl 含 {key}：替换为 {keyword}
 *  - header JSON 字符串 → 文档 headers 字段
 *  - header 非 JSON / 缺省：headers 为空（且**不写出**该键）
 *  - uuid 派生规则与旧 JS 头一致（书架里 bookSourceUuid 的连续性）
 *
 * 📌 书源 JSON 规则化 P2.3：本文件从断言"生成的 JS 文本"改为断言"产出的文档字段"。
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
  it('全 CSS 规则源：成功翻译（isSkeleton=false）', () => {
    const r = translateLegadoToDoc(makeSimpleLegadoSource());
    expect(r.error).toBeNull();
    expect(r.isSkeleton).toBe(false);
    expect(r.doc).toBeTruthy();
  });

  it('产出的文档能过 BookSourceDocSchema（构造链闭合）', () => {
    const r = translateLegadoToDoc(makeSimpleLegadoSource());
    expect(v.safeParse(BookSourceDocSchema, r.doc).success).toBe(true);
  });

  it('骨架文档同样过 schema（否则会写出一份"打不开"的源）', () => {
    const r = translateLegadoToDoc(makeSimpleLegadoSource({ jsLib: 'var x = 1;' }));
    expect(v.safeParse(BookSourceDocSchema, r.doc).success).toBe(true);
  });

  it('元数据落在文档字段上：name / tags / sourceType / uuid', () => {
    const r = translateLegadoToDoc(makeSimpleLegadoSource());
    expect(r.doc.name).toBe('示例书源');
    expect(r.doc.tags).toEqual(['legado-import']);
    expect(r.doc.sourceType).toBe('novel');
    expect(r.doc.uuid).toMatch(/^legado-[0-9a-f]{8}$/);
  });

  it('uuid 派生规则与旧 JS 头完全一致（书架里 bookSourceUuid 不会失联）', () => {
    // 同名重复导入必须派生出同一个 uuid（覆盖式更新），且跨版本不变
    const a = translateLegadoToDoc(makeSimpleLegadoSource()).doc.uuid;
    const b = translateLegadoToDoc(makeSimpleLegadoSource()).doc.uuid;
    expect(a).toBe(b);
    expect(a).toBe('legado-' + fnv1a('示例书源'));
  });

  it('searchUrl 的 {key} 替换为 {keyword}', () => {
    const r = translateLegadoToDoc(
      makeSimpleLegadoSource({ searchUrl: '/api/search?q={key}&p={page}' }),
    );
    expect(r.error).toBeNull();
    expect(r.doc.rules.searchPath).toBe('/api/search?q={keyword}&p={page}');
  });

  it('header JSON → 文档 headers 字段', () => {
    const r = translateLegadoToDoc(
      makeSimpleLegadoSource({ header: '{"User-Agent":"X","Referer":"https://r.com"}' }),
    );
    expect(r.doc.headers).toEqual({ 'User-Agent': 'X', Referer: 'https://r.com' });
  });

  it('header 非 JSON → 不写 headers 键（不是空对象）', () => {
    const r = translateLegadoToDoc(makeSimpleLegadoSource({ header: '{not valid' }));
    expect('headers' in r.doc).toBe(false);
  });

  it('header 缺省 → 不写 headers 键', () => {
    const r = translateLegadoToDoc(makeSimpleLegadoSource({ header: undefined }));
    expect('headers' in r.doc).toBe(false);
  });

  it('homepage 取候选 URL 的 origin', () => {
    expect(translateLegadoToDoc(makeSimpleLegadoSource()).doc.homepage).toBe('https://example.com');
  });

  it('含 jsLib → 返回骨架（doc 非空 + isSkeleton=true）', () => {
    const r = translateLegadoToDoc(makeSimpleLegadoSource({ jsLib: 'var x = 1;' }));
    expect(r.doc).toBeTruthy();
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

  it('书源名带 emoji / 特殊字符 → 文档字段照常写入（文件名 slug 化是另一层的事）', () => {
    const r = translateLegadoToDoc(
      makeSimpleLegadoSource({ bookSourceName: '🍅大灰狼/聚合 5.9.26' }),
    );
    expect(r.error).toBeNull();
    expect(r.doc.name).toBe('🍅大灰狼/聚合 5.9.26');
  });

  it('disabled（enabled=false）→ 文档 enabled false（成功翻译路径）', () => {
    const r = translateLegadoToDoc(makeSimpleLegadoSource({ enabled: false }));
    expect(r.doc.enabled).toBe(false);
    expect(r.isSkeleton).toBe(false);
  });

  it('规则不写 searchContentType 缺省（条件缺省留给装载时推导）', () => {
    const r = translateLegadoToDoc(makeSimpleLegadoSource());
    expect('searchContentType' in r.doc.rules).toBe(false);
  });

  // ── 骨架特性 ────────────────────────────────────────────────────────

  it('骨架 legadoRaw 内嵌原始 Legado JSON（便于用户补规则时参考）', () => {
    const r = translateLegadoToDoc(makeSimpleLegadoSource({ jsLib: 'var x = 1;' }));
    expect(r.doc.legadoRaw).toContain('"bookSourceName": "示例书源"');
    expect(r.doc.legadoRaw).toContain('"jsLib": "var x = 1;"');
  });

  it('legadoRaw 是可解析的 JSON 字符串（不是拼过的注释块）', () => {
    const r = translateLegadoToDoc(makeSimpleLegadoSource({ jsLib: 'var x = 1;' }));
    expect(() => JSON.parse(r.doc.legadoRaw as string)).not.toThrow();
  });

  it('骨架 enabled false（避免未完成源被 registry 注册）', () => {
    const r = translateLegadoToDoc(makeSimpleLegadoSource({ jsLib: 'var x = 1;' }));
    expect(r.doc.enabled).toBe(false);
  });

  it('骨架 tags 含 needs-manual（列表页可据此给"需手写"角标）', () => {
    const r = translateLegadoToDoc(makeSimpleLegadoSource({ jsLib: 'var x = 1;' }));
    expect(r.doc.tags).toContain('needs-manual');
  });

  it('骨架描述里带失败原因（用户在列表页就能看到为什么没转成）', () => {
    const r = translateLegadoToDoc(makeSimpleLegadoSource({ jsLib: 'var x = 1;' }));
    expect(r.doc.description).toContain('源含 jsLib');
  });

  it('骨架仍写 uuid / sourceType（确保 list 页能识别与定位）', () => {
    const r = translateLegadoToDoc(makeSimpleLegadoSource({ jsLib: 'var x = 1;' }));
    expect(r.doc.uuid).toMatch(/^legado-[0-9a-f]{8}$/);
    expect(r.doc.sourceType).toBe('novel');
  });

  it('骨架的占位规则存在且非空（启用后也不会崩在 undefined 上）', () => {
    const r = translateLegadoToDoc(makeSimpleLegadoSource({ jsLib: 'var x = 1;' }));
    for (const key of [
      'siteName',
      'searchPath',
      'searchItemPattern',
      'bookTitlePattern',
      'bookAuthorPattern',
      'chapterItemPattern',
      'contentPattern',
    ] as const) {
      expect(r.doc.rules[key], key).toBeTruthy();
    }
  });
});

/** 与 translator 内同一套 FNV-1a（改派生规则时这条测试会红，用来提醒 uuid 兼容性） */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
