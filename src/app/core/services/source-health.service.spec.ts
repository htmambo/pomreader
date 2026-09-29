/**
 * SourceHealthService 单元测试（JSON 规则书源版）
 *
 * 语义（书源 JSON 化方案 §5）：detectCapabilities = JSON 合法性 + BookSourceDocSchema
 * 校验（含 7 必填规则非空），全过 → 四入口能力；任一失败 → []。
 * mock window.pomAPI.booksourceRead；不依赖 Angular TestBed（项目 vitest 直实例化模式）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SourceHealthService } from './source-health.service';
import { BookSourceMeta } from '../book-source/source-meta.types';

const VALID_DOC = JSON.stringify({
  format: 'pomreader.booksource',
  schemaVersion: 1,
  uuid: 's0.json',
  name: 'S0',
  homepage: 'https://example.com',
  urls: ['https://example.com'],
  enabled: true,
  sourceType: 'novel',
  tags: [],
  minDelayMs: 0,
  requireUrls: [],
  headers: {},
  rules: {
    siteName: 'S0',
    searchPath: '/search?keyword={keyword}',
    searchItemPattern: 'css:dd',
    bookTitlePattern: 'css:h1',
    bookAuthorPattern: 'css:.a',
    chapterItemPattern: 'css:#list a',
    contentPattern: 'css:#content',
  },
});

function installPomApi(impl?: (fn: string) => Promise<string>): void {
  const w = window as unknown as {
    pomAPI?: { booksourceRead: (fn: string) => Promise<string> };
  };
  w.pomAPI = { booksourceRead: vi.fn(impl ?? (async () => VALID_DOC)) };
}

function makeMeta(i: number): BookSourceMeta {
  return {
    sourceKey: `s${i}`,
    uuid: `s${i}`,
    fileName: `s${i}.json`,
    name: `S${i}`,
    url: '',
    urls: [],
    enabled: true,
    fileSize: 0,
    modifiedAt: 0,
    sourceDir: '',
    sourceType: 'novel',
    version: '1',
    tags: [],
    minDelayMs: 0,
    requireUrls: [],
  };
}

describe('SourceHealthService', () => {
  beforeEach(() => installPomApi());

  it('合法 JSON 书源 → 四入口能力全开', async () => {
    const svc = new SourceHealthService();
    const caps = await svc.detectCapabilities('s0.json');
    expect(caps).toEqual(['search', 'bookInfo', 'chapterList', 'chapterContent']);
  });

  it('JSON 非法 → 空能力', async () => {
    installPomApi(async () => '{broken');
    const svc = new SourceHealthService();
    expect(await svc.detectCapabilities('bad.json')).toEqual([]);
  });

  it('schema 不过（必填规则为空）→ 空能力', async () => {
    const doc = JSON.parse(VALID_DOC);
    doc.rules.contentPattern = '';
    installPomApi(async () => JSON.stringify(doc));
    const svc = new SourceHealthService();
    expect(await svc.detectCapabilities('invalid.json')).toEqual([]);
  });

  it('detectBatch 12 书源全部完成（5 并发）', async () => {
    const svc = new SourceHealthService();
    const metas = Array.from({ length: 12 }, (_, i) => makeMeta(i));
    const reports = await svc.detectBatch(metas);
    expect(reports.size).toBe(12);
    expect(reports.get('s5.json')?.capabilities).toContain('search');
  });

  it('detectBatch 单书源失败不影响其他', async () => {
    installPomApi(async (fn) => {
      if (fn === 's2.json') throw new Error('read fail');
      return VALID_DOC;
    });
    const svc = new SourceHealthService();
    const reports = await svc.detectBatch([makeMeta(0), makeMeta(1), makeMeta(2)]);
    expect(reports.size).toBe(3);
    expect(reports.get('s0.json')?.sample?.ok).toBe(true);
    expect(reports.get('s2.json')?.capabilities).toEqual([]);
  });

  it('detectCapabilities 缺失 booksourceRead 返回空数组', async () => {
    (window as unknown as { pomAPI?: unknown }).pomAPI = {};
    const svc = new SourceHealthService();
    expect(await svc.detectCapabilities('x.json')).toEqual([]);
  });

  it('sampleTest 不触发网络（v1 占位）', async () => {
    const svc = new SourceHealthService();
    const r = await svc.sampleTest(makeMeta(0));
    expect(r.ok).toBe(true);
    expect(r.durationMs).toBe(0);
  });
});
