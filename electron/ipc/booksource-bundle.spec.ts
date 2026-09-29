import { describe, it, expect } from 'vitest';
import {
  BUNDLE_FORMAT,
  BUNDLE_MAX_BYTES,
  CONTENT_MAX_BYTES,
  buildBundle,
  diffBundle,
  parseBundle,
  serializeBundle,
  sha256,
  BundleSourceEntry,
} from './booksource-bundle';

/**
 * booksource-bundle spec — 纯函数内核（设计 §4/§5.3）
 *
 * 覆盖：编解码往返；parseBundle 整体拒绝（未知 format / 缺字段 / content 结构非法 /
 * 超单条 2MB / 超总 20MB / 恶意 fileName）；diffBundle 五类判定（new/identical/
 * update/conflict）、uuid 优先匹配、fileName 兜底、baseline hash 变化触发 conflict
 */

function makeDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: 'pomreader.booksource',
    schemaVersion: 1,
    uuid: 'uuid-a',
    name: '源A',
    homepage: 'https://example.com/',
    urls: ['https://example.com/'],
    enabled: true,
    sourceType: 'novel',
    rules: {
      siteName: '源A',
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

function makeContent(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify(makeDoc(overrides));
}

function makeBundleText(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    format: BUNDLE_FORMAT,
    version: 1,
    exportedAt: 1789000000000,
    app: '1.0.0',
    sources: [{ uuid: 'uuid-a', fileName: 'a.json', content: makeContent() }],
    ...overrides,
  });
}

describe('buildBundle / parseBundle 编解码往返', () => {
  it('build → serialize → parse 应逐字节还原 content 并推导 uuid', () => {
    const items = [
      { fileName: 'a.json', content: makeContent() },
      { fileName: 'b.json', content: makeContent({ uuid: 'uuid-b', enabled: false }) },
    ];
    const bundle = buildBundle(items, { app: '1.0.0', exportedAt: 1789000000000 });
    expect(bundle.sources.map((s) => s.uuid)).toEqual(['uuid-a', 'uuid-b']);

    const parsed = parseBundle(serializeBundle(bundle));
    expect(parsed.format).toBe(BUNDLE_FORMAT);
    expect(parsed.version).toBe(1);
    expect(parsed.exportedAt).toBe(1789000000000);
    expect(parsed.app).toBe('1.0.0');
    expect(parsed.sources).toHaveLength(2);
    expect(parsed.sources[1].content).toBe(items[1].content);
    expect(JSON.parse(parsed.sources[1].content).enabled).toBe(false);
  });

  it('doc 缺 uuid 时 uuid 回退带扩展名文件名（foo.json）', () => {
    const doc = makeDoc();
    delete doc.uuid;
    const bundle = buildBundle([{ fileName: 'foo.json', content: JSON.stringify(doc) }]);
    expect(bundle.sources[0].uuid).toBe('foo.json');
    const parsed = parseBundle(serializeBundle(bundle));
    expect(parsed.sources[0].uuid).toBe('foo.json');
  });

  it('buildBundle 对非法条目同样抛错（与 parse 同口径）', () => {
    expect(() => buildBundle([{ fileName: '../evil.json', content: makeContent() }])).toThrow(
      /非法 fileName/,
    );
  });
});

