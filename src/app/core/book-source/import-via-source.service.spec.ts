/**
 * ImportViaSourceService · importByUrl bookSourceUuid 锚定测试
 *
 * 验证 importByUrl 返回 ImportByUrlResult { book, bookSourceUuid }（结构统一）：
 * - JSON 规则书源来源 → bookSourceUuid = meta.uuid（精确锚定）
 * - 内置 adapter（无 meta.uuid）/ 不传 sourceName / 空 uuid → UNIVERSAL_BOOK_SOURCE_UUID 兜底
 * - sourceName 指定但 match 失败 / 源不存在 → 抛 FetchError（不静默降级）
 */
import { describe, it, expect, vi } from 'vitest';
import { BookSourceAdapter, PageFetcher, ResolvedBook } from './book-source.adapter';
import { BookSourceRegistry } from './book-source.registry';
import { JsonRuleAdapter } from './json-rule/json-rule.adapter';
import { BookSourceMeta } from './source-meta.types';
import { ImportViaSourceService } from './import-via-source.service';
import { UNIVERSAL_BOOK_SOURCE_UUID } from './book-source.constants';

function emptyFetcher(): PageFetcher {
  return { fetchHtml: async () => '', fetchRendered: async () => '' } as any;
}

/** mock 内置 adapter（match url，返回固定 ResolvedBook，避免 HeuristicAdapter 内部 catalog-empty 抛错） */
class StubAdapter implements BookSourceAdapter {
  constructor(
    public readonly name: string,
    public readonly meta?: { uuid?: string },
  ) {}
  match(): boolean {
    return true;
  }
  async fetchCatalog(): Promise<ResolvedBook> {
    return { title: 'stub book', author: 'stub', chapters: [{ title: 'ch1', url: 'http://a/1' }] };
  }
  async fetchChapter(): Promise<string> {
    return '';
  }
}

