import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PageFetcher, BookSourceAdapter } from './book-source.adapter';
import { BookSourceRegistry } from './book-source.registry';
import { XbiqugeAdapter } from './adapters/xbiquge.adapter';
import { Dushu369Adapter } from './adapters/dushu369.adapter';
import { Guoxue123Adapter } from './adapters/guoxue123.adapter';
import { Readers365Adapter } from './adapters/readers365.adapter';
import { KehuanAdapter } from './adapters/kehuan.adapter';
import { FetchError } from './fetch-error';
import { SOURCE_CONFIG } from './book-source.config';

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
    reg.register(new Dushu369Adapter());
    reg.register(new Guoxue123Adapter());
    reg.register(new Readers365Adapter());
    reg.register(new KehuanAdapter());
    return reg;
  }

  it('6 站 URL 各命中对应适配器（不抛 unsupported-source）', async () => {
    const reg = makeRegistry();
    const cases: string[] = [
      'https://www.xbiquge.cc/book/9231/',
      'http://www.dushu369.com/book/1',
      'http://www.guoxue123.com/book/1',
      'http://www.readers365.com/book/1',
      'http://www.khuan.net.cn/book/1',
    ];
    for (const url of cases) {
      // 空 HTML 会抛 catalog-empty，但绝不是 unsupported-source
      try {
        await reg.fetchCatalog(url);
      } catch (e) {
        expect((e as Error).message).not.toContain('unsupported-source');
      }
    }
  });

  it('未知 URL 抛 unsupported-source', async () => {
    const reg = makeRegistry();
    await expect(reg.fetchCatalog('https://www.unknown.com/book/1')).rejects.toThrow();
    try {
      await reg.fetchCatalog('https://www.unknown.com/book/1');
    } catch (e) {
      expect(e).toBeInstanceOf(FetchError);
      expect((e as FetchError).code).toBe('unsupported-source');
    }
  });

  it('supportedSources 返回 5 个适配器名', () => {
    expect(makeRegistry().supportedSources()).toHaveLength(5);
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
  it('xbiquge/kehuan = utf-8', () => {
    expect(SOURCE_CONFIG.xbiquge.encoding).toBe('utf-8');
    expect(SOURCE_CONFIG.kehuan.encoding).toBe('utf-8');
  });
  it('dushu369/guoxue123/readers365 = gbk', () => {
    expect(SOURCE_CONFIG.dushu369.encoding).toBe('gbk');
    expect(SOURCE_CONFIG.guoxue123.encoding).toBe('gbk');
    expect(SOURCE_CONFIG.readers365.encoding).toBe('gbk');
  });
});
