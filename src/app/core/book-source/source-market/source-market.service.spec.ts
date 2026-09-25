import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  SourceMarketService,
  RepoManifestSource,
} from './source-market.service';

/** 构造一条最小可用的市场书源条目 */
function mkSrc(over: Partial<RepoManifestSource> = {}): RepoManifestSource {
  return {
    name: '示例',
    url: 'http://example.com',
    downloadUrl: 'http://example.com/a.js',
    fileName: 'a.js',
    version: '1.0.0',
    ...over,
  };
}

describe('SourceMarketService', () => {
  let service: SourceMarketService;

  beforeEach(() => {
    (window as { pomAPI?: unknown }).pomAPI = {
      booksourceFetchRepo: vi.fn(async () => ({
        name: 'Test Repo',
        version: '1',
        updatedAt: '2026-09-26',
        sources: [mkSrc(), mkSrc({ fileName: 'b.js', name: 'B' })],
      })),
      booksourceInstall: vi.fn(async () => undefined),
    };
    service = new SourceMarketService();
  });

  describe('compareVersion', () => {
    it('remote 更高 → upgrade', () => {
      expect(service.compareVersion('1.0.0', '1.0.1')).toBe('upgrade');
    });

    it('remote 更低 → downgrade', () => {
      expect(service.compareVersion('2.0.0', '1.0.0')).toBe('downgrade');
    });

    it('完全一致 → same', () => {
      expect(service.compareVersion('1.0.0', '1.0.0')).toBe('same');
    });

    it('缺字段 → unknown', () => {
      expect(service.compareVersion('', '1.0.0')).toBe('unknown');
      expect(service.compareVersion('1.0.0', '')).toBe('unknown');
    });

    it('段数不等按 max 比较：少段补 0', () => {
      expect(service.compareVersion('1.0', '1.0.1')).toBe('upgrade');
      expect(service.compareVersion('1.0.1', '1.0')).toBe('downgrade');
    });

    it('非数字段降级为 0', () => {
      expect(service.compareVersion('1.x.0', '1.0.0')).toBe('same');
    });
  });

  describe('fetchRepo', () => {
    it('成功返回主进程 JSON', async () => {
      const m = await service.fetchRepo();
      expect(m.name).toBe('Test Repo');
      expect(m.sources).toHaveLength(2);
    });

    it('非对象响应抛错', async () => {
      (window as { pomAPI?: { booksourceFetchRepo: ReturnType<typeof vi.fn> } }).pomAPI!.booksourceFetchRepo =
        vi.fn(async () => null);
      await expect(service.fetchRepo()).rejects.toThrow('仓库响应非合法对象');
    });

    it('IPC 不可用抛错', async () => {
      (window as { pomAPI?: unknown }).pomAPI = {};
      await expect(service.fetchRepo()).rejects.toThrow('IPC 不可用');
    });
  });

  describe('installBatch', () => {
    it('全部成功', async () => {
      const srcs = [mkSrc({ fileName: 'x.js' }), mkSrc({ fileName: 'y.js' })];
      const result = await service.installBatch(srcs);
      expect(result.succeeded).toEqual(['x.js', 'y.js']);
      expect(result.failed).toEqual([]);
    });

    it('单条失败不阻塞其他：failed 数组记录 + 进度回调 done 仍累加', async () => {
      (window as { pomAPI?: { booksourceInstall: ReturnType<typeof vi.fn> } }).pomAPI!.booksourceInstall =
        vi.fn(async (url: string) => {
          if (url.endsWith('bad.js')) throw new Error('HTTP 404');
        });
      const srcs = [
        mkSrc({ fileName: 'ok.js', downloadUrl: 'http://x/ok.js' }),
        mkSrc({ fileName: 'bad.js', downloadUrl: 'http://x/bad.js' }),
      ];
      const progresses: number[] = [];
      const result = await service.installBatch(srcs, (p) => progresses.push(p.done));
      expect(result.succeeded).toEqual(['ok.js']);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0].src.fileName).toBe('bad.js');
      expect(result.failed[0].error).toBe('HTTP 404');
      expect(progresses[progresses.length - 1]).toBe(2);
    });
  });
});
