/**
 * SourceHealthService 单元测试（实施计划 T-012 + spec FR-1.7）
 *
 * mock SandboxService：直接控制返回 fns；mock window.pomAPI.booksourceRead；
 * 不依赖 Angular TestBed（项目 vitest 直实例化模式）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SourceHealthService } from './source-health.service';
import { BookSourceMeta } from './source-meta.types';

class MockSandbox {
  loadMock = vi.fn();
  /** key = fileName → LoadedModule */
  results = new Map<string, { fileName: string; fns: string[] }>();
  async load(fileName: string, _source: string): Promise<{ fileName: string; fns: string[] }> {
    this.loadMock(fileName);
    const r = this.results.get(fileName);
    if (!r) throw new Error(`mock 未配置：${fileName}`);
    return r;
  }
}

function installPomApi(): void {
  const w = window as unknown as {
    pomAPI?: { booksourceRead: (fn: string) => Promise<string> };
  };
  w.pomAPI = { booksourceRead: vi.fn(async (fn: string) => `// @name ${fn}\nfunction search(){return "";}`) };
}

function makeMeta(i: number): BookSourceMeta {
  return {
    sourceKey: `s${i}`,
    uuid: `s${i}`,
    fileName: `s${i}.js`,
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

  it('detectBatch 12 书源全部完成（5 并发）', async () => {
    const sandbox = new MockSandbox();
    for (let i = 0; i < 12; i++) {
      sandbox.results.set(`s${i}.js`, { fileName: `s${i}.js`, fns: ['search', 'bookInfo'] });
    }
    const svc = new SourceHealthService(sandbox as unknown as ConstructorParameters<typeof SourceHealthService>[0]);
    const metas = Array.from({ length: 12 }, (_, i) => makeMeta(i));
    const reports = await svc.detectBatch(metas);
    expect(reports.size).toBe(12);
    expect(reports.get('s5.js')?.capabilities).toEqual(['search', 'bookInfo']);
  });

  it('detectBatch 单书源失败不影响其他', async () => {
    const sandbox = new MockSandbox();
    sandbox.results.set('s0.js', { fileName: 's0.js', fns: ['search'] });
    sandbox.results.set('s1.js', { fileName: 's1.js', fns: ['bookInfo'] });
    // s2 不注入 → sandbox.load 抛错
    const svc = new SourceHealthService(sandbox as unknown as ConstructorParameters<typeof SourceHealthService>[0]);
    const metas = [makeMeta(0), makeMeta(1), makeMeta(2)];
    const reports = await svc.detectBatch(metas);
    expect(reports.size).toBe(3);
    expect(reports.get('s0.js')?.sample?.ok).toBe(true);
    expect(reports.get('s1.js')?.sample?.ok).toBe(true);
    // s2 → readSource 成功（mock 始终返回字符串），但 sandbox.load 抛错 → capabilities 空
    expect(reports.get('s2.js')?.capabilities).toEqual([]);
  });

  it('detectCapabilities 缺失 booksourceRead 返回空数组', async () => {
    (window as unknown as { pomAPI?: unknown }).pomAPI = {};
    const sandbox = new MockSandbox();
    const svc = new SourceHealthService(sandbox as unknown as ConstructorParameters<typeof SourceHealthService>[0]);
    const caps = await svc.detectCapabilities('x.js');
    expect(caps).toEqual([]);
  });

  it('sampleTest 不触发网络（v1 占位）', async () => {
    const svc = new SourceHealthService(new MockSandbox() as unknown as ConstructorParameters<typeof SourceHealthService>[0]);
    const r = await svc.sampleTest(makeMeta(0));
    expect(r.ok).toBe(true);
    expect(r.durationMs).toBe(0);
  });
});