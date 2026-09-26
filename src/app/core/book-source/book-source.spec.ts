import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PageFetcher, BookSourceAdapter } from './book-source.adapter';
import { BookSourceRegistry } from './book-source.registry';
import { XbiqugeAdapter } from './adapters/xbiquge.adapter';
import { HeuristicAdapter } from './adapters/heuristic.adapter';
import { JsSourceAdapter } from './js-source/js-source.adapter';
import { BookSourceMeta } from './js-source/source-meta.types';
import { FetchError } from './fetch-error';
import { SOURCE_CONFIG } from './book-source.config';
import { looksObfuscated } from './heuristic-parser';

const FIXTURES = join(__dirname, 'adapters', '__fixtures__');

function loadFixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf-8');
}

/** mock fetcher：按预置 map 返回 HTML */
function mockFetcher(map: Record<string, string>): PageFetcher {
  return {
    fetchHtml: vi.fn(async (url: string) => map[url] ?? ''),
  };
}

describe('BookSourceRegistry', () => {
  function makeRegistry(): BookSourceRegistry {
    const reg = BookSourceRegistry.forTest(mockFetcher({}));
    reg.register(new XbiqugeAdapter());
    reg.register(new HeuristicAdapter());
    return reg;
  }

  it('笔趣阁 URL 命中 XbiqugeAdapter（不抛 unsupported-source）', async () => {
    const reg = makeRegistry();
    try {
      await reg.fetchCatalog('https://www.xbiquge.cc/book/9231/');
    } catch (e) {
      // 空 HTML 会抛 catalog-empty，但绝不是 unsupported-source
      expect((e as Error).message).not.toContain('unsupported-source');
    }
  });

  it('未知 URL 走启发式兜底（不抛 unsupported-source）', async () => {
    const reg = makeRegistry();
    // unknown URL 现在由 HeuristicAdapter 处理（空 HTML 抛 catalog-empty，非 unsupported）
    try {
      await reg.fetchCatalog('https://www.unknown.com/book/1');
    } catch (e) {
      expect((e as Error).message).not.toContain('unsupported-source');
    }
  });

  it('非 http URL 抛 unsupported-source', async () => {
    const reg = makeRegistry();
    await expect(reg.fetchCatalog('not-a-url')).rejects.toThrow();
  });

  it('supportedSources 返回 2 个适配器名', () => {
    expect(makeRegistry().supportedSources()).toHaveLength(2);
  });
});

describe('XbiqugeAdapter', () => {
  const adapter: BookSourceAdapter = new XbiqugeAdapter();
  const catUrl = 'https://www.xbiquge.cc/book/9231/';
  const chUrl = 'https://www.xbiquge.cc/book/9231/1.html';

  it('match 命中 xbiquge 域名', () => {
    expect(adapter.match('https://www.xbiquge.cc/book/1')).toBe(true);
    expect(adapter.match('https://www.other.com/book/1')).toBe(false);
  });

  it('fetchCatalog 解析书名/作者/目录', async () => {
    const fetcher = mockFetcher({ [catUrl]: loadFixture('xbiquge-catalog.html') });
    const r = await adapter.fetchCatalog(catUrl, fetcher);
    expect(r.title).toBe('测试书名');
    expect(r.author).toBe('测试作者');
    expect(r.chapters).toHaveLength(3);
    expect(r.chapters[0].title).toBe('第一章 风起云涌');
    expect(r.chapters[0].url).toBe('https://www.xbiquge.cc/book/9231/1.html');
  });

  it('fetchChapter 提取正文纯文本（去 script/广告）', async () => {
    const fetcher = mockFetcher({ [chUrl]: loadFixture('xbiquge-chapter.html') });
    const text = await adapter.fetchChapter(
      { title: '第一章', url: chUrl },
      fetcher
    );
    expect(text).toContain('风起云涌');
    expect(text).not.toContain('广告');
    expect(text).not.toContain('adsbygoogle');
  });

  it('目录为空抛 catalog-empty', async () => {
    const fetcher = mockFetcher({ [catUrl]: '<html><body></body></html>' });
    await expect(adapter.fetchCatalog(catUrl, fetcher)).rejects.toThrow('catalog-empty');
  });
});

describe('encoding fallback（auto 侦测）', () => {
  // 编码逻辑在主进程，这里只验证 config 编码字段正确
  it('xbiquge = utf-8', () => {
    expect(SOURCE_CONFIG.xbiquge.encoding).toBe('utf-8');
  });
});

