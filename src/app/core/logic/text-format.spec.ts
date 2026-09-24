import { describe, it, expect } from 'vitest';
import {
  stripEdgeBlankLines,
  normalizeParagraphIndent,
  finalizeChapterContent,
} from './text-format';

describe('stripEdgeBlankLines', () => {
  it('去除首尾空白行', () => {
    expect(stripEdgeBlankLines('\n\n段落一\n段落二\n\n')).toBe('段落一\n段落二');
  });

  it('去除整行为全角空格的空白行', () => {
    expect(stripEdgeBlankLines('　　\n段落\n　　　\n')).toBe('段落');
  });

  it('保留首段的段首全角空格缩进（trim 会误剥）', () => {
    expect(stripEdgeBlankLines('　　段落一\n　　段落二')).toBe('　　段落一\n　　段落二');
  });

  it('纯空白文本返回空串', () => {
    expect(stripEdgeBlankLines('  \n　　\n')).toBe('');
  });
});

describe('normalizeParagraphIndent', () => {
  it('无缩进段落补两个全角空格', () => {
    expect(normalizeParagraphIndent('段落一\n段落二')).toBe('　　段落一\n　　段落二');
  });

  it('已有全角缩进的段落保持不变（幂等）', () => {
    const t = '　　段落一\n　　段落二';
    expect(normalizeParagraphIndent(t)).toBe(t);
    expect(normalizeParagraphIndent(normalizeParagraphIndent(t))).toBe(t);
  });

  it('半角空格/Tab 缩进统一规范为两个全角空格', () => {
    expect(normalizeParagraphIndent('  段落一\n\t段落二')).toBe('　　段落一\n　　段落二');
  });

  it('空白行保持空行、不加缩进', () => {
    expect(normalizeParagraphIndent('段落一\n\n段落二')).toBe('　　段落一\n\n　　段落二');
  });
});

describe('finalizeChapterContent', () => {
  it('去首尾空白行 + 首段缩进保留', () => {
    expect(finalizeChapterContent('\n　　段落一\n\n段落二\n\n')).toBe('　　段落一\n\n　　段落二');
  });
});
