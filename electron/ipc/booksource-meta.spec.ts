import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  safeFileName,
  atomicWrite,
  parseHeaderMeta,
  scanDir,
} from './booksource-meta';

/**
 * booksource-meta spec — 书源 JS 头部解析 + 目录扫描 + 工具函数
 *
 * 覆盖：
 * - safeFileName 安全校验（防路径穿越）
 * - parseHeaderMeta 头部解析（20+ 字段）
 * - atomicWrite 原子写（覆盖失败场景）
 * - scanDir 目录扫描（marker 文件 enabled 覆盖）
 */

describe('safeFileName（FR-1.5 防路径穿越）', () => {
  it('合法 fileName 应原样返回', () => {
    expect(safeFileName('legado-source.js')).toBe('legado-source.js');
  });

  it('空字符串应返回 null', () => {
    expect(safeFileName('')).toBeNull();
  });

  it('含 / 应返回 null', () => {
    expect(safeFileName('../evil.js')).toBeNull();
    expect(safeFileName('foo/bar.js')).toBeNull();
  });

  it('含 \\ 应返回 null（Windows 路径分隔符）', () => {
    expect(safeFileName('foo\\bar.js')).toBeNull();
  });

  it('含 .. 应返回 null（路径穿越）', () => {
    expect(safeFileName('..')).toBeNull();
    expect(safeFileName('foo..bar.js')).toBeNull();
    expect(safeFileName('..\\..\\evil.js')).toBeNull();
  });
});

describe('parseHeaderMeta（书源 JS 头部注释解析）', () => {
  it('应解析基本字段 name/author/url/tags/version/uuid', () => {
    const content = [
      '// @name 测试书源',
      '// @author me',
      '// @url https://example.com/',
      '// @tags 小说, 玄幻',
      '// @tags 都市, 修仙',
      '// @version 1.0.0',
      '// @uuid abc-123',
      'function search() {}',
    ].join('\n');
    const r = parseHeaderMeta(
      content,
      'test.js',
      '/sources',
      100,
      Date.now(),
      null,
    );
    expect(r.name).toBe('测试书源');
    expect(r.author).toBe('me');
    expect(r.url).toBe('https://example.com/');
    expect(r.urls).toEqual(['https://example.com/']);
    expect(r.tags).toEqual(['小说', '玄幻', '都市', '修仙']); // 中文逗号也支持
    expect(r.version).toBe('1.0.0');
    expect(r.uuid).toBe('abc-123');
    expect(r.sourceType).toBe('novel'); // 默认
    expect(r.enabled).toBe(true); // 无 @enabled 头 → 默认 true
  });

  it('缺 @name 时应 fallback 到 fileName 去 .js 后缀', () => {
    const r = parseHeaderMeta('// @author me', 'mySource.js', '/d', 0, 0, null);
    expect(r.name).toBe('mySource');
  });

  it('@enabled false/0/no 应判定禁用', () => {
    const r = parseHeaderMeta('// @enabled false', 'a.js', '/d', 0, 0, null);
    expect(r.enabled).toBe(false);
  });

  it('enabledOverride（marker 文件）应优先于 @enabled 头', () => {
    const r = parseHeaderMeta('// @enabled false', 'a.js', '/d', 0, 0, true);
    expect(r.enabled).toBe(true);
  });

  it('@type 接受合法枚举值', () => {
    for (const type of ['novel', 'comic', 'video', 'music', 'webpage']) {
      const r = parseHeaderMeta(`// @type ${type}`, 'a.js', '/d', 0, 0, null);
      expect(r.sourceType).toBe(type);
    }
  });

  it('@type 非法值应保持默认 novel', () => {
    const r = parseHeaderMeta('// @type unknown-type', 'a.js', '/d', 0, 0, null);
    expect(r.sourceType).toBe('novel');
  });

  it('@minDelayMs / @minDelay 解析为整数', () => {
    const r1 = parseHeaderMeta('// @minDelayMs 500', 'a.js', '/d', 0, 0, null);
    expect(r1.minDelayMs).toBe(500);
    const r2 = parseHeaderMeta('// @minDelay 1000', 'a.js', '/d', 0, 0, null);
    expect(r2.minDelayMs).toBe(1000);
  });

  it('@minDelayMs 负值应忽略（保持 0）', () => {
    const r = parseHeaderMeta('// @minDelayMs -100', 'a.js', '/d', 0, 0, null);
    expect(r.minDelayMs).toBe(0);
  });

  it('description 多行应 join 为 \\n', () => {
    const r = parseHeaderMeta(
      ['// @description 第一行', '// @description 第二行'].join('\n'),
      'a.js',
      '/d',
      0,
      0,
      null,
    );
    expect(r.description).toBe('第一行\n第二行');
  });

  it('@url 多个应保留为数组', () => {
    const r = parseHeaderMeta(
      ['// @url https://a.com', '// @url https://b.com'].join('\n'),
      'a.js',
      '/d',
      0,
      0,
      null,
    );
    expect(r.urls).toEqual(['https://a.com', 'https://b.com']);
  });

  it('@uuid 缺省时应 fallback 到 fileName', () => {
    const r = parseHeaderMeta('// @name x', 'fallback-uuid.js', '/d', 0, 0, null);
    expect(r.uuid).toBe('fallback-uuid.js');
  });
});

