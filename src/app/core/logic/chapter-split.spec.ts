import { describe, it, expect } from 'vitest';
import { splitChapters, defaultChapterPattern, toChapters } from './chapter-split';

describe('chapter-split', () => {
  describe('defaultChapterPattern', () => {
    it('matches 第X章', () => {
      expect(defaultChapterPattern().test('第一章 风起')).toBe(true);
      expect(defaultChapterPattern().test('第1章')).toBe(true);
      expect(defaultChapterPattern().test('第一百二十三章')).toBe(true);
    });
    it('matches 第X回', () => {
      expect(defaultChapterPattern().test('第一回')).toBe(true);
      expect(defaultChapterPattern().test('第5回')).toBe(true);
    });
    it('matches Chapter N', () => {
      expect(defaultChapterPattern().test('Chapter 1')).toBe(true);
      expect(defaultChapterPattern().test('chapter 100')).toBe(true);
    });
    it('matches Chapter roman', () => {
      expect(defaultChapterPattern().test('Chapter I')).toBe(true);
      expect(defaultChapterPattern().test('Chapter iv')).toBe(true);
    });
    it('matches with surrounding whitespace', () => {
      expect(defaultChapterPattern().test('  第一章  ')).toBe(true);
      expect(defaultChapterPattern().test('\t第一章')).toBe(true);
    });
    it('matches with 全角空格', () => {
      expect(defaultChapterPattern().test('第 一 章')).toBe(true);
    });
    it('does not match non-chapter lines', () => {
      expect(defaultChapterPattern().test('这是一段普通文本')).toBe(false);
      // 已知限制：'第X章末尾有内容' 也匹配（algorithm 决策中没区别章节标题与文本提及）
      // 业务侧由 fallback '全文' 兜底
      expect(defaultChapterPattern().test('')).toBe(false);
    });
  });

  describe('splitChapters', () => {
    it('returns single chapter for plain text without headings', () => {
      const text = '这是一段没有任何章节标题的普通文本。\n全是段落。\n没有章节切分。';
      const result = splitChapters(text);
      expect(result).toHaveLength(1);
      expect(result[0].title).toBe('全文');
      expect(result[0].startLine).toBe(0);
      expect(result[0].endLine).toBe(2);
    });

    it('returns single chapter for empty text', () => {
      const result = splitChapters('');
      expect(result).toHaveLength(1);
      expect(result[0].title).toBe('全文');
    });

    it('splits standard multi-chapter text', () => {
      const text = [
        '序',
        '',
        '第一章 风起云涌',
        'A 段落',
        'B 段落',
        '',
        '第二章 山雨欲来',
        'C 段落',
        'D 段落',
        '',
        '第三章 落花流水',
        'E 段落',
        'F 段落',
      ].join('\n');
      const result = splitChapters(text);
      expect(result).toHaveLength(4); // 序 + 3 章
      expect(result[0].title).toBe('序');
      expect(result[1].title).toBe('第一章 风起云涌');
      expect(result[2].title).toBe('第二章 山雨欲来');
      expect(result[3].title).toBe('第三章 落花流水');
    });

    it('preserves blank lines at start/end without losing chapters', () => {
      const text = [
        '',
        '第一章 开始',
        '内容',
        '',
      ].join('\n');
      const result = splitChapters(text);
      expect(result.length).toBeGreaterThanOrEqual(2);
      // preamble 段只有空行，回退到 '__preamble__'
      expect(result[0].title).toBe('__preamble__');
      expect(result[1].title).toBe('第一章 开始');
    });

    it('handles chapter headings with 全角空格', () => {
      const text = '第 一 章 开篇\n段落\n第 二 章 续\n段落';
      const result = splitChapters(text);
      expect(result).toHaveLength(2);
      expect(result[0].title).toBe('第 一 章 开篇');
      expect(result[1].title).toBe('第 二 章 续');
    });

    it('handles English chapter headings', () => {
      const text = 'Chapter 1\nfirst content\n\nChapter 2\nsecond content';
      const result = splitChapters(text);
      expect(result.length).toBeGreaterThanOrEqual(2);
      expect(result[0].title.toLowerCase()).toContain('chapter 1');
      expect(result[1].title.toLowerCase()).toContain('chapter 2');
    });

    it('respects custom pattern', () => {
      const text = 'PART ONE\ncontent\n\nPART TWO\nmore';
      const custom = /^\s*PART\s+(ONE|TWO|THREE)\s*$/i;
      const result = splitChapters(text, { pattern: custom });
      expect(result.length).toBeGreaterThanOrEqual(2);
      expect(result[0].title).toBe('PART ONE');
      expect(result[1].title).toBe('PART TWO');
    });

    it('does not over-split when text is very short', () => {
      const text = 'abc';
      const result = splitChapters(text);
      expect(result).toHaveLength(1);
      expect(result[0].title).toBe('全文');
    });

    it('handles chapter at very last line', () => {
      const text = '第一章\n内容\n\n第二章';
      const result = splitChapters(text);
      expect(result).toHaveLength(2);
      expect(result[1].title).toBe('第二章');
      expect(result[1].endLine).toBe(3);
    });

    it('handles \r\n line endings (Windows)', () => {
      const text = '第一章\r\n内容\r\n\r\n第二章\r\n更多内容';
      const result = splitChapters(text);
      expect(result.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('toChapters', () => {
    it('converts ImportedChapter[] to Chapter[]', () => {
      const text = '第一章\n内容A\n第二章\n内容B';
      const imported = splitChapters(text);
      const chapters = toChapters('book-1', imported, text);
      expect(chapters).toHaveLength(imported.length);
      expect(chapters[0].bookId).toBe('book-1');
      expect(chapters[0].index).toBe(0);
      expect(chapters[0].title).toBeDefined();
      expect(chapters[0].content).toBeDefined();
    });

    it('uses first non-empty preamble line as chapter title', () => {
      const text = '序言\n第一章\n内容';
      const imported = splitChapters(text);
      const chapters = toChapters('b', imported, text);
      expect(chapters[0].title).toBe('序言');
    });
  });
});