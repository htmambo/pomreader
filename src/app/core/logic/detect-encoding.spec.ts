import { describe, it, expect } from 'vitest';
import iconv from 'iconv-lite';
import { decodeTxtBuffer } from './detect-encoding';

const SAMPLE = '第一章 风起\n这是一段正文。';

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

describe('detect-encoding', () => {
  it('auto: decodes plain UTF-8 as utf-8', () => {
    const buf = toArrayBuffer(Buffer.from(SAMPLE, 'utf-8'));
    const r = decodeTxtBuffer(buf, 'auto');
    expect(r.encoding).toBe('utf-8');
    expect(r.text).toBe(SAMPLE);
  });

  it('auto: decodes GBK bytes as gb18030', () => {
    const buf = toArrayBuffer(iconv.encode(SAMPLE, 'gbk'));
    const r = decodeTxtBuffer(buf, 'auto');
    expect(r.encoding).toBe('gb18030');
    expect(r.text).toBe(SAMPLE);
  });

  it('auto: GB2312 content is covered by gb18030 fallback', () => {
    const buf = toArrayBuffer(iconv.encode(SAMPLE, 'gb2312'));
    const r = decodeTxtBuffer(buf, 'auto');
    expect(r.encoding).toBe('gb18030');
    expect(r.text).toBe(SAMPLE);
  });

  it('auto: UTF-8 BOM wins over content sniffing', () => {
    const buf = toArrayBuffer(
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(SAMPLE, 'utf-8')]),
    );
    const r = decodeTxtBuffer(buf, 'auto');
    expect(r.encoding).toBe('utf-8');
    expect(r.text).toBe(SAMPLE);
  });

  it('auto: UTF-16LE BOM decodes as utf-16le', () => {
    const body = Buffer.from(SAMPLE, 'utf16le');
    const buf = toArrayBuffer(Buffer.concat([Buffer.from([0xff, 0xfe]), body]));
    const r = decodeTxtBuffer(buf, 'auto');
    expect(r.encoding).toBe('utf-16le');
    expect(r.text).toBe(SAMPLE);
  });

  it('auto: BOM-less UTF-16LE ascii text detected via NUL distribution', () => {
    const ascii = 'Chapter 1\nhello world, this is a fairly long ascii paragraph.\n';
    const buf = toArrayBuffer(Buffer.from(ascii, 'utf16le'));
    const r = decodeTxtBuffer(buf, 'auto');
    expect(r.encoding).toBe('utf-16le');
    expect(r.text).toBe(ascii);
  });

  it('auto: BOM-less UTF-16BE ascii text detected via NUL distribution', () => {
    const ascii = 'Chapter 1\nhello world, this is a fairly long ascii paragraph.\n';
    const le = Buffer.from(ascii, 'utf16le');
    const be = Buffer.alloc(le.length);
    for (let i = 0; i < le.length; i += 2) {
      be[i] = le[i + 1];
      be[i + 1] = le[i];
    }
    const r = decodeTxtBuffer(toArrayBuffer(be), 'auto');
    expect(r.encoding).toBe('utf-16be');
    expect(r.text).toBe(ascii);
  });

  it('auto: BOM-less UTF-16LE mixed CJK+ascii detected at low NUL ratio', () => {
    const mixed = '第1章 风起 abc def ghi jkl mno pqr stu vwx yz\n正文开始 hello world foo bar\n';
    const buf = toArrayBuffer(Buffer.from(mixed, 'utf16le'));
    const r = decodeTxtBuffer(buf, 'auto');
    expect(r.encoding).toBe('utf-16le');
    expect(r.text).toBe(mixed);
  });

  it('auto: UTF-32LE BOM is not misdetected as utf-16le', () => {
    const buf = toArrayBuffer(Buffer.from([0xff, 0xfe, 0x00, 0x00, 0x41, 0x00, 0x00, 0x00]));
    const r = decodeTxtBuffer(buf, 'auto');
    expect(r.encoding).not.toBe('utf-16le');
  });

  it('mode gbk: decodes GBK bytes regardless of detection', () => {
    const buf = toArrayBuffer(iconv.encode(SAMPLE, 'gbk'));
    const r = decodeTxtBuffer(buf, 'gbk');
    expect(r.encoding).toBe('gb18030');
    expect(r.text).toBe(SAMPLE);
  });

  it('mode gbk: strips UTF-8 BOM like utf-8 mode does', () => {
    const buf = toArrayBuffer(
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), iconv.encode(SAMPLE, 'gbk')]),
    );
    const r = decodeTxtBuffer(buf, 'gbk');
    expect(r.text).toBe(SAMPLE);
  });

  it('mode utf-8: decodes without throwing even on GBK bytes (mojibake visible to user)', () => {
    const buf = toArrayBuffer(iconv.encode(SAMPLE, 'gbk'));
    const r = decodeTxtBuffer(buf, 'utf-8');
    expect(r.encoding).toBe('utf-8');
    expect(r.text).not.toBe(SAMPLE);
  });

  it('auto: ascii-only bytes decode as utf-8', () => {
    const buf = toArrayBuffer(Buffer.from('Chapter 1\nhello world', 'ascii'));
    const r = decodeTxtBuffer(buf, 'auto');
    expect(r.encoding).toBe('utf-8');
    expect(r.text).toBe('Chapter 1\nhello world');
  });

  it('auto: empty buffer decodes as empty utf-8', () => {
    const r = decodeTxtBuffer(new ArrayBuffer(0), 'auto');
    expect(r.encoding).toBe('utf-8');
    expect(r.text).toBe('');
  });
});
