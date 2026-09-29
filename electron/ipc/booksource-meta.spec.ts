import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  safeFileName,
  safeJsonFileName,
  atomicWrite,
  scanJsonDir,
  validateBookSourceDocStructure,
} from './booksource-meta';

/**
 * booksource-meta spec — .json 书源扫描 + 工具函数
 *
 * 覆盖：
 * - safeFileName / safeJsonFileName 安全校验（防路径穿越）
 * - atomicWrite 原子写（覆盖失败场景）
 * - scanJsonDir 目录扫描（.json 书源；旧 .js scanDir 已随 P4 删除，
 *   parseHeaderMeta 迁入 booksource-migrate.ts，用例随迁）
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

  it('含控制字符应返回 null（方案 §3.4 追加约束）', () => {
    expect(safeFileName('foo\nbar.js')).toBeNull();
    expect(safeFileName('foo\tbar.js')).toBeNull();
    expect(safeFileName('foo\x00bar.js')).toBeNull();
    expect(safeFileName('\x1f.js')).toBeNull();
  });
});

describe('safeJsonFileName（.json 后缀约束在调用点，不进 safeFileName）', () => {
  it('合法 .json 文件名应原样返回（大小写不敏感）', () => {
    expect(safeJsonFileName('foo.json')).toBe('foo.json');
    expect(safeJsonFileName('foo.JSON')).toBe('foo.JSON');
  });

  it('非 .json 后缀应返回 null', () => {
    expect(safeJsonFileName('foo.js')).toBeNull();
    expect(safeJsonFileName('foo.txt')).toBeNull();
    expect(safeJsonFileName('foo')).toBeNull();
  });

  it('路径穿越 / 控制字符同样拒绝', () => {
    expect(safeJsonFileName('../evil.json')).toBeNull();
    expect(safeJsonFileName('a/b.json')).toBeNull();
    expect(safeJsonFileName('foo\n.json')).toBeNull();
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

/* ── JSON 书源（BookSourceDoc）扫描（方案 §3.4，P2） ────────────────────── */

/** 合法 BookSourceDoc fixture（结构探针 + 必填齐全） */
function makeJsonDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: 'pomreader.booksource',
    schemaVersion: 1,
    uuid: 'uuid-abc',
    name: '测试源',
    author: 'me',
    logo: 'https://example.com/logo.png',
    description: '描述',
    homepage: 'https://example.com/',
    urls: ['https://example.com/', 'https://mirror.example.com/'],
    enabled: true,
    sourceType: 'comic',
    sourceVersion: '1.2.0',
    updateUrl: 'https://example.com/update.json',
    tags: ['小说', '玄幻'],
    minDelayMs: 100,
    requireUrls: ['https://dep.example.com/'],
    headers: { 'User-Agent': 'pom' },
    rules: {
      siteName: '测试源',
      searchPath: '/search',
      searchItemPattern: '.item',
      bookTitlePattern: '.title',
      bookAuthorPattern: '.author',
      chapterItemPattern: '.chapter',
      contentPattern: '.content',
    },
    ...overrides,
  };
}

function writeJson(dir: string, fileName: string, value: unknown): void {
  fs.writeFileSync(path.join(dir, fileName), JSON.stringify(value));
}

describe('validateBookSourceDocStructure（主进程最小结构探针）', () => {
  it('合法 doc 应返回 null', () => {
    expect(validateBookSourceDocStructure(makeJsonDoc())).toBeNull();
  });

  it('schemaVersion 非 1 应拒绝', () => {
    expect(validateBookSourceDocStructure(makeJsonDoc({ schemaVersion: 2 }))).toContain(
      'schemaVersion',
    );
  });

  it('enabled 非 boolean 应拒绝', () => {
    expect(validateBookSourceDocStructure(makeJsonDoc({ enabled: 'true' }))).toContain('enabled');
  });

  it('必填规则为空串应拒绝（指出具体字段）', () => {
    const doc = makeJsonDoc();
    (doc.rules as Record<string, unknown>).contentPattern = '';
    expect(validateBookSourceDocStructure(doc)).toContain('rules.contentPattern');
  });

  it('rules 缺失应拒绝', () => {
    const doc = makeJsonDoc();
    delete doc.rules;
    expect(validateBookSourceDocStructure(doc)).toContain('rules');
  });
});