describe('ImportViaSourceService · importByUrl bookSourceUuid 锚定', () => {
  it('指定 JSON 规则书源来源时，importByUrl 返回 { book, bookSourceUuid: meta.uuid }', async () => {
    const reg = BookSourceRegistry.forTest(emptyFetcher());
    const meta: BookSourceMeta = {
      sourceKey: 'uuid-hetushu',
      uuid: 'uuid-hetushu',
      fileName: 'hetushu.json',
      name: 'hetushu',
      url: 'https://www.hetushu.com',
      urls: ['https://www.hetushu.com'],
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
    const engineService = {
      bookInfo: async () => ({
        name: '测试书',
        author: '测试作者',
        chapters: [{ name: '第1章', url: 'http://a/1' }],
      }),
    };
    const adapter = new JsonRuleAdapter(meta, engineService as never);
    reg.registerRuleAdapter(adapter);

    const svc = ImportViaSourceService.forTest(reg, emptyFetcher());
    const result = await svc.importByUrl('https://www.hetushu.com/book/5763/', 'hetushu');
    expect(result.book.title).toBe('测试书');
    expect(result.bookSourceUuid).toBe('uuid-hetushu');
  });

  it('指定内置 adapter（无 meta.uuid）时，bookSourceUuid 返回 UNIVERSAL 兜底', async () => {
    const reg = BookSourceRegistry.forTest(emptyFetcher());
    reg.register(new StubAdapter('stub-no-uuid'));
    const svc = ImportViaSourceService.forTest(reg, emptyFetcher());
    const result = await svc.importByUrl('https://random.com/book/123/', 'stub-no-uuid');
    expect(result.book.title).toBe('stub book');
    expect(result.bookSourceUuid).toBe(UNIVERSAL_BOOK_SOURCE_UUID);
  });

  it('不传 sourceName 走 registry 自动 resolve：bookSourceUuid 同样为 UNIVERSAL', async () => {
    const reg = BookSourceRegistry.forTest(emptyFetcher());
    reg.register(new StubAdapter('stub-no-uuid'));
    const svc = ImportViaSourceService.forTest(reg, emptyFetcher());
    const result = await svc.importByUrl('https://random.com/book/123/');
    expect(result.book.title).toBe('stub book');
    expect(result.bookSourceUuid).toBe(UNIVERSAL_BOOK_SOURCE_UUID);
  });

  it('forTest 静态工厂：构造时跳过 inject（不抛 NG0203）', () => {
    const reg = BookSourceRegistry.forTest(emptyFetcher());
    const svc = ImportViaSourceService.forTest(reg, emptyFetcher());
    expect(svc).toBeDefined();
    vi.fn();
  });

  // ========== P0-1 / P0-2 回归 + 边界用例 ==========

  it('P0-1 回归：sourceName 指定但 match 失败抛 FetchError（不静默降级）', async () => {
    const reg = BookSourceRegistry.forTest(emptyFetcher());
    class NoMatchAdapter extends StubAdapter {
      override match(): boolean {
        return false;
      }
    }
    reg.register(new NoMatchAdapter('a-source'));
    const svc = ImportViaSourceService.forTest(reg, emptyFetcher());
    await expect(svc.importByUrl('https://example.com/book/', 'a-source')).rejects.toMatchObject({
      code: 'unsupported-source',
    });
  });

  it('P0-1 回归：sourceName 指定但 registry.get 找不到源抛 FetchError', async () => {
    const reg = BookSourceRegistry.forTest(emptyFetcher());
    const svc = ImportViaSourceService.forTest(reg, emptyFetcher());
    await expect(svc.importByUrl('https://example.com/book/', '不存在的源')).rejects.toMatchObject({
      code: 'unsupported-source',
    });
  });

  it('空 uuid 归一化为 UNIVERSAL（破损数据兜底）', async () => {
    const reg = BookSourceRegistry.forTest(emptyFetcher());
    class EmptyUuidAdapter extends StubAdapter {
      constructor() {
        super('empty-uuid', { uuid: '' });
      }
    }
    reg.register(new EmptyUuidAdapter());
    const svc = ImportViaSourceService.forTest(reg, emptyFetcher());
    const result = await svc.importByUrl('https://example.com/book/', 'empty-uuid');
    expect(result.bookSourceUuid).toBe(UNIVERSAL_BOOK_SOURCE_UUID);
  });

  it('match 成功但 PageFetcher 不可用（forTest 传 null）→ 抛 source-unavailable', async () => {
    const reg = BookSourceRegistry.forTest(emptyFetcher());
    reg.register(new StubAdapter('stub'));
    const svc = ImportViaSourceService.forTest(reg, null as unknown as PageFetcher);
    await expect(svc.importByUrl('https://example.com/book/', 'stub')).rejects.toMatchObject({
      code: 'source-unavailable',
      message: 'PageFetcher 不可用（仅 in-browser / Electron 环境）',
    });
  });
});

/** 带 search() 的 adapter（duck-typed，BookSourceAdapter 接口本身不含 search）。 */
class SearchAdapter extends StubAdapter {
  readonly search: (kw: string, p: number) => Promise<unknown>;
  constructor(name: string, impl: (kw: string, p: number) => Promise<unknown>) {
    super(name);
    this.search = impl;
  }
}

describe('ImportViaSourceService · searchAndSelect / supportedSources', () => {
  it('书源不存在 → 抛 FetchError(unsupported-source)', async () => {
    const reg = BookSourceRegistry.forTest(emptyFetcher());
    const svc = ImportViaSourceService.forTest(reg, emptyFetcher());
    await expect(svc.searchAndSelect('kw', '不存在的源')).rejects.toMatchObject({
      code: 'unsupported-source',
      message: '书源不存在: 不存在的源',
    });
  });

  it('adapter 未实现 search() → 抛 FetchError(unsupported-source)', async () => {
    const reg = BookSourceRegistry.forTest(emptyFetcher());
    reg.register(new StubAdapter('no-search'));
    const svc = ImportViaSourceService.forTest(reg, emptyFetcher());
    await expect(svc.searchAndSelect('kw', 'no-search')).rejects.toMatchObject({
      code: 'unsupported-source',
      message: '书源 no-search 不支持 search()',
    });
  });

  it('search() 返回非数组 → 归一化为空列表', async () => {
    const reg = BookSourceRegistry.forTest(emptyFetcher());
    reg.register(new SearchAdapter('weird', async () => null));
    const svc = ImportViaSourceService.forTest(reg, emptyFetcher());
    await expect(svc.searchAndSelect('kw', 'weird')).resolves.toEqual([]);
  });

  it('search() 结果归一化：过滤无 url 项，title/bookUrl/description 回退并 trim', async () => {
    const reg = BookSourceRegistry.forTest(emptyFetcher());
    const searchArgs: Array<[string, number]> = [];
    reg.register(
      new SearchAdapter('src', async (kw, p) => {
        searchArgs.push([kw, p]);
        return [
          { name: ' 书甲 ', author: '作者甲', url: ' https://a/b/1 ', intro: '简介甲' },
          { title: '书乙', bookUrl: 'https://a/b/2', description: '简介乙' },
          { name: '无链接项' },
          null,
        ];
      }),
    );
    const svc = ImportViaSourceService.forTest(reg, emptyFetcher());
    const hits = await svc.searchAndSelect('庆余年', 'src', 2);
    expect(searchArgs).toEqual([['庆余年', 2]]);
    expect(hits).toEqual([
      { name: '书甲', author: '作者甲', url: 'https://a/b/1', intro: '简介甲' },
      { name: '书乙', author: undefined, url: 'https://a/b/2', intro: '简介乙' },
    ]);
  });

  it('supportedSources() 透传 registry 中的书源名列表', () => {
    const reg = BookSourceRegistry.forTest(emptyFetcher());
    reg.register(new StubAdapter('src-a'));
    reg.register(new StubAdapter('src-b'));
    const svc = ImportViaSourceService.forTest(reg, emptyFetcher());
    expect(svc.supportedSources()).toEqual(['src-a', 'src-b']);
  });

  // 回归（历史 bug 已修）：服务侧曾在摘取 `adapter.search` 后脱离实例裸调导致 this 丢失；
  // search 为依赖 this 的原型方法（JsonRuleAdapter.search 的写法）时必须正常拿到实例
  it('search 为依赖 this 的原型方法 → this 保留，正常返回结果', async () => {
    const reg = BookSourceRegistry.forTest(emptyFetcher());
    class PrototypeSearchAdapter extends StubAdapter {
      async search(): Promise<unknown> {
        return [{ name: `${this.name}的书`, url: 'https://a/b/1' }]; // 依赖 this
      }
    }
    reg.register(new PrototypeSearchAdapter('proto-search'));
    const svc = ImportViaSourceService.forTest(reg, emptyFetcher());
    await expect(svc.searchAndSelect('kw', 'proto-search')).resolves.toEqual([
      { name: 'proto-search的书', author: undefined, url: 'https://a/b/1', intro: undefined },
    ]);
  });
});
