import { describe, expect, it } from 'vitest';
import { generateSourceCode, GENERATED_MARKER } from './smart-rules';
import {
  ensureGeneratedMarker,
  isStandardSource,
  parseSourceRules,
  stripGeneratedMarker,
} from './standard-source';

const RULES = {
  siteName: '样例站',
  searchPath: '/s.php',
  searchMethod: 'POST' as const,
  searchBodyParams: [
    { key: 'type', value: 'articlename' },
    { key: 's', value: '{keyword}' },
  ],
  searchItemPattern: 'li span.name a',
  bookTitlePattern: 'h1',
  bookAuthorPattern: '作者',
  chapterItemPattern: 'ul li a',
  contentPattern: '#content',
};

function gen(): string {
  return generateSourceCode('https://www.example.com/', RULES);
}

describe('isStandardSource', () => {
  it('generateSourceCode 产物判为标准', () => {
    expect(isStandardSource(gen())).toBe(true);
  });

  it('产物带 @generated marker 行', () => {
    expect(gen()).toContain(GENERATED_MARKER);
  });

  it('无 marker 的旧形态生成代码仍判为标准（存量迁移兼容）', () => {
    expect(isStandardSource(stripGeneratedMarker(gen()))).toBe(true);
  });

  it('改动代码函数体 → 增强', () => {
    const broken = gen().replace("return parts.join('&')", 'return parts.join(";")');
    expect(isStandardSource(broken)).toBe(false);
  });

  it('改动规则常量（面板可表达的值）→ 仍为标准', () => {
    const changed = gen().replace('"/s.php"', '"/search.php"');
    expect(isStandardSource(changed)).toBe(true);
  });

  it('手写源码（无模板结构）→ 增强', () => {
    expect(isStandardSource('async function search(key) { return [] }')).toBe(false);
  });

  it('空内容 → 增强', () => {
    expect(isStandardSource('')).toBe(false);
    expect(isStandardSource('   ')).toBe(false);
  });

  it('带自定义 HEADERS 的产物可正确往返判定', () => {
    const code = generateSourceCode('https://www.example.com/', RULES, {
      headers: { 'User-Agent': 'pom', Cookie: 'a=b' },
    });
    expect(isStandardSource(code)).toBe(true);
  });
});

describe('parseSourceRules', () => {
  it('从生成产物还原规则/baseUrl/headers', () => {
    const parsed = parseSourceRules(gen());
    expect(parsed.baseUrl).toBe('https://www.example.com');
    expect(parsed.headers).toEqual({});
    expect(parsed.rules.siteName).toBe('样例站');
    expect(parsed.rules.searchMethod).toBe('POST');
    expect(parsed.rules.searchBodyParams).toEqual(RULES.searchBodyParams);
  });

  it('SEARCH_BODY_PARAMS 对象形态（历史写出）也兼容解析', () => {
    const content =
      'const BASE_URL = "https://a.com"\n' +
      'const SEARCH_BODY_PARAMS = [{"key":"s","value":"{keyword}"},{"key":"submit","value":""}]';
    const parsed = parseSourceRules(content);
    expect(parsed.rules.searchBodyParams).toEqual([
      { key: 's', value: '{keyword}' },
      { key: 'submit', value: '' },
    ]);
  });
});

describe('marker 校正', () => {
  it('stripGeneratedMarker：无 marker 原样返回；有则剔除且幂等', () => {
    const plain = '// @name a\nconst A = 1\n';
    expect(stripGeneratedMarker(plain)).toBe(plain);
    const withMarker = `// @name a\n${GENERATED_MARKER}\nconst A = 1\n`;
    const stripped = stripGeneratedMarker(withMarker);
    expect(stripped).not.toContain('@generated');
    expect(stripGeneratedMarker(stripped)).toBe(stripped);
  });

  it('ensureGeneratedMarker：插入头部注释块末尾；已有则原样（幂等）', () => {
    const plain = '// @name a\n// @url https://a.com\n\nconst A = 1\n';
    const ensured = ensureGeneratedMarker(plain);
    const lines = ensured.split('\n');
    expect(lines[2]).toBe(GENERATED_MARKER);
    expect(lines[3]).toBe('');
    expect(ensureGeneratedMarker(ensured)).toBe(ensured);
  });

  it('ensure 后再判定仍为标准（补写 marker 不破坏代码）', () => {
    const legacy = stripGeneratedMarker(gen());
    expect(isStandardSource(ensureGeneratedMarker(legacy))).toBe(true);
  });
});