describe('scanJsonDir（.json 书源扫描）', () => {
  let tmpDir: any;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-json-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('目录不存在应返回空数组', () => {
    expect(scanJsonDir(path.join(tmpDir, 'nonexistent'))).toEqual([]);
  });

  it('正常 doc 应映射出与历史 parseHeaderMeta 同构的 meta 字段', () => {
    writeJson(tmpDir, 'a.json', makeJsonDoc());
    const items = scanJsonDir(tmpDir);
    expect(items).toHaveLength(1);
    const m = items[0];
    expect(m.fileName).toBe('a.json');
    expect(m.uuid).toBe('uuid-abc');
    expect(m.sourceKey).toBe('uuid-abc'); // sourceKey 与 uuid 同源
    expect(m.name).toBe('测试源');
    expect(m.url).toBe('https://example.com/'); // urls[0]
    expect(m.urls).toEqual(['https://example.com/', 'https://mirror.example.com/']);
    expect(m.author).toBe('me');
    expect(m.logo).toBe('https://example.com/logo.png');
    expect(m.description).toBe('描述');
    expect(m.enabled).toBe(true); // 取文档内 enabled
    expect(m.sourceDir).toBe(tmpDir);
    expect(m.sourceType).toBe('comic');
    expect(m.version).toBe('1.2.0'); // ← sourceVersion
    expect(m.updateUrl).toBe('https://example.com/update.json');
    expect(m.tags).toEqual(['小说', '玄幻']);
    expect(m.minDelayMs).toBe(100);
    expect(m.requireUrls).toEqual(['https://dep.example.com/']);
    expect(typeof m.fileSize).toBe('number');
    expect(typeof m.modifiedAt).toBe('number');
    expect(m.rulesInvalid).toBeUndefined();
  });

  it('uuid 缺省应回退为带扩展名的文件名（foo.json，D6 硬约束）', () => {
    const doc = makeJsonDoc();
    delete doc.uuid;
    writeJson(tmpDir, 'foo.json', doc);
    const items = scanJsonDir(tmpDir);
    expect(items[0].uuid).toBe('foo.json');
    expect(items[0].sourceKey).toBe('foo.json');
    expect(items[0].rulesInvalid).toBeUndefined(); // 缺 uuid 不算 invalid
  });

  it('name 缺省应回退为剥掉 .json 的文件名（与 uuid 回退方向相反）', () => {
    const doc = makeJsonDoc();
    delete doc.name;
    writeJson(tmpDir, 'foo.json', doc);
    const items = scanJsonDir(tmpDir);
    expect(items[0].name).toBe('foo');
    expect(items[0].uuid).toBe('uuid-abc'); // uuid 有值，不回退
  });

  it('enabled 应直接取文档字段；.enabled/.disabled marker 不影响 JSON 源', () => {
    writeJson(tmpDir, 'a.json', makeJsonDoc({ enabled: false }));
    fs.writeFileSync(path.join(tmpDir, 'a.json.enabled'), ''); // 残留 marker 应被无视
    const items = scanJsonDir(tmpDir);
    expect(items[0].enabled).toBe(false);
  });

  it('JSON 解析失败：条目仍返回，置 rulesInvalid，enabled=false', () => {
    fs.writeFileSync(path.join(tmpDir, 'broken.json'), '{not valid json');
    const items = scanJsonDir(tmpDir);
    expect(items).toHaveLength(1);
    expect(String(items[0].rulesInvalid)).toContain('JSON 解析失败');
    expect(items[0].enabled).toBe(false);
    expect(items[0].uuid).toBe('broken.json'); // 解析失败也按文件名回退
    expect(items[0].name).toBe('broken');
  });

  it('结构校验失败（缺 homepage）：条目仍返回，置 rulesInvalid', () => {
    const doc = makeJsonDoc({ homepage: '' });
    writeJson(tmpDir, 'nohome.json', doc);
    const items = scanJsonDir(tmpDir);
    expect(items).toHaveLength(1);
    expect(String(items[0].rulesInvalid)).toContain('homepage');
    expect(items[0].enabled).toBe(true); // enabled 按文档值
  });

  it('必填规则为空：条目仍返回，rulesInvalid 指出字段', () => {
    const doc = makeJsonDoc();
    (doc.rules as Record<string, unknown>).searchPath = '';
    writeJson(tmpDir, 'badrule.json', doc);
    const items = scanJsonDir(tmpDir);
    expect(String(items[0].rulesInvalid)).toContain('rules.searchPath');
  });

  it('非书源 .json（format 探针不命中）应跳过，不进列表', () => {
    writeJson(tmpDir, 'migration-report.json', { format: 'pomreader.migration-report', x: 1 });
    writeJson(tmpDir, 'random.json', { hello: 'world' });
    writeJson(tmpDir, 'real.json', makeJsonDoc());
    const items = scanJsonDir(tmpDir);
    expect(items).toHaveLength(1);
    expect(items[0].fileName).toBe('real.json');
  });

  it('只收 .json：.js / marker / 其他扩展名忽略，按 fileName 排序', () => {
    writeJson(tmpDir, 'b.json', makeJsonDoc());
    writeJson(tmpDir, 'a.json', makeJsonDoc());
    fs.writeFileSync(path.join(tmpDir, 'c.js'), '// @name C');
    fs.writeFileSync(path.join(tmpDir, 'a.json.disabled'), '');
    fs.writeFileSync(path.join(tmpDir, 'd.txt'), 'x');
    const items = scanJsonDir(tmpDir);
    expect(items.map((i) => String(i.fileName))).toEqual(['a.json', 'b.json']);
  });
});
