import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import {
  BookSourceDocSchema,
  SourceRulesSchema,
  isBookSourceDocLike,
  type BookSourceDoc,
} from './book-source-doc.model';

/** 最小合法 rules（7 必填） */
const MIN_RULES = {
  siteName: '示例站',
  searchPath: '/search?keyword={keyword}',
  searchItemPattern: 'css:dl.list dd',
  bookTitlePattern: 'css:h1',
  bookAuthorPattern: 'css:.author',
  chapterItemPattern: 'css:#list a',
  contentPattern: 'css:#content',
};

/** 最小合法文档 */
const MIN_DOC = {
  format: 'pomreader.booksource',
  schemaVersion: 1,
  uuid: 'foo.json',
  name: 'foo',
  homepage: 'https://example.com',
  urls: ['https://example.com'],
  enabled: true,
  sourceType: 'novel',
  tags: [],
  minDelayMs: 0,
  requireUrls: [],
  headers: {},
  rules: MIN_RULES,
};

describe('BookSourceDocSchema', () => {
  it('接受最小合法文档', () => {
    const r = v.safeParse(BookSourceDocSchema, MIN_DOC);
    expect(r.success).toBe(true);
  });

  it('schema 输出与 BookSourceDoc 接口编译期兼容', () => {
    const r = v.safeParse(BookSourceDocSchema, MIN_DOC);
    if (!r.success) throw new Error('should parse');
    const doc: BookSourceDoc = r.output;
    expect(doc.uuid).toBe('foo.json');
  });

  it('searchMethod 缺省回填 GET（可选，不可设 required）', () => {
    const r = v.safeParse(BookSourceDocSchema, MIN_DOC);
    expect(r.success && r.output.rules.searchMethod).toBe('GET');
  });

  it('format 标记不符 → 拒绝', () => {
    const r = v.safeParse(BookSourceDocSchema, { ...MIN_DOC, format: 'other' });
    expect(r.success).toBe(false);
  });

  it('schemaVersion 非 1 → 拒绝（v1 恒为 1）', () => {
    const r = v.safeParse(BookSourceDocSchema, { ...MIN_DOC, schemaVersion: 2 });
    expect(r.success).toBe(false);
  });

  it.each([
    'siteName',
    'searchPath',
    'searchItemPattern',
    'bookTitlePattern',
    'bookAuthorPattern',
    'chapterItemPattern',
    'contentPattern',
  ] as const)('必填规则字段 %s 缺失 → 拒绝', (field) => {
    const rules = { ...MIN_RULES } as Record<string, unknown>;
    delete rules[field];
    const r = v.safeParse(BookSourceDocSchema, { ...MIN_DOC, rules });
    expect(r.success).toBe(false);
  });

  it('可选规则字段全缺省仍通过', () => {
    const r = v.safeParse(SourceRulesSchema, MIN_RULES);
    expect(r.success).toBe(true);
  });

  it('headers 非 string map → 拒绝', () => {
    const r = v.safeParse(BookSourceDocSchema, {
      ...MIN_DOC,
      headers: { 'User-Agent': 42 },
    });
    expect(r.success).toBe(false);
  });

  it('非法 sourceType → 拒绝', () => {
    const r = v.safeParse(BookSourceDocSchema, { ...MIN_DOC, sourceType: 'audio' });
    expect(r.success).toBe(false);
  });

  it('legadoRaw 可选（骨架源内嵌原始 JSON）', () => {
    const r = v.safeParse(BookSourceDocSchema, { ...MIN_DOC, legadoRaw: '{"rule":{}}' });
    expect(r.success).toBe(true);
  });
});

describe('isBookSourceDocLike', () => {
  it('format 标记命中 → true', () => {
    expect(isBookSourceDocLike({ format: 'pomreader.booksource' })).toBe(true);
  });

  it.each([null, undefined, {}, 'x', 42, { format: 'other' }])('非书源 JSON → false', (val) => {
    expect(isBookSourceDocLike(val)).toBe(false);
  });
});