describe('parseBundle 整体拒绝（§4.3）', () => {
  it('拒绝未知 format', () => {
    expect(() => parseBundle(makeBundleText({ format: 'other.bundle' }))).toThrow(/未知 format/);
  });

  it('拒绝非 1 的 version', () => {
    expect(() => parseBundle(makeBundleText({ version: 2 }))).toThrow(/version/);
  });

  it('拒绝缺字段（exportedAt / app / sources）', () => {
    expect(() => parseBundle(makeBundleText({ exportedAt: 'now' }))).toThrow(/exportedAt/);
    expect(() => parseBundle(makeBundleText({ app: 1 }))).toThrow(/app/);
    expect(() => parseBundle(makeBundleText({ sources: {} }))).toThrow(/sources/);
    const noSources = JSON.parse(makeBundleText());
    delete noSources.sources;
    expect(() => parseBundle(JSON.stringify(noSources))).toThrow(/sources/);
  });

  it('拒绝非 JSON / 非对象', () => {
    expect(() => parseBundle('not json {')).toThrow(/JSON 解析失败/);
    expect(() => parseBundle('42')).toThrow(/不是 JSON 对象/);
  });

  it('拒绝 content 结构非法（BookSourceDoc 探针不过）', () => {
    const bad = makeContent({ sourceType: 'bogus' });
    expect(() =>
      parseBundle(makeBundleText({ sources: [{ fileName: 'a.json', content: bad }] })),
    ).toThrow(/结构非法.*sourceType/);
  });

  it('拒绝 content 非 JSON', () => {
    expect(() =>
      parseBundle(makeBundleText({ sources: [{ fileName: 'a.json', content: '{{{' }] })),
    ).toThrow(/JSON 解析失败/);
  });

  it('拒绝单条 content 超 2MB', () => {
    const big = makeContent({ description: 'x'.repeat(CONTENT_MAX_BYTES) });
    expect(() =>
      parseBundle(makeBundleText({ sources: [{ fileName: 'big.json', content: big }] })),
    ).toThrow(/2MB/);
  });

  it('拒绝整包超 20MB（检查先于 JSON 解析）', () => {
    const huge = ' '.repeat(BUNDLE_MAX_BYTES + 1);
    expect(() => parseBundle(huge)).toThrow(/20MB/);
  });

  it('拒绝恶意 fileName（../x.json 路径穿越）', () => {
    expect(() =>
      parseBundle(makeBundleText({ sources: [{ fileName: '../x.json', content: makeContent() }] })),
    ).toThrow(/非法 fileName/);
  });

  it('拒绝非 .json fileName', () => {
    expect(() =>
      parseBundle(makeBundleText({ sources: [{ fileName: 'a.js', content: makeContent() }] })),
    ).toThrow(/非法 fileName/);
  });
});

describe('diffBundle 分类（§5.3）', () => {
  const localA: BundleSourceEntry = {
    uuid: 'uuid-a',
    fileName: 'a.json',
    content: makeContent(),
  };
  const incSame: BundleSourceEntry = { ...localA };
  const incChanged: BundleSourceEntry = {
    uuid: 'uuid-a',
    fileName: 'a.json',
    content: makeContent({ name: '源A改' }),
  };

  it('new：无本地匹配项', () => {
    const inc: BundleSourceEntry = {
      uuid: 'uuid-new',
      fileName: 'new.json',
      content: makeContent({ uuid: 'uuid-new' }),
    };
    const [e] = diffBundle([inc], [localA]);
    expect(e.kind).toBe('new');
    expect(e.matchedFileName).toBeNull();
    expect(e.content).toBe(inc.content);
  });

  it('identical：content 逐字节相同', () => {
    const [e] = diffBundle([incSame], [localA]);
    expect(e.kind).toBe('identical');
    expect(e.matchedFileName).toBe('a.json');
  });

  it('update：同源 content 不同、无 baseline', () => {
    const [e] = diffBundle([incChanged], [localA]);
    expect(e.kind).toBe('update');
  });

  it('uuid 优先匹配：incoming 改了 fileName 仍认作同一源', () => {
    const inc: BundleSourceEntry = { ...incChanged, fileName: 'renamed.json' };
    const [e] = diffBundle([inc], [localA]);
    expect(e.kind).toBe('update');
    expect(e.matchedFileName).toBe('a.json');
  });

  it('fileName 兜底：uuid 不同但 fileName 相同 → 匹配', () => {
    const inc: BundleSourceEntry = {
      uuid: 'uuid-other',
      fileName: 'a.json',
      content: makeContent({ uuid: 'uuid-other', name: '别的源' }),
    };
    const [e] = diffBundle([inc], [localA]);
    expect(e.kind).toBe('update');
    expect(e.matchedFileName).toBe('a.json');
  });

  it('conflict：带 baseline 且远端 hash ≠ applied[uuid]', () => {
    const baseline = { 'uuid-a': sha256(makeContent({ name: '上次订阅写入的版本' })) };
    const [e] = diffBundle([incChanged], [localA], baseline);
    expect(e.kind).toBe('conflict');
  });

  it('带 baseline 但远端 hash == applied[uuid] → update（本地未改可安全覆盖）', () => {
    const baseline = { 'uuid-a': sha256(incChanged.content) };
    const [e] = diffBundle([incChanged], [localA], baseline);
    expect(e.kind).toBe('update');
  });

  it('baseline 中无此 uuid → update（无基线按 §6.2 末条处理）', () => {
    const [e] = diffBundle([incChanged], [localA], { 'uuid-x': 'deadbeef' });
    expect(e.kind).toBe('update');
  });

  it('本地导入不传 baseline → 永不产 conflict', () => {
    const entries = diffBundle([incSame, incChanged], [localA]);
    expect(entries.map((e) => e.kind)).toEqual(['identical', 'update']);
  });
});
