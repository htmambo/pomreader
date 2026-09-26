import { describe, it, expect } from 'vitest';
import { isImportableUrl } from './auto-import-url';

describe('isImportableUrl', () => {
  it('命中 .txt/.zip/.rar/.7z（大小写不敏感）', () => {
    expect(isImportableUrl('https://x.com/book/斗破苍穹.txt')).toBe(true);
    expect(isImportableUrl('https://x.com/d/123.ZIP')).toBe(true);
    expect(isImportableUrl('http://x.com/a.rar')).toBe(true);
    expect(isImportableUrl('http://x.com/a.7z')).toBe(true);
  });
  it('忽略 query 与 hash', () => {
    expect(isImportableUrl('https://x.com/book.txt?id=1&dl=1')).toBe(true);
    expect(isImportableUrl('https://x.com/book.zip#frag')).toBe(true);
  });
  it('扩展名不在清单或仅在路径中段 → 不命中', () => {
    expect(isImportableUrl('https://x.com/book.pdf')).toBe(false);
    expect(isImportableUrl('https://x.com/txt/reader')).toBe(false);
    expect(isImportableUrl('https://x.com/download.txt.exe')).toBe(false);
    expect(isImportableUrl('https://x.com/')).toBe(false);
  });
});
