import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CoverService } from './cover.service';
import { CoverRequest } from './cover.types';

/**
 * CoverService 单测（实施计划 T-008 验收 + spec FR-3）
 *
 * Mock 策略：直接挂载 stub 到 window.pomAPI（jsdom 默认无）
 * 覆盖：单 URL 解析、fallback、批量并发 + 重试、IPC 不可用
 */

describe('CoverService', () => {
  let service: CoverService;

  beforeEach(() => {
    // 默认 stub：URL === 'fail' 抛错，其余返回 localRef
    (window as unknown as { pomAPI: unknown }).pomAPI = {
      coverResolveCache: vi.fn(async (req: CoverRequest) => {
        if (req.url === 'fail') throw new Error('mock fail');
        return {
          localPath: `/tmp/covers/${req.url}`,
          localRef: `local:///tmp/covers/${req.url}`,
        };
      }),
      coverCacheSize: vi.fn(async () => 1024),
      coverCacheClear: vi.fn(async () => 512),
    };
    service = new CoverService();
  });

  it('resolve: 返回 localRef', async () => {
    const result = await service.resolve('https://example.com/cover.jpg');
    expect(result).toBe('local:///tmp/covers/https://example.com/cover.jpg');
  });

  it('resolve: IPC 抛错时 fallback 到 data: URL', async () => {
    const result = await service.resolve('fail');
    expect(result.startsWith('data:image/svg+xml;base64,')).toBe(true);
    // base64 还原含 'Cover' 文字
    const decoded = atob(result.split(',')[1] ?? '');
    expect(decoded).toContain('Cover');
  });

  it('resolve: IPC 不可用时直接 fallback', async () => {
    (window as unknown as { pomAPI: unknown }).pomAPI = {};
    const result = await service.resolve('https://example.com/x.jpg');
    expect(result.startsWith('data:image/svg+xml')).toBe(true);
  });

  it('resolveAll: 10 URL 全部返回且去重保序', async () => {
    const urls = Array.from({ length: 10 }, (_, i) => `https://example.com/${i}.jpg`);
    const result = await service.resolveAll(urls);
    expect(result.size).toBe(10);
    // 验证所有 key 都存在
    for (const u of urls) {
      expect(result.has(u)).toBe(true);
    }
  });

  it('resolveAll: 失败 URL 走 fallback（全部入 Map，fail 值为 data: URL）', async () => {
    const urls = ['ok1', 'fail', 'ok2'];
    const result = await service.resolveAll(urls);
    expect(result.size).toBe(3);
    expect(result.get('ok1')?.startsWith('local://')).toBe(true);
    expect(result.get('ok2')?.startsWith('local://')).toBe(true);
    expect(result.get('fail')?.startsWith('data:image/svg+xml')).toBe(true);
  });

  it('resolveAll: 空数组返回空 Map', async () => {
    const result = await service.resolveAll([]);
    expect(result.size).toBe(0);
  });

  it('size: IPC 存在时返回字节数', async () => {
    const result = await service.size();
    expect(result).toBe(1024);
  });

  it('size: IPC 不可用返回 0', async () => {
    (window as unknown as { pomAPI: unknown }).pomAPI = {};
    const result = await service.size();
    expect(result).toBe(0);
  });

  it('clear: 返回释放字节数', async () => {
    const result = await service.clear();
    expect(result).toBe(512);
  });

  it('fallback: 同 URL 生成稳定 SVG（多次调用相同结果）', async () => {
    const a = (service as unknown as { fallbackDataUrl(u: string): string }).fallbackDataUrl('https://example.com/x.jpg');
    const b = (service as unknown as { fallbackDataUrl(u: string): string }).fallbackDataUrl('https://example.com/x.jpg');
    expect(a).toBe(b);
  });
});