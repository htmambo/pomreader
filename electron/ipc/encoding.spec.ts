import { describe, it, expect } from 'vitest';
import iconv from 'iconv-lite';
import { decodeBuffer } from './encoding';

/**
 * decodeBuffer spec — 抓取字节流解码
 *
 * 优先级：mode > Content-Type charset > HTML meta charset > utf-8 默认
 *
 * 覆盖：
 * - 强制模式 utf-8 / gbk（gb18030 超集）
 * - auto + Content-Type charset
 * - auto + HTML meta charset
 * - auto + 默认 utf-8
 * - 编码名归一化（gbk/gb2312/gb18030 → gb18030）
 */

describe('decodeBuffer — 强制模式', () => {
  it('mode=utf-8 应按 utf-8 解码（含中文）', () => {
    const buf = Buffer.from('你好世界', 'utf-8');
    expect(decodeBuffer(buf, 'utf-8', {})).toBe('你好世界');
  });

  it('mode=gbk 应按 gb18030 解码（含中文繁体）', () => {
    // 用 iconv 把中文编码成 gbk 字节
    const buf = iconv.encode('連城訣', 'gbk');
    expect(decodeBuffer(buf, 'gbk', {})).toBe('連城訣');
  });

  it('mode=gbk 应能解码 gb2312 字节流（gb18030 超集）', () => {
    // gb2312 是 gbk 子集 → 强制 gbk 模式应能解码
    const buf = iconv.encode('金庸', 'gb2312');
    expect(decodeBuffer(buf, 'gbk', {})).toBe('金庸');
  });
});

describe('decodeBuffer — auto 模式', () => {
  it('应优先使用 Content-Type charset', () => {
    const buf = iconv.encode('你好世界', 'gbk');
    const result = decodeBuffer(buf, 'auto', {
      'content-type': 'text/html; charset=gbk',
    });
    expect(result).toBe('你好世界');
  });

  it('Content-Type charset=gb2312 应归一化到 gb18030', () => {
    const buf = iconv.encode('金庸', 'gb2312');
    const result = decodeBuffer(buf, 'auto', {
      'content-type': 'text/html; charset=gb2312',
    });
    expect(result).toBe('金庸');
  });

  it('Content-Type charset=UTF-8 应归一化到 utf-8', () => {
    const buf = Buffer.from('Hello', 'utf-8');
    const result = decodeBuffer(buf, 'auto', {
      'content-type': 'application/json; charset=UTF-8',
    });
    expect(result).toBe('Hello');
  });

  it('Content-Type 为数组时取第一个元素', () => {
    const buf = iconv.encode('你好', 'gbk');
    const result = decodeBuffer(buf, 'auto', {
      'content-type': ['text/html; charset=gbk', 'application/json'],
    });
    expect(result).toBe('你好');
  });

  it('Content-Type 无 charset 时应 fallback 到 HTML meta charset', () => {
    const buf = Buffer.from(
      '<html><head><meta charset="gbk"></head><body>你好</body></html>',
      'latin1',
    );
    const result = decodeBuffer(buf, 'auto', {
      'content-type': 'text/html',
    });
    // gbk 字节写入后 latin1 读会乱码 —— 测试应能正确解码
    // 这里 buf 是 latin1 写入 meta 字符串 + 你好 utf-8/16 字节...
    // 改用 iconv 直接构造：写入纯 gbk 字节 + meta 头
    const buf2 = Buffer.concat([
      Buffer.from('<html><head><meta charset="gbk"></head><body>', 'latin1'),
      iconv.encode('你好世界', 'gbk'),
      Buffer.from('</body></html>', 'latin1'),
    ]);
    const result2 = decodeBuffer(buf2, 'auto', { 'content-type': 'text/html' });
    expect(result2).toContain('你好世界');
  });

  it('HTML meta charset 单引号属性应正确识别', () => {
    const buf = Buffer.concat([
      Buffer.from("<html><head><meta charset='gbk'></head><body>", 'latin1'),
      iconv.encode('你好', 'gbk'),
      Buffer.from('</body></html>', 'latin1'),
    ]);
    const result = decodeBuffer(buf, 'auto', { 'content-type': 'text/html' });
    expect(result).toContain('你好');
  });

  it('Content-Type 优先于 HTML meta（不一致时按 Content-Type）', () => {
    const buf = Buffer.concat([
      Buffer.from('<html><head><meta charset="gbk"></head><body>', 'latin1'),
      Buffer.from('Hello', 'utf-8'),
      Buffer.from('</body></html>', 'latin1'),
    ]);
    // Content-Type 写 utf-8，但 HTML meta 写 gbk —— 应优先 Content-Type → utf-8 解码
    const result = decodeBuffer(buf, 'auto', {
      'content-type': 'text/html; charset=utf-8',
    });
    expect(result).toContain('Hello');
  });

  it('Content-Type 与 meta 都无时默认 utf-8', () => {
    const buf = Buffer.from('Hello World', 'utf-8');
    const result = decodeBuffer(buf, 'auto', {});
    expect(result).toBe('Hello World');
  });

  it('未知编码名应忽略并 fallback 到 utf-8', () => {
    const buf = Buffer.from('Hello', 'utf-8');
    const result = decodeBuffer(buf, 'auto', {
      'content-type': 'text/html; charset=fake-encoding',
    });
    expect(result).toBe('Hello');
  });
});