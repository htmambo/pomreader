import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MultiSourceSearchService, RawSearchItem } from './multi-source-search.service';
import { BookSourceRegistry } from './book-source.registry';
import { BookSourceAdapter } from './book-source.adapter';

/**
 * Mock 适配器 — 实现 duck-typed search(keyword, page)
 * 构造时按 resultsByKeyword 预设返回值；含 'fail' 触发抛错、'slow' 触发超时。
 */
class MockAdapter implements BookSourceAdapter {
  constructor(
    public readonly name: string,
    private readonly resultsByKeyword: Map<string, RawSearchItem[]> = new Map(),
  ) {}

  match(): boolean { return true; }
  async fetchCatalog() { return { title: '', author: '', chapters: [] }; }
  async fetchChapter(): Promise<string> { return ''; }

  /** duck-typed 扩展方法（非 BookSourceAdapter 字段） */
  async search(keyword: string): Promise<RawSearchItem[]> {
    const items = this.resultsByKeyword.get(keyword);
    if (items === undefined) {
      if (keyword === 'fail') throw new Error('mock failure');
      if (keyword === 'slow') await new Promise<void>((r) => setTimeout(r, 200));
      return [];
    }
    return items;
  }
}

describe('MultiSourceSearchService', () => {
  let registry: BookSourceRegistry;
  let service: MultiSourceSearchService;

  beforeEach(() => {
    // 直实例化：registry 走 forTest 注入 mock PageFetcher（无需 DI）
    registry = BookSourceRegistry.forTest({ fetchHtml: async () => '', fetchRendered: async () => '' } as never);
    service = new MultiSourceSearchService(registry);
  });

  it('聚合多书源结果并按 书名+作者 去重', async () => {
    registry.register(new MockAdapter('src-a', new Map([
      ['test', [
        { name: '书1', author: '作者1', url: 'http://a.com/1' },
        { name: '书2', author: '作者2', url: 'http://a.com/2' },
      ]],
    ])));
    registry.register(new MockAdapter('src-b', new Map([
      ['test', [
        { name: '书1', author: '作者1', url: 'http://b.com/1' }, // 重复
        { name: '书3', author: '作者3', url: 'http://b.com/3' },
      ]],
    ])));

    const results = await service.searchAll('test');
    // 去重后 3 本：书1（src-a 先）/书2/书3
    expect(results).toHaveLength(3);
    expect(results.map((r) => r.name)).toEqual(['书1', '书2', '书3']);
    expect(results[0].sourceName).toBe('src-a'); // 先返回者保留
    expect(results[0].latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('单书源抛错不影响其他书源（错误项不展示）', async () => {
    registry.register(new MockAdapter('good', new Map([
      ['fail', [{ name: '好书', author: 'A', url: 'http://x/1' }]],
    ])));
    registry.register(new MockAdapter('bad')); // 'fail' 关键词触发 throw

    const results = await service.searchAll('fail');
    // good 正常返回；bad 失败但 console.warn 不阻塞 → 1 项
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('好书');
    expect(results[0].sourceName).toBe('good');
  });

  it('无 search() 方法的适配器被静默跳过', async () => {
    class PlainAdapter implements BookSourceAdapter {
      readonly name = 'plain';
      match() { return true; }
      async fetchCatalog() { return { title: '', author: '', chapters: [] }; }
      async fetchChapter() { return ''; }
    }
    registry.register(new PlainAdapter());
    registry.register(new MockAdapter('searchable', new Map([['k', [{ name: 'X', url: 'http://x' }]]])));

    const results = await service.searchAll('k');
    expect(results).toHaveLength(1);
    expect(results[0].sourceName).toBe('searchable');
  });

  it('sourceNames 过滤生效', async () => {
    registry.register(new MockAdapter('a', new Map([['k', [{ name: 'A书', url: 'http://a' }]]])));
    registry.register(new MockAdapter('b', new Map([['k', [{ name: 'B书', url: 'http://b' }]]])));

    const results = await service.searchAll('k', { sourceNames: ['a'] });
    expect(results).toHaveLength(1);
    expect(results[0].sourceName).toBe('a');
  });

  it('单书源超时不影响其他书源（timeoutMs=50）', async () => {
    vi.useFakeTimers();
    try {
      registry.register(new MockAdapter('slow'));   // 200ms 后 resolve
      registry.register(new MockAdapter('fast', new Map([
        ['k', [{ name: '快书', url: 'http://f/1' }]],
      ])));

      const promise = service.searchAll('k', { timeoutMs: 50 });
      // 让 slow 内部 setTimeout(200) 跑完 + Promise.race timeout 触发
      await vi.advanceTimersByTimeAsync(300);
      const results = await promise;

      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('快书');
      // slow 失败被 console.warn 吞掉，不入 results
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(warnSpy).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