describe('HeuristicAdapter（通用启发式兜底）', () => {
  const adapter = new HeuristicAdapter();
  const catUrl = 'https://www.unknown-site.com/book/123/';
  const chUrl = 'https://www.unknown-site.com/book/123/1.html';

  it('match 任意 http URL', () => {
    expect(adapter.match('https://anything.com/x')).toBe(true);
    expect(adapter.match('http://foo.org/y')).toBe(true);
    expect(adapter.match('not-a-url')).toBe(false);
  });

  it('fetchCatalog 用启发式解析任意站点目录', async () => {
    const fetcher = mockFetcher({ [catUrl]: loadFixture('xbiquge-catalog.html') });
    const r = await adapter.fetchCatalog(catUrl, fetcher);
    // 启发式应能从 xbiquge fixture 提取出书名和章节
    expect(r.chapters.length).toBeGreaterThan(0);
    expect(r.title).toBeTruthy();
  });

  it('fetchChapter 用启发式提取正文', async () => {
    const fetcher = mockFetcher({ [chUrl]: loadFixture('xbiquge-chapter.html') });
    const text = await adapter.fetchChapter({ title: '第一章', url: chUrl }, fetcher);
    expect(text).toContain('风起云涌');
    expect(text).not.toContain('广告');
  });

  it('目录为空抛 catalog-empty', async () => {
    const fetcher = mockFetcher({ [catUrl]: '<html><body></body></html>' });
    await expect(adapter.fetchCatalog(catUrl, fetcher)).rejects.toThrow('catalog-empty');
  });
});

describe('HeuristicAdapter 正文解析（对齐原版 fS：0.6 骤降截断）', () => {
  const adapter = new HeuristicAdapter();
  const hetushuUrl = 'https://www.hetushu.com/book/5/3347.html';

  it('hetushu 章节页：提取完整正文而非单个叶子节点', async () => {
    const fetcher = mockFetcher({ [hetushuUrl]: loadFixture('hetushu-chapter.html') });
    const text = await adapter.fetchChapter({ title: '楔子', url: hetushuUrl }, fetcher);
    // 修复前下钻到 <tt> 水印叶子只返回"和图书"；修复后应停在 #content 提取全部段落
    expect(text.length).toBeGreaterThan(4000);
    expect(text).toContain('这是小姐的血肉');
    expect(text).toContain('蒙住了这天');
  });
});

describe('looksObfuscated（通用可疑判定 → 渲染兜底）', () => {
  it('静态文本过短 → 可疑（JS 渲染站特征）', () => {
    expect(looksObfuscated('和图书', 'https://www.hetushu.com/book/5/3347.html')).toBe(true);
  });

  it('正文多次出现站点域名 → 可疑（水印混淆站特征）', () => {
    const text = '开头……heｔushu.com.cｏｍ……中段……www.hetushu.com.com……结尾'.repeat(3);
    expect(looksObfuscated(text, 'https://www.hetushu.com/book/5/3347.html')).toBe(true);
  });

  it('正常正文（不含域名、足够长）→ 不可疑', () => {
    const text = '范慎很困难地撑着上眼皮，看着指头算自己这辈子做过些什么有意义的事情。'.repeat(10);
    expect(looksObfuscated(text, 'https://www.hetushu.com/book/5/3347.html')).toBe(false);
  });
});

describe('HeuristicAdapter 渲染兜底', () => {
  const adapter = new HeuristicAdapter();
  const hetushuUrl = 'https://www.hetushu.com/book/5/3347.html';
  const chUrl = 'https://www.unknown-site.com/book/123/1.html';

  it('静态结果可疑时调用 fetchRendered 并采用渲染结果', async () => {
    const rendered = '范慎很困难地撑着上眼皮，看着指头算自己这辈子做过些什么有意义的事情。'.repeat(200);
    const fetcher: PageFetcher = {
      fetchHtml: vi.fn(async () => loadFixture('hetushu-chapter.html')),
      fetchRendered: vi.fn(async () => rendered),
    };
    const text = await adapter.fetchChapter({ title: '楔子', url: hetushuUrl }, fetcher);
    expect(fetcher.fetchRendered).toHaveBeenCalledWith(hetushuUrl);
    expect(text).toBe(rendered);
  });

  it('渲染抓取失败时回退静态结果', async () => {
    const fetcher: PageFetcher = {
      fetchHtml: vi.fn(async () => loadFixture('hetushu-chapter.html')),
      fetchRendered: vi.fn(async () => {
        throw new FetchError('timeout');
      }),
    };
    const text = await adapter.fetchChapter({ title: '楔子', url: hetushuUrl }, fetcher);
    expect(text).toContain('这是小姐的血肉');
  });

  it('静态结果正常时不触发渲染抓取', async () => {
    // 构造足够长且无域名的正常正文（过短会按 JS 渲染站特征触发兜底）
    const para = '范慎很困难地撑着上眼皮，看着指头算自己这辈子做过些什么有意义的事情。'.repeat(6);
    const cleanHtml = `<html><body><div id="content"><div>${para}</div><div>${para}</div></div></body></html>`;
    const fetcher: PageFetcher = {
      fetchHtml: vi.fn(async () => cleanHtml),
      fetchRendered: vi.fn(async () => '不应被调用'),
    };
    const text = await adapter.fetchChapter({ title: '第一章', url: chUrl }, fetcher);
    expect(fetcher.fetchRendered).not.toHaveBeenCalled();
    expect(text).toContain('范慎');
  });
});

// ========== Registry.getByUuid / findJsSourceAdapterByUrl ==========

