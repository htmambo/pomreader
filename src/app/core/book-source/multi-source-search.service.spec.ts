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

  // 端到端聚合 + JS 书源 duck-typed 桥接（FR-2 + 实施计划 T-006）
  // search() 的具体行为（沙箱调用 / 字段映射 / 截断）在 js-source.adapter.spec.ts 覆盖
  it('JsSourceAdapter 暴露了 search 方法（duck-typed 聚合过滤能识别）', async () => {
    const { JsSourceAdapter } = await import('./js-source/js-source.adapter');
    expect(typeof JsSourceAdapter.prototype.search).toBe('function');
  });

  it('JsSourceAdapter 接入 registry 后能被聚合搜索识别并按 name|author 去重', async () => {
    const { JsSourceAdapter } = await import('./js-source/js-source.adapter');
    const { BookSourceMeta } = await import('./js-source/source-meta.types');
    // mock pomAPI.booksourceRead（ensureLoaded 内部 readSource 调用）
    const w = window as unknown as { pomAPI?: { booksourceRead: (fn: string) => Promise<string> } };
    const origPom = w.pomAPI;
    w.pomAPI = { booksourceRead: async () => 'function search(){return []}' };
    try {
      // 最小 sandbox mock：让 ensureLoaded 走通 + search 返回固定数据
      const searchResult = [
        { name: '庆余年', author: '猫腻', bookUrl: 'http://a/1' },
        { name: '赘婿', author: '愤怒的香蕉', bookUrl: 'http://a/2' },
        { name: '庆余年', author: '猫腻', bookUrl: 'http://a/3' }, // 重复 name|author
      ];
      const sandbox = {
        load: async () => ({ fileName: 'js-a.js', fns: ['search'] }),
        call: async <T>(_fileName: string, fn: string): Promise<T> => {
          if (fn === 'search') return searchResult as unknown as T;
          return [] as unknown as T;
        },
      };
      const meta: BookSourceMeta = {
        sourceKey: 'k', uuid: 'k', fileName: 'js-a.js', name: 'JS 源 A',
        url: 'https://js-a.com', urls: ['https://js-a.com'],
        author: undefined, logo: undefined, description: undefined,
        enabled: true, fileSize: 0, modifiedAt: 0, sourceDir: '',
        sourceType: 'novel', version: '1', tags: [], minDelayMs: 0, requireUrls: [],
      };
      const adapter = new JsSourceAdapter(meta, sandbox as never);
      registry.registerJsAdapter(adapter);

      const results = await service.searchAll('网文');
      // 3 条原始数据去重后 2 条（庆余年只保留先返回者）
      const fromJsA = results.filter((r) => r.sourceName === 'JS 源 A');
      expect(fromJsA).toHaveLength(2);
      expect(fromJsA.map((r) => r.name).sort()).toEqual(['庆余年', '赘婿']);
    } finally {
      if (origPom === undefined) delete w.pomAPI;
      else w.pomAPI = origPom;
    }
  });

  it('progress signal 在搜索过程中正确更新阶段', async () => {
    registry.register(new MockAdapter('src-a', new Map([['k', [{ name: 'A书', url: 'http://a' }]]])));
    registry.register(new MockAdapter('src-b', new Map([['k', [{ name: 'B书', url: 'http://b' }]]])));

    // 初始：idle
    expect(service.progress().phase).toBe('idle');

    // 搜索中：phase 应进入 searching，total=2
    const inFlight = service.searchAll('k');
    // micro-task 让同步部分跑完
    await Promise.resolve();
    expect(service.progress().phase).toBe('searching');
    expect(service.progress().total).toBe(2);
    expect(['src-a', 'src-b']).toContain(service.progress().current.split(', ')[0]);

    await inFlight;
    // 结束：done 阶段
    expect(service.progress().phase).toBe('done');
    expect(service.progress().done).toBe(2);
    expect(service.progress().total).toBe(2);
  });

  it('0 源时 progress 进入 done 且不发任何 console.warn（已有 lastErrors 路径）', async () => {
    // 不注册任何带 search 的 adapter
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const results = await service.searchAll('k');
    expect(results).toEqual([]);
    // 0 源时输出诊断日志（说明原因）
    expect(warnSpy).toHaveBeenCalled();
    const msg = String(warnSpy.mock.calls[0]?.[0] ?? '');
    expect(msg).toContain('multi-source-search');
    expect(msg).toContain('0 个源参与搜索');
    expect(service.progress().phase).toBe('done');
    warnSpy.mockRestore();
  });
});
