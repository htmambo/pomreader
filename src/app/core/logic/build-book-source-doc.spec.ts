import { describe, it, expect } from 'vitest';
import * as v from 'valibot';
import { buildBookSourceDoc } from './build-book-source-doc';
import { BookSourceDocSchema } from '../models/book-source-doc.model';
import { type SourceRules } from '../book-source/smart-add/smart-rules';

function makeRules(overrides: Partial<SourceRules> = {}): SourceRules {
  return {
    siteName: '示例站',
    searchPath: '/search?keyword={keyword}',
    searchItemPattern: 'css:.result a',
    bookTitlePattern: 'css:h1',
    bookAuthorPattern: '作者[：:]\\s*([^<]{1,30})',
    chapterItemPattern: 'css:.chapter-list a',
    contentPattern: 'css:#content',
    ...overrides,
  };
}

describe('buildBookSourceDoc', () => {
  it('最小输入 → 全量缺省（uuid=fileName 带扩展名 / name=siteName / urls=[homepage]）', () => {
    const doc = buildBookSourceDoc({
      fileName: 'foo.json',
      homepage: 'https://example.com',
      rules: makeRules(),
    });
    expect(doc).toMatchObject({
      format: 'pomreader.booksource',
      schemaVersion: 1,
      uuid: 'foo.json',
      name: '示例站',
      homepage: 'https://example.com',
      urls: ['https://example.com'],
      enabled: true,
      sourceType: 'novel',
      tags: [],
      minDelayMs: 0,
      requireUrls: [],
      headers: {},
    });
    // 可选字段缺省时不出现（保持落盘 JSON 干净）
    expect(doc).not.toHaveProperty('author');
    expect(doc).not.toHaveProperty('description');
    expect(doc).not.toHaveProperty('sourceVersion');
    expect(doc).not.toHaveProperty('updateUrl');
    expect(doc).not.toHaveProperty('legadoRaw');
  });

  it('uuid 缺省回退 fileName 且不剥扩展名（§3.1 硬约束）', () => {
    const doc = buildBookSourceDoc({
      fileName: 'bar.json',
      homepage: 'https://example.com',
      rules: makeRules(),
    });
    expect(doc.uuid).toBe('bar.json');
  });

  it('显式 uuid 优先于 fileName', () => {
    const doc = buildBookSourceDoc({
      uuid: 'legado-abc12345',
      fileName: 'foo.json',
      homepage: 'https://example.com',
      rules: makeRules(),
    });
    expect(doc.uuid).toBe('legado-abc12345');
  });

  it('uuid 与 fileName 都缺省 → 抛错', () => {
    expect(() =>
      buildBookSourceDoc({ homepage: 'https://example.com', rules: makeRules() }),
    ).toThrow(/uuid/);
  });

  it('urls 显式传入时 homepage 置顶且去重', () => {
    const doc = buildBookSourceDoc({
      fileName: 'foo.json',
      homepage: 'https://a.com',
      urls: ['https://a.com', 'https://b.com'],
      rules: makeRules(),
    });
    expect(doc.urls).toEqual(['https://a.com', 'https://b.com']);
  });

  it('meta 显式字段原样透传', () => {
    const doc = buildBookSourceDoc({
      fileName: 'foo.json',
      homepage: 'https://example.com',
      rules: makeRules(),
      name: '改名',
      author: 'legado-import',
      description: 'desc',
      enabled: false,
      sourceType: 'comic',
      sourceVersion: '1.0.0',
      updateUrl: 'https://u.com',
      tags: ['legado-import'],
      minDelayMs: 500,
      requireUrls: ['https://dep.com'],
      headers: { 'User-Agent': 'X' },
      legadoRaw: '{}',
    });
    expect(doc).toMatchObject({
      name: '改名',
      author: 'legado-import',
      description: 'desc',
      enabled: false,
      sourceType: 'comic',
      sourceVersion: '1.0.0',
      updateUrl: 'https://u.com',
      tags: ['legado-import'],
      minDelayMs: 500,
      requireUrls: ['https://dep.com'],
      headers: { 'User-Agent': 'X' },
      legadoRaw: '{}',
    });
  });

  it('产物过 BookSourceDocSchema 校验（最小输入与骨架形态）', () => {
    const normal = buildBookSourceDoc({
      fileName: 'foo.json',
      homepage: 'https://example.com',
      rules: makeRules(),
    });
    expect(v.safeParse(BookSourceDocSchema, normal).success).toBe(true);

    const skeleton = buildBookSourceDoc({
      uuid: 'legado-00000000',
      homepage: 'https://legado.invalid',
      enabled: false,
      legadoRaw: '{"bookSourceName":"x"}',
      rules: makeRules({
        searchItemPattern: 'css:body',
        bookTitlePattern: 'css:body',
        bookAuthorPattern: 'css:body',
        chapterItemPattern: 'css:body',
        contentPattern: 'css:body',
      }),
    });
    expect(v.safeParse(BookSourceDocSchema, skeleton).success).toBe(true);
  });
});
