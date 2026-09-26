import { describe, it, expect } from 'vitest';
import { pickBookUrl, pickChapterUrl, extractChapters } from './source-test.service';

describe('pickBookUrl', () => {
  it('优先取 bookUrl，回退 url', () => {
    expect(pickBookUrl([{ name: 'a', bookUrl: 'https://x/b/1' }])).toBe('https://x/b/1');
    expect(pickBookUrl([{ name: 'a', url: 'https://x/b/2' }])).toBe('https://x/b/2');
    expect(pickBookUrl([{ bookUrl: ' https://x/b/3 ' }])).toBe('https://x/b/3');
  });
  it('跳过空项与非字符串，找不到返回空串', () => {
    expect(pickBookUrl([null, 42, { name: 'a' }, { url: '  ' }, { url: 'https://x' }])).toBe('https://x');
    expect(pickBookUrl([])).toBe('');
    expect(pickBookUrl([{ name: 'a' }])).toBe('');
  });
});

describe('pickChapterUrl', () => {
  it('取第一个非空 url', () => {
    expect(pickChapterUrl([{ name: '第1章', url: 'https://x/c/1' }])).toBe('https://x/c/1');
    expect(pickChapterUrl([{ name: '无url' }, { url: 'https://x/c/2' }])).toBe('https://x/c/2');
  });
  it('找不到返回空串', () => {
    expect(pickChapterUrl([])).toBe('');
    expect(pickChapterUrl([{ name: 'x' }])).toBe('');
  });
});

describe('extractChapters', () => {
  it('按 chapters / toc / list / chapterList 顺序取第一个数组字段', () => {
    expect(extractChapters({ title: 't', chapters: [1, 2] })).toEqual([1, 2]);
    expect(extractChapters({ toc: [1] })).toEqual([1]);
    expect(extractChapters({ list: [1], chapterList: [2] })).toEqual([1]);
  });
  it('非对象或无章节数组返回空', () => {
    expect(extractChapters(null)).toEqual([]);
    expect(extractChapters('str')).toEqual([]);
    expect(extractChapters({ title: 't' })).toEqual([]);
  });
});
