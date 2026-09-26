import { describe, it, expect } from 'vitest';
import { resolveCurrentSourceAdapter } from './change-book-source-dialog.component';
import { BookSourceAdapter } from '../../../core/book-source/book-source.adapter';
import { UNIVERSAL_BOOK_SOURCE_UUID } from '../../../core/book-source/book-source.constants';

/**
 * resolveCurrentSourceAdapter 纯函数测试（与项目其他 spec 一致：不走 TestBed）
 * 覆盖：uuid 锚定命中 / uuid 落空回退 URL 匹配 / UNIVERSAL / 老数据无 uuid / 两头空
 */
describe('resolveCurrentSourceAdapter（换源弹窗默认选中）', () => {
  const jsAdapter = { name: 'hetushu' } as BookSourceAdapter;
  const builtinAdapter = { name: '笔趣阁' } as BookSourceAdapter;

  function makeRegistry(overrides?: {
    byUuid?: BookSourceAdapter;
    byUrl?: BookSourceAdapter;
  }) {
    const calls = { getByUuid: 0, matchByUrl: 0 };
    const registry = {
      getByUuid: (_uuid: string) => {
        calls.getByUuid++;
        return overrides?.byUuid;
      },
      matchByUrl: (_url: string) => {
        calls.matchByUrl++;
        return overrides?.byUrl;
      },
    };
    return { registry, calls };
  }

  it('bookSourceUuid 命中 → 直接用 uuid 锚定的适配器，不走 URL 匹配', () => {
    const { registry, calls } = makeRegistry({ byUuid: jsAdapter });
    const result = resolveCurrentSourceAdapter(
      { bookSourceUuid: 'uuid-hetushu-001', sourceUrl: 'https://www.hetushu.com/book/1/' },
      registry,
    );
    expect(result).toBe(jsAdapter);
    expect(calls.matchByUrl).toBe(0);
  });

  it('uuid 存在但源已删除/停用 → 回退 sourceUrl 匹配', () => {
    const { registry, calls } = makeRegistry({ byUuid: undefined, byUrl: builtinAdapter });
    const result = resolveCurrentSourceAdapter(
      { bookSourceUuid: 'uuid-deleted', sourceUrl: 'https://www.xbiquge.cc/book/9/' },
      registry,
    );
    expect(result).toBe(builtinAdapter);
    expect(calls.matchByUrl).toBe(1);
  });

  it('UNIVERSAL 标识（内置源/启发式导入）→ 直接走 sourceUrl 匹配', () => {
    const { registry, calls } = makeRegistry({ byUrl: builtinAdapter });
    const result = resolveCurrentSourceAdapter(
      { bookSourceUuid: UNIVERSAL_BOOK_SOURCE_UUID, sourceUrl: 'https://www.xbiquge.cc/book/9/' },
      registry,
    );
    expect(result).toBe(builtinAdapter);
    expect(calls.getByUuid).toBe(0); // UNIVERSAL 不应查 uuid
  });

  it('老数据：无 bookSourceUuid 有 sourceUrl → URL 匹配', () => {
    const { registry } = makeRegistry({ byUrl: builtinAdapter });
    const result = resolveCurrentSourceAdapter(
      { bookSourceUuid: undefined, sourceUrl: 'https://www.xbiquge.cc/book/9/' },
      registry,
    );
    expect(result).toBe(builtinAdapter);
  });

  it('uuid 与 URL 两头都落空 → undefined（不预选）', () => {
    const { registry } = makeRegistry({});
    expect(
      resolveCurrentSourceAdapter({ bookSourceUuid: undefined, sourceUrl: undefined }, registry),
    ).toBeUndefined();
    expect(
      resolveCurrentSourceAdapter(
        { bookSourceUuid: 'uuid-gone', sourceUrl: 'https://x.com/b/1' },
        registry,
      ),
    ).toBeUndefined();
  });
});
