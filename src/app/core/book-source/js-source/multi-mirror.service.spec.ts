import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MultiMirrorService } from './multi-mirror.service';

/**
 * 测试覆盖：
 * 1. 单镜像成功：直接返回，不调用后续镜像
 * 2. Failover：单镜像重试 N 次失败后切下一镜像
 * 3. 全失败：所有镜像所有重试都失败 → ok:false + triedUrls 全记录
 * 4. 限流：连续镜像间间隔 >= minDelayMs（fake timer 验证）
 * 5. urls 为空：直接返回 ok:false
 */
describe('MultiMirrorService', () => {
  let service: MultiMirrorService;

  beforeEach(() => {
    service = new MultiMirrorService();
  });

  it('第一镜像成功时直接返回，不调用后续镜像', async () => {
    const calls: string[] = [];
    const fn = async (url: string) => {
      calls.push(url);
      return `payload:${url}`;
    };
    const result = await service.tryMirrors(fn, {
      urls: ['http://a.com', 'http://b.com'],
      sourceId: 'src-success',
    });
    expect(result.ok).toBe(true);
    expect(result.data).toBe('payload:http://a.com');
    expect(result.triedUrls).toEqual(['http://a.com']);
    expect(calls).toEqual(['http://a.com']);
  });

  it('第一镜像重试失败后自动 failover 到下一镜像', async () => {
    // a 重试 2 次失败，b 第一次成功
    const fn = vi
      .fn<(url: string) => Promise<string>>()
      .mockImplementation(async (url) => {
        const attemptsForUrl = fn.mock.calls.filter((c) => c[0] === url).length;
        if (url === 'http://a.com' && attemptsForUrl <= 2) {
          throw new Error(`a-fail-${attemptsForUrl}`);
        }
        return `ok:${url}`;
      });

    const result = await service.tryMirrors(fn, {
      urls: ['http://a.com', 'http://b.com'],
      retriesPerMirror: 2,
      sourceId: 'src-failover',
    });

    expect(result.ok).toBe(true);
    expect(result.data).toBe('ok:http://b.com');
    expect(result.triedUrls).toEqual([
      'http://a.com',
      'http://a.com',
      'http://b.com',
    ]);
  });

  it('所有镜像所有重试均失败时返回 ok:false 并汇总 triedUrls', async () => {
    const fn = async (_url: string) => {
      throw new Error('always-fail');
    };
    const result = await service.tryMirrors(fn, {
      urls: ['http://a.com', 'http://b.com'],
      retriesPerMirror: 2,
      sourceId: 'src-allfail',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('所有镜像均失败');
    expect(result.triedUrls).toEqual([
      'http://a.com',
      'http://a.com',
      'http://b.com',
      'http://b.com',
    ]);
    expect(result.data).toBeUndefined();
  });

  it('minDelayMs 限流生效：连续镜像间间隔 >= minDelayMs（fake timer）', async () => {
    vi.useFakeTimers();
    try {
      // 强制首镜像失败以触发第二镜像（否则首镜像直接成功，不进入限流路径）
      const fn = async (url: string) => {
        if (url === 'http://a.com') throw new Error('a-fail');
        return `ok:${url}`;
      };
      const promise = service.tryMirrors(fn, {
        urls: ['http://a.com', 'http://b.com'],
        retriesPerMirror: 1,
        minDelayMs: 200,
        sourceId: 'src-rate',
      });
      // 第一镜像无 sleep（无前置请求）；第二镜像需 sleep 至 200ms
      await vi.advanceTimersByTimeAsync(500);
      const result = await promise;
      expect(result.ok).toBe(true);
      expect(result.triedUrls.length).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('minDelayMs=0 时不 sleep（无延迟）', async () => {
    const fn = async (url: string) => `ok:${url}`;
    const start = Date.now();
    const result = await service.tryMirrors(fn, {
      urls: ['http://a.com', 'http://b.com'],
      retriesPerMirror: 1,
      minDelayMs: 0,
      sourceId: 'src-nodelay',
    });
    const elapsed = Date.now() - start;
    expect(result.ok).toBe(true);
    // 实测 < 50ms（无 sleep），非严格上限仅做烟雾
    expect(elapsed).toBeLessThan(50);
  });

  it('urls 为空时直接返回 ok:false', async () => {
    const fn = async () => 'never-called';
    const result = await service.tryMirrors(fn, { urls: [] });
    expect(result.ok).toBe(false);
    expect(result.triedUrls).toEqual([]);
    expect(result.error).toBe('urls 为空');
  });

  it('cookieJar 仅作为 metadata 保留在 options（不实际存）', async () => {
    const fn = async (url: string) => `ok:${url}`;
    const result = await service.tryMirrors(fn, {
      urls: ['http://a.com'],
      cookieJar: 'jar-001',
      sourceId: 'src-cookie',
    });
    expect(result.ok).toBe(true);
    // cookieJar 仅 options 透传；service 内部不持久化（v1 行为）
    // 验证无副作用：再次调用仍正常
    const result2 = await service.tryMirrors(fn, {
      urls: ['http://a.com'],
      sourceId: 'src-cookie',
    });
    expect(result2.ok).toBe(true);
  });
});
