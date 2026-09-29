/**
 * JSON 书源元数据解析 / 目录扫描单测（书源 JSON 规则化 P2.1）
 *
 * 覆盖 `booksource-meta.ts` 的 JSON 侧：信封校验、uuid/name 回退、坏文件仍进列表、
 * 与 `.js` 合并扫描、启停语义在两种后缀上的分派。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  JSON_SOURCE_FORMAT,
  isJsonSourceName,
  isJsSourceName,
  jsonEnvelopeError,
  parseJsonMeta,
  safeFileName,
  scanAllSources,
  scanDir,
  scanJsonDir,
} from './booksource-meta';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-json-meta-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function validDoc(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    format: JSON_SOURCE_FORMAT,
    schemaVersion: 1,
    uuid: 'uuid-abc',
    name: '示例源',
    homepage: 'https://example.com',
    urls: ['https://example.com', 'https://mirror.example.com'],
    enabled: true,
    sourceType: 'novel',
    rules: {
      siteName: '示例站点',
      searchPath: '/s?q={keyword}',
      searchItemPattern: 'ul.list li',
      bookTitlePattern: 'h1',
      bookAuthorPattern: 'css:.author',
      chapterItemPattern: 'ul.c a',
      contentPattern: 'div#content',
    },
    ...overrides,
  });
}

describe('jsonEnvelopeError —— 信封级校验（不是 valibot schema，见 D8）', () => {
  it('合法文档返回 null', () => {
    expect(jsonEnvelopeError(JSON.parse(validDoc()))).toBeNull();
  });

  it.each([
    ['顶层不是对象', '[]'],
    ['format 不对', JSON.stringify({ ...JSON.parse(validDoc()), format: 'legado' })],
    ['schemaVersion 不支持', JSON.stringify({ ...JSON.parse(validDoc()), schemaVersion: 2 })],
    ['uuid 缺失', JSON.stringify({ ...JSON.parse(validDoc()), uuid: '' })],
    ['homepage 缺失', JSON.stringify({ ...JSON.parse(validDoc()), homepage: undefined })],
    ['rules 不是对象', JSON.stringify({ ...JSON.parse(validDoc()), rules: [] })],
  ])('%s → 有错误原因', (_label, raw) => {
    expect(jsonEnvelopeError(JSON.parse(raw))).toBeTruthy();
  });

  it('rules 缺任一必需键都报错，且指出是哪个键', () => {
    const doc = JSON.parse(validDoc());
    delete doc.rules.contentPattern;
    expect(jsonEnvelopeError(doc)).toContain('rules.contentPattern');
  });

  it('未知字段不报错（信封粗筛，不是全量 schema）', () => {
    const doc = {
      ...JSON.parse(validDoc()),
      未来字段: 1,
      rules: { ...JSON.parse(validDoc()).rules, 未来规则: 'x' },
    };
    expect(jsonEnvelopeError(doc)).toBeNull();
  });
});

describe('parseJsonMeta —— 输出形状必须与 parseHeaderMeta 一致', () => {
  it('字段齐全：渲染端 BookSourceMeta 消费方不改一行', () => {
    const meta = parseJsonMeta(validDoc(), 'a.json', dir, 100, 200);
    for (const key of [
      'sourceKey',
      'uuid',
      'fileName',
      'name',
      'url',
      'urls',
      'enabled',
      'fileSize',
      'modifiedAt',
      'sourceDir',
      'sourceType',
      'version',
      'tags',
      'minDelayMs',
      'requireUrls',
    ]) {
      expect(meta, `缺字段 ${key}`).toHaveProperty(key);
    }
    expect(meta.format).toBe('json');
    expect(meta.rulesInvalid).toBeNull();
  });

  it('url = urls[0]，urls 全量保留（多镜像）', () => {
    const meta = parseJsonMeta(validDoc(), 'a.json', dir, 1, 1);
    expect(meta.url).toBe('https://example.com');
    expect(meta.urls).toEqual(['https://example.com', 'https://mirror.example.com']);
  });

  it('enabled: false 映射为 false（缺省才 true）', () => {
    expect(parseJsonMeta(validDoc({ enabled: false }), 'a.json', dir, 1, 1).enabled).toBe(false);
    expect(parseJsonMeta(validDoc(), 'a.json', dir, 1, 1).enabled).toBe(true);
  });

  it('sourceType 非法降级 novel（与 parseHeaderMeta 同语义）', () => {
    expect(parseJsonMeta(validDoc({ sourceType: 'hentai' }), 'a.json', dir, 1, 1).sourceType).toBe(
      'novel',
    );
    expect(parseJsonMeta(validDoc({ sourceType: 'comic' }), 'a.json', dir, 1, 1).sourceType).toBe(
      'comic',
    );
  });
});

describe('uuid / name 回退方向相反（与 parseHeaderMeta:142-150 同构）', () => {
  it('uuid 缺席 → 回退 fileName 且**保留扩展名**（命名空间）', () => {
    const doc = JSON.parse(validDoc());
    delete doc.uuid;
    const meta = parseJsonMeta(JSON.stringify(doc), 'my-source.json', dir, 1, 1);
    expect(meta.uuid).toBe('my-source.json');
    expect(meta.sourceKey).toBe('my-source.json');
  });

  it('name 缺席 → 回退 fileName 但**剥掉** .json', () => {
    const doc = JSON.parse(validDoc());
    delete doc.name;
    expect(parseJsonMeta(JSON.stringify(doc), 'my-source.json', dir, 1, 1).name).toBe('my-source');
  });
});

describe('坏文件也必须进列表（否则用户以为书源丢了）', () => {
  it('JSON 语法错 → rulesInvalid 填原因，meta 仍返回', () => {
    const meta = parseJsonMeta('{ not json', 'broken.json', dir, 10, 1);
    expect(meta.rulesInvalid).toContain('JSON 解析失败');
    expect(meta.fileName).toBe('broken.json');
    expect(meta.format).toBe('json');
  });

  it('信封不过 → rulesInvalid 填原因，uuid 退回 fileName（key 仍可用于 delete/toggle）', () => {
    const meta = parseJsonMeta(JSON.stringify({ format: 'x' }), 'weird.json', dir, 10, 1);
    expect(meta.rulesInvalid).toBeTruthy();
    expect(meta.uuid).toBe('weird.json');
  });
});

describe('scanJsonDir / scanAllSources', () => {
  it('只收 .json，忽略 .js 与其他后缀', () => {
    fs.writeFileSync(path.join(dir, 'a.json'), validDoc());
    fs.writeFileSync(path.join(dir, 'b.js'), '// @name 老源\n');
    fs.writeFileSync(path.join(dir, 'c.txt'), 'x');
    const items = scanJsonDir(dir);
    expect(items).toHaveLength(1);
    expect(items[0].fileName).toBe('a.json');
  });

  it('按 fileName 排序', () => {
    fs.writeFileSync(path.join(dir, 'b.json'), validDoc());
    fs.writeFileSync(path.join(dir, 'a.json'), validDoc());
    expect(scanJsonDir(dir).map((m) => m.fileName)).toEqual(['a.json', 'b.json']);
  });

  it('目录不存在返回空数组（不抛）', () => {
    expect(scanJsonDir(path.join(dir, 'nope'))).toEqual([]);
  });

  it('scanAllSources 合并两种后缀且统一排序', () => {
    fs.writeFileSync(path.join(dir, 'z.js'), '// @name 老的\n');
    fs.writeFileSync(path.join(dir, 'a.json'), validDoc());
    fs.writeFileSync(path.join(dir, 'm.js'), '// @name 中间的\n');
    expect(scanAllSources(dir).map((m) => m.fileName)).toEqual(['a.json', 'm.js', 'z.js']);
  });

  it('.js 侧仍走 marker 覆盖 enabled（不因合并扫描而改语义）', () => {
    fs.writeFileSync(path.join(dir, 'old.js'), '// @name 老的\n');
    fs.writeFileSync(path.join(dir, 'old.js.disabled'), '');
    const meta = scanAllSources(dir).find((m) => m.fileName === 'old.js');
    expect(meta?.enabled).toBe(false);
  });

  it('.json 侧**不**读 marker 文件（启停在文档内，不分家）', () => {
    fs.writeFileSync(path.join(dir, 'a.json'), validDoc());
    fs.writeFileSync(path.join(dir, 'a.json.disabled'), '');
    const meta = scanJsonDir(dir).find((m) => m.fileName === 'a.json');
    expect(meta?.enabled).toBe(true);
  });

  it('scanDir 仍然只收 .js（P4 前保持原语义）', () => {
    fs.writeFileSync(path.join(dir, 'a.json'), validDoc());
    fs.writeFileSync(path.join(dir, 'b.js'), '// @name 老的\n');
    expect(scanDir(dir).map((m) => m.fileName)).toEqual(['b.js']);
  });
});

describe('safeFileName —— 两层防护的共同口径', () => {
  it('常规穿越形态仍被拒（不因放宽而回退）', () => {
    expect(safeFileName('../evil')).toBeNull();
    expect(safeFileName('a/b')).toBeNull();
    expect(safeFileName('a\\b')).toBeNull();
    expect(safeFileName('')).toBeNull();
  });

  it('禁控制字符（新加）：换行 / NUL / DEL 都拒', () => {
    expect(safeFileName('a\nb.json')).toBeNull();
    expect(safeFileName('a\u0000.json')).toBeNull();
    expect(safeFileName('a.json')).toBeNull();
  });

  it('.js 与 .json 在迁移期都放行（收紧留到 P4）', () => {
    expect(safeFileName('a.js')).toBe('a.js');
    expect(safeFileName('a.json')).toBe('a.json');
  });
});

describe('后缀判定', () => {
  it('大小写不敏感', () => {
    expect(isJsonSourceName('a.JSON')).toBe(true);
    expect(isJsSourceName('a.JS')).toBe(true);
    expect(isJsonSourceName('a.js')).toBe(false);
  });

  it('无后缀返回 false', () => {
    expect(isJsonSourceName('plain')).toBe(false);
    expect(isJsSourceName('plain')).toBe(false);
  });
});

describe('baseJsonMeta —— 坏文件与好文件形状必须一致', () => {
  it('坏 JSON 仍带全部键（含 homepage），不是"有时在有时不在"', () => {
    const meta = parseJsonMeta('{ broken', 'a.json', dir, 1, 1);
    // 渲染端会无差别读这些键，缺一个就是 undefined vs '' 的分支差异
    for (const key of ['homepage', 'urls', 'tags', 'requireUrls', 'sourceType', 'minDelayMs']) {
      expect(meta, `坏文件缺字段 ${key}`).toHaveProperty(key);
    }
    expect(meta.homepage).toBe('');
  });

  it('信封不过时形状同样完整', () => {
    const meta = parseJsonMeta(JSON.stringify({ format: 'x' }), 'a.json', dir, 1, 1);
    expect(meta).toHaveProperty('homepage');
    expect(meta).toHaveProperty('tags');
    expect(meta.rulesInvalid).toBeTruthy();
  });

  it('正常文档的键集与 base 相同（不出现"只在这条分支多一个键"）', () => {
    const good = Object.keys(parseJsonMeta(validDoc(), 'a.json', dir, 1, 1)).sort();
    const bad = Object.keys(parseJsonMeta('{ broken', 'a.json', dir, 1, 1)).sort();
    expect(bad).toEqual(good);
  });
});

describe('safeFileName：裸 . 与 ..', () => {
  it('裸 `.` 拒绝（path.join(dir, ".") === dir）', () => {
    expect(safeFileName('.')).toBeNull();
  });

  it('`..` 仍拒（已含在 includes 判定里）', () => {
    expect(safeFileName('..')).toBeNull();
  });

  it('名字里含 `..` 一律拒（刻意的偏严：路径分量语义上不构成穿越，偏严比解释成本低）', () => {
    // `a..b.json` 其实是合法文件名，放行也不会穿越；但守卫既有口径是 `includes('..')`，
    // schema 那侧已按同一口径实现（`^(?!.*\.\.)`）。放宽守卫属于独立的安全变更，不在本次范围。
    expect(safeFileName('a..b.json')).toBeNull();
  });

  it('schema 与运行时口径一致：同一批输入两边都拒', () => {
    // 两侧偏严的方向必须相同，否则 P3.2 接线时会出现"哪层更严"的漂移
    for (const name of ['../x', 'a..b', 'a\nb', '.', 'a/b']) {
      expect(safeFileName(name), name).toBeNull();
    }
  });
});
