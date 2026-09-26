/**
 * Legado JSON 解析测试
 *
 * 覆盖：
 *  - 单源 JSON 对象 → 包成 1 元素数组
 *  - 多源 JSON 数组 → 原样
 *  - base64(JSON 字符串) → 解码 + 解析
 *  - dataURL 前缀 `data:application/json;base64,...` → 剥前缀 + 解码
 *  - 坏 JSON + 非 base64 → 抛错
 *  - 空对象 → 字段兜底
 */
import { describe, it, expect } from 'vitest';
import { parseLegadoText, mapLegadoSourceType } from './legado-parser';

describe('parseLegadoText', () => {
  it('单源 JSON 对象 → 1 元素数组', () => {
    const out = parseLegadoText(
      JSON.stringify({
        bookSourceName: 'Test',
        bookSourceUrl: 'https://example.com',
        bookSourceType: 0,
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0].bookSourceName).toBe('Test');
    expect(out[0].bookSourceUrl).toBe('https://example.com');
    expect(out[0].bookSourceType).toBe(0);
  });

  it('多源 JSON 数组 → 原样', () => {
    const out = parseLegadoText(
      JSON.stringify([
        { bookSourceName: 'A', bookSourceUrl: 'https://a.com', bookSourceType: 0 },
        { bookSourceName: 'B', bookSourceUrl: 'https://b.com', bookSourceType: 1 },
      ]),
    );
    expect(out).toHaveLength(2);
    expect(out[0].bookSourceName).toBe('A');
    expect(out[1].bookSourceType).toBe(1);
  });

  it('base64 编码的 JSON 字符串 → 解码 + 解析', () => {
    const inner = JSON.stringify({ bookSourceName: 'B64', bookSourceUrl: 'https://x.com', bookSourceType: 0 });
    const b64 = btoa(unescape(encodeURIComponent(inner)));
    const out = parseLegadoText(b64);
    expect(out).toHaveLength(1);
    expect(out[0].bookSourceName).toBe('B64');
  });

  it('dataURL 前缀的 base64 → 剥前缀 + 解码', () => {
    const inner = JSON.stringify({ bookSourceName: 'D', bookSourceUrl: 'https://d.com', bookSourceType: 0 });
    const b64 = btoa(unescape(encodeURIComponent(inner)));
    const out = parseLegadoText(`data:application/json;base64,${b64}`);
    expect(out).toHaveLength(1);
    expect(out[0].bookSourceName).toBe('D');
  });

  it('坏 JSON → 抛错且 message 含原始片段', () => {
    expect(() => parseLegadoText('{ not valid')).toThrow(/Legado 文本/);
  });

  it('非 JSON + 非 base64 → 抛错', () => {
    expect(() => parseLegadoText('!!!not base64 or json!!!')).toThrow(/Legado 文本/);
  });

  it('空对象 → 字段兜底', () => {
    const out = parseLegadoText('{}');
    expect(out).toHaveLength(1);
    expect(out[0].bookSourceName).toBe('');
    expect(out[0].bookSourceUrl).toBe('');
    expect(out[0].bookSourceType).toBe(0);
  });

  it('ruleSearch 字符串字段保留', () => {
    const out = parseLegadoText(
      JSON.stringify({
        bookSourceName: 'R',
        bookSourceUrl: 'https://r.com',
        bookSourceType: 0,
        ruleSearch: { bookList: '.result-list', name: '.title', author: '.author' },
      }),
    );
    expect(out[0].ruleSearch).toEqual({
      bookList: '.result-list',
      name: '.title',
      author: '.author',
    });
  });

  it('ruleSearch 含非字符串字段（如数字） → 仅保留字符串字段', () => {
    const out = parseLegadoText(
      JSON.stringify({
        bookSourceName: 'M',
        bookSourceUrl: 'https://m.com',
        bookSourceType: 0,
        ruleSearch: { bookList: '.x', bad: 123, also: null },
      }),
    );
    expect(out[0].ruleSearch).toEqual({ bookList: '.x' });
  });

  it('数组项不是 plain object → 跳过', () => {
    const out = parseLegadoText(
      JSON.stringify([
        { bookSourceName: 'A', bookSourceUrl: 'https://a.com', bookSourceType: 0 },
        'not an object',
        null,
        42,
        { bookSourceName: 'B', bookSourceUrl: 'https://b.com', bookSourceType: 0 },
      ]),
    );
    expect(out).toHaveLength(2);
    expect(out[0].bookSourceName).toBe('A');
    expect(out[1].bookSourceName).toBe('B');
  });

  it('空文本 → 抛错', () => {
    expect(() => parseLegadoText('   ')).toThrow(/为空/);
  });
});

describe('mapLegadoSourceType', () => {
  it('已知 type 映射正确', () => {
    expect(mapLegadoSourceType(0)).toBe('novel');
    expect(mapLegadoSourceType(1)).toBe('music');
    expect(mapLegadoSourceType(2)).toBe('video');
    expect(mapLegadoSourceType(3)).toBe('comic');
    expect(mapLegadoSourceType(4)).toBe('webpage');
  });

  it('未知 type → novel 兜底', () => {
    expect(mapLegadoSourceType(99)).toBe('novel');
    expect(mapLegadoSourceType(undefined)).toBe('novel');
  });
});
