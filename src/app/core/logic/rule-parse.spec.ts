import { describe, it, expect } from 'vitest';
import { extractRulesFromJs, extractBaseUrl, extractHeaders } from './rule-parse';
import {
  generateSourceCode,
  DEFAULT_PATTERNS,
  type SourceRules,
} from '../book-source/smart-add/smart-rules';

/** 手拼最小可用书源（7 必填常量 + @name 头）；extra 追加常量行，name=null 去掉 @name 头 */
function makeSource(extra: string[] = [], opts: { name?: string | null } = {}): string {
  const lines = [
    ...(opts.name === null ? [] : [`// @name        ${opts.name ?? '测试站'}`]),
    'const BASE_URL = "https://example.com"',
    'const SEARCH_PATH = "/search?q={keyword}"',
    'const SEARCH_ITEM_RULE = "css:dl dd"',
    'const BOOK_TITLE_RULE = "css:h1"',
    'const BOOK_AUTHOR_RULE = "css:.author"',
    'const CHAPTER_ITEM_RULE = "css:dd a"',
    'const CONTENT_RULE = "css:#content"',
    ...extra,
  ];
  return lines.join('\n');
}

describe('rule-parse', () => {
  describe('round-trip（generateSourceCode → extractRulesFromJs）', () => {
    const rules: SourceRules = {
      siteName: '示例书源',
      searchPath: '/search?q={keyword}&page={page}',
      searchMethod: 'POST',
      searchBodyParams: [
        { key: 'q', value: '{keyword}' },
        { key: 'page', value: '{page}' },
      ],
      searchContentType: 'application/x-www-form-urlencoded',
      searchRawBody: '',
      searchItemPattern: 'css:dl.list dd',
      searchAuthorPattern: 'css:.author',
      searchCategoryPattern: 'css:.kind',
      bookTitlePattern: 'css:h1',
      bookAuthorPattern: 'css:.book-author',
      chapterItemPattern: '<a[^>]+href="([^"]+)"[^>]*>([^<]*第[^<]{1,60}章[^<]*)<\\/a>',
      contentPattern: 'css:#content',
      contentReplaceRules: [
        { rule: '<br>', replace: '\n' },
        { rule: '最新域名.*', replace: '' },
      ],
      bookCategoryPattern: '分类[：:]\\s*([^<]{1,20})',
      coverUrlPattern: 'css:img.cover',
    };

    it('全字段规则 round-trip 深比较一致', () => {
      const src = generateSourceCode('https://example.com', rules, {
        headers: { 'User-Agent': 'pom/1.0' },
      });
      expect(extractRulesFromJs(src)).toEqual(rules);
    });

    it('extractBaseUrl / extractHeaders 与生成入参一致', () => {
      const headers = { 'User-Agent': 'pom/1.0', Referer: 'https://example.com/' };
      const src = generateSourceCode('https://example.com', rules, { headers });
      expect(extractBaseUrl(src)).toBe('https://example.com');
      expect(extractHeaders(src)).toEqual(headers);
    });

    it('省略可选字段时回填与 generateSourceCode 注入逻辑同口径（无不对称）', () => {
      const minimal: SourceRules = {
        siteName: '极简站',
        searchPath: '/s?q={keyword}',
        searchMethod: 'POST_RAW',
        searchRawBody: '{"q":"{keyword}"}',
        searchItemPattern: 'css:dd',
        bookTitlePattern: 'css:h1',
        bookAuthorPattern: 'css:.author',
        chapterItemPattern: 'css:a',
        contentPattern: 'css:#content',
      };
      const parsed = extractRulesFromJs(generateSourceCode('https://example.com', minimal));
      // generateSourceCode :483-485 按 method 注入缺省 contentType，与本模块回填同口径
      expect(parsed?.searchContentType).toBe('application/json');
      // 生成器对省略字段注入模板缺省而非省略常量：解析结果拿到的是注入值（round-trip 的已知不对称点）
      expect(parsed?.coverUrlPattern).toBe(DEFAULT_PATTERNS.coverUrlPattern);
      expect(parsed?.bookCategoryPattern).toBe(DEFAULT_PATTERNS.bookCategoryPattern);
      expect(parsed?.searchBodyParams).toEqual([]);
      expect(parsed?.contentReplaceRules).toEqual([]);
      expect(parsed?.searchAuthorPattern).toBe('');
      expect(parsed?.searchCategoryPattern).toBe('');
    });
  });

  describe('extractHeaders', () => {
    it('提取 JSON 对象字面量', () => {
      const src = makeSource([
        'const HEADERS = {"User-Agent":"pom/1.0","Referer":"https://a.com/"}',
      ]);
      expect(extractHeaders(src)).toEqual({ 'User-Agent': 'pom/1.0', Referer: 'https://a.com/' });
    });
    it('HEADERS 常量缺失 → {}', () => {
      expect(extractHeaders(makeSource())).toEqual({});
    });
    it('非法 JSON → {}', () => {
      expect(extractHeaders(makeSource(['const HEADERS = {User-Agent: x}']))).toEqual({});
    });
    it('JSON 数组（非对象）→ {}', () => {
      expect(extractHeaders(makeSource(['const HEADERS = ["a"]']))).toEqual({});
    });
  });

  describe('旧元组形态升级（F15）', () => {
    it('[["k","v"],...] 升级为 {key,value} 对象数组', () => {
      const src = makeSource([
        'const SEARCH_BODY_PARAMS = [["q","{keyword}"],["page","{page}"]]',
        'const CONTENT_REPLACE_RULES = [["<br>",""],["广告",""]]',
      ]);
      const parsed = extractRulesFromJs(src);
      expect(parsed?.searchBodyParams).toEqual([
        { key: 'q', value: '{keyword}' },
        { key: 'page', value: '{page}' },
      ]);
      expect(parsed?.contentReplaceRules).toEqual([
        { rule: '<br>', replace: '' },
        { rule: '广告', replace: '' },
      ]);
    });
  });

  describe('searchContentType 缺省回填（方案 §4.2：按 method 区分）', () => {
    it('SEARCH_METHOD=POST_RAW → application/json', () => {
      const parsed = extractRulesFromJs(makeSource(['const SEARCH_METHOD = "POST_RAW"']));
      expect(parsed?.searchContentType).toBe('application/json');
    });
    it('SEARCH_METHOD=POST → application/x-www-form-urlencoded', () => {
      const parsed = extractRulesFromJs(makeSource(['const SEARCH_METHOD = "POST"']));
      expect(parsed?.searchContentType).toBe('application/x-www-form-urlencoded');
    });
    it('SEARCH_METHOD 缺省 → application/x-www-form-urlencoded', () => {
      const parsed = extractRulesFromJs(makeSource());
      expect(parsed?.searchMethod).toBe('GET');
      expect(parsed?.searchContentType).toBe('application/x-www-form-urlencoded');
    });
    it('显式 SEARCH_CONTENT_TYPE 常量优先于回填', () => {
      const parsed = extractRulesFromJs(
        makeSource(['const SEARCH_METHOD = "POST_RAW"', 'const SEARCH_CONTENT_TYPE = "text/xml"']),
      );
      expect(parsed?.searchContentType).toBe('text/xml');
    });
  });

  describe('模板版本漂移兼容', () => {
    it('缺 SEARCH_AUTHOR_RULE / SEARCH_CATEGORY_RULE 的旧版源 → 空串（不提取）', () => {
      const parsed = extractRulesFromJs(makeSource());
      expect(parsed?.searchAuthorPattern).toBe('');
      expect(parsed?.searchCategoryPattern).toBe('');
    });
  });

  describe('必填缺失 → null（needs-manual 判据）', () => {
    it('缺 CONTENT_RULE → null', () => {
      const src = makeSource().replace(/^const CONTENT_RULE.*$/m, '');
      expect(extractRulesFromJs(src)).toBeNull();
    });
    it('缺 SEARCH_PATH → null', () => {
      const src = makeSource().replace(/^const SEARCH_PATH.*$/m, '');
      expect(extractRulesFromJs(src)).toBeNull();
    });
    it('缺 @name 头 → null（siteName 必填；editor 容忍空串交运行时回退文件名，迁移语义不允许）', () => {
      expect(extractRulesFromJs(makeSource([], { name: null }))).toBeNull();
    });
    it('空字符串 → null', () => {
      expect(extractRulesFromJs('')).toBeNull();
    });
  });

  describe('extractBaseUrl', () => {
    it('提取 BASE_URL 常量', () => {
      expect(extractBaseUrl(makeSource())).toBe('https://example.com');
    });
    it('缺失 → 空串', () => {
      expect(extractBaseUrl('const X = 1')).toBe('');
    });
  });
});