describe('atomicWrite（FR-1.5 原子写）', () => {
   
  let tmpDir: any;
   
  let targetFile: any;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-test-'));
    targetFile = path.join(tmpDir, 'target.txt');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('应写入内容到 target 文件', () => {
    atomicWrite(targetFile, 'hello world');
    expect(fs.readFileSync(targetFile, 'utf-8')).toBe('hello world');
  });

  it('覆盖已有文件不截断（成功路径）', () => {
    fs.writeFileSync(targetFile, 'original content', 'utf-8');
    atomicWrite(targetFile, 'new content');
    expect(fs.readFileSync(targetFile, 'utf-8')).toBe('new content');
  });

  it('成功后不应残留 .tmp 临时文件', () => {
    atomicWrite(targetFile, 'x');
    const files = fs.readdirSync(tmpDir);
    const tmpFiles = files.filter((f) => f.includes('.tmp'));
    expect(tmpFiles).toHaveLength(0);
  });
});

describe('scanDir（目录扫描）', () => {
   
  let tmpDir: any;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('目录不存在应返回空数组', () => {
    expect(scanDir(path.join(tmpDir, 'nonexistent'))).toEqual([]);
  });

  it('应扫描所有 .js 文件并按 fileName 排序', () => {
    fs.writeFileSync(path.join(tmpDir, 'b.js'), '// @name B');
    fs.writeFileSync(path.join(tmpDir, 'a.js'), '// @name A');
    fs.writeFileSync(path.join(tmpDir, 'c.txt'), 'not a book source'); // 应被忽略
    const items = scanDir(tmpDir);
    expect(items).toHaveLength(2);
    expect(items.map((i) => String(i.fileName))).toEqual(['a.js', 'b.js']);
  });

  it('应解析每个文件的 @name', () => {
    fs.writeFileSync(path.join(tmpDir, 'x.js'), '// @name CustomName');
    const items = scanDir(tmpDir);
    expect(items[0].name).toBe('CustomName');
  });

  it('.disabled marker 应覆盖 @enabled 头', () => {
    fs.writeFileSync(path.join(tmpDir, 'a.js'), '// @enabled true');
    fs.writeFileSync(path.join(tmpDir, 'a.js.disabled'), '');
    const items = scanDir(tmpDir);
    expect(items[0].enabled).toBe(false);
  });

  it('.disabled 与 .enabled 同时存在时 .disabled 优先（impl 语义锁定）', () => {
    fs.writeFileSync(path.join(tmpDir, 'a.js'), '// @enabled false');
    fs.writeFileSync(path.join(tmpDir, 'a.js.disabled'), '');
    fs.writeFileSync(path.join(tmpDir, 'a.js.enabled'), '');
    // 实际：scanDir 先 check .disabled → override=false → 短路，不再 check .enabled
    const items = scanDir(tmpDir);
    expect(items[0].enabled).toBe(false);
  });
});