/**
 * 构造 mock JsSourceAdapter：注入 meta（带 uuid + mainUrl 作为 hostPattern 来源）+ sandbox stub
 * mainUrl 会被 JsSourceAdapter.buildHostPattern 处理（去 www、转义点号）
 * 例：mainUrl='https://www.hetushu.com' → 匹配 www.hetushu.com 和 hetushu.com
 */
function makeMockJsAdapter(name: string, uuid: string, mainUrl: string): JsSourceAdapter {
  const meta: BookSourceMeta = {
    sourceKey: uuid,
    uuid,
    fileName: `${name}.js`,
    name,
    url: mainUrl,
    urls: [mainUrl],
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
  const sandbox = {
    load: async () => ({ fileName: meta.fileName, fns: [] }),
    call: async () => null,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new JsSourceAdapter(meta, sandbox as any);
}

describe('BookSourceRegistry · getByUuid / findJsSourceAdapterByUrl', () => {
  it('getByUuid 精确匹配 JsSourceAdapter meta.uuid', () => {
    const reg = BookSourceRegistry.forTest(mockFetcher({}));
    const a = makeMockJsAdapter('hetushu', 'uuid-hetushu-001', 'https://www.hetushu.com');
    reg.registerJsAdapter(a);
    expect(reg.getByUuid('uuid-hetushu-001')).toBe(a);
  });

  it('getByUuid 未命中时返回 undefined（不返回兜底误命中的 adapter）', () => {
    const reg = BookSourceRegistry.forTest(mockFetcher({}));
    reg.register(new HeuristicAdapter());
    expect(reg.getByUuid('not-exists')).toBeUndefined();
  });

  it('getByUuid 严格按 meta.uuid：不通过 name 兜底（防止跨源误命中）', () => {
    const reg = BookSourceRegistry.forTest(mockFetcher({}));
    reg.register(new HeuristicAdapter());
    // 即使存在 name === '通用（启发式）' 的 adapter，getByUuid 也不返回
    expect(reg.getByUuid('通用（启发式）')).toBeUndefined();
    // 想要按 name 查请用 getByName
    expect(reg.getByName('通用（启发式）')).toBeDefined();
  });

  it('getByUuid P0-2 回归：即使存在 name === "universal" 的 adapter 也不误命中', () => {
    const reg = BookSourceRegistry.forTest(mockFetcher({}));
    // 构造一个 name = 'universal' 的 adapter（不是 JsSourceAdapter，没 meta.uuid）
    class NamedUniversalAdapter extends HeuristicAdapter {
      override readonly name = 'universal';
    }
    reg.register(new NamedUniversalAdapter());
    // UNIVERSAL 标识永远返回 undefined（保护 Book.bookSourceUuid = 'universal' 的 invariant）
    expect(reg.getByUuid('universal')).toBeUndefined();
  });

  it('getByName 独立 API：按 adapter.name 查（与 getByUuid 语义分离）', () => {
    const reg = BookSourceRegistry.forTest(mockFetcher({}));
    reg.register(new HeuristicAdapter());
    expect(reg.getByName('通用（启发式）')).toBeDefined();
    expect(reg.getByName('不存在的源')).toBeUndefined();
    expect(reg.getByName('')).toBeUndefined();
  });

  it('findJsSourceAdapterByUrl：按 hostPattern 匹配首个 JsSourceAdapter', () => {
    const reg = BookSourceRegistry.forTest(mockFetcher({}));
    const a = makeMockJsAdapter('hetushu', 'uuid-hetushu-001', 'https://www.hetushu.com');
    reg.registerJsAdapter(a);
    expect(reg.findJsSourceAdapterByUrl('https://www.hetushu.com/book/5763/')?.name).toBe('hetushu');
    expect(reg.findJsSourceAdapterByUrl('https://other.com/book/')).toBeUndefined();
  });

  it('findJsSourceAdapterByUrl：跳过 HeuristicAdapter（match 任意 URL 会误命中）', () => {
    const reg = BookSourceRegistry.forTest(mockFetcher({}));
    reg.register(new HeuristicAdapter()); // 没 meta.uuid，按 duck typing 跳过
    expect(reg.findJsSourceAdapterByUrl('https://anywhere.com/')).toBeUndefined();
  });

  it('findJsSourceAdapterByUrl：空 url 返回 undefined', () => {
    const reg = BookSourceRegistry.forTest(mockFetcher({}));
    expect(reg.findJsSourceAdapterByUrl('')).toBeUndefined();
  });

  it('findJsSourceAdapterByUrl：多个 JsSourceAdapter 都 match 时返回首个（按注册顺序）', () => {
    // 用 mock 适配器（meta.uuid + 自定义 hostPattern）验证「按注册顺序返回首个」语义
    const reg = BookSourceRegistry.forTest(mockFetcher({}));
    const first = makeMockJsAdapter('first', 'uuid-first', 'https://first.com');
    const second = makeMockJsAdapter('second', 'uuid-second', 'https://first.com');
    reg.registerJsAdapter(first);
    reg.registerJsAdapter(second);
    const result = reg.findJsSourceAdapterByUrl('https://first.com/book/');
    expect(result?.name).toBe('first'); // 注册顺序在前
    expect(result).toBe(first);
  });
});
