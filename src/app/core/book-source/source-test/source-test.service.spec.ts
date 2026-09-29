import { describe, it, expect, vi } from 'vitest';
import {
  SourceTestService,
  pickBookUrl,
  pickChapterUrl,
  extractChapters,
} from './source-test.service';
import { type BookSourceMeta } from '../source-meta.types';

describe('pickBookUrl', () => {
  it('优先取 bookUrl，回退 url', () => {
    expect(pickBookUrl([{ name: 'a', bookUrl: 'https://x/b/1' }])).toBe('https://x/b/1');
    expect(pickBookUrl([{ name: 'a', url: 'https://x/b/2' }])).toBe('https://x/b/2');
    expect(pickBookUrl([{ bookUrl: ' https://x/b/3 ' }])).toBe('https://x/b/3');
  });
  it('跳过空项与非字符串，找不到返回空串', () => {
    expect(pickBookUrl([null, 42, { name: 'a' }, { url: '  ' }, { url: 'https://x' }])).toBe(
      'https://x',
    );
    expect(pickBookUrl([])).toBe('');
    expect(pickBookUrl([{ name: 'a' }])).toBe('');
  });
});

describe('pickChapterUrl', () => {
  it('取第一个非空 url', () => {
    expect(pickChapterUrl([{ name: '第1章', url: 'https://x/c/1' }])).toBe('https://x/c/1');
    expect(pickChapterUrl([{ name: '无url' }, { url: 'https://x/c/2' }])).toBe('https://x/c/2');
  });
  it('找不到返回空串', () => {
    expect(pickChapterUrl([])).toBe('');
    expect(pickChapterUrl([{ name: 'x' }])).toBe('');
  });
});

describe('extractChapters', () => {
  it('按 chapters / toc / list / chapterList 顺序取第一个数组字段', () => {
    expect(extractChapters({ title: 't', chapters: [1, 2] })).toEqual([1, 2]);
    expect(extractChapters({ toc: [1] })).toEqual([1]);
    expect(extractChapters({ list: [1], chapterList: [2] })).toEqual([1]);
  });
  it('非对象或无章节数组返回空', () => {
    expect(extractChapters(null)).toEqual([]);
    expect(extractChapters('str')).toEqual([]);
    expect(extractChapters({ title: 't' })).toEqual([]);
  });
});

// ========== SourceTestService.runTest 步骤链（P3：JS 沙箱 → RuleEngineService） ==========

type BooksourceRead = (fileName: string, sourceDir?: string | null) => Promise<string>;

interface MockEngine {
  search: (meta: BookSourceMeta, keyword: string, page: number) => Promise<unknown[]>;
  bookInfo: (meta: BookSourceMeta, bookUrl: string) => Promise<unknown>;
  chapterList: (meta: BookSourceMeta, bookUrl: string) => Promise<unknown[]>;
  chapterContent: (meta: BookSourceMeta, chapterUrl: string) => Promise<string>;
}

/** 与 ImportViaSourceService.forTest 同模式：Object.create 绕开 inject()，手动注入 mock 引擎 */
function makeService(engine: MockEngine): SourceTestService {
  const svc = Object.create(SourceTestService.prototype) as SourceTestService;
  (svc as unknown as { engine: MockEngine }).engine = engine;
  return svc;
}

function makeMeta(): BookSourceMeta {
  return {
    sourceKey: 'uuid-test',
    uuid: 'uuid-test',
    fileName: 'test.json',
    name: 'test',
    url: 'https://example.com',
    urls: ['https://example.com'],
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

/** mock 引擎：按入口名分发到 handlers（未 mock 的入口抛错防漏配） */
function makeEngine(handlers: {
  search?: (keyword: string) => unknown;
  bookInfo?: (bookUrl: string) => unknown;
  chapterList?: (bookUrl: string) => unknown;
  chapterContent?: (chapterUrl: string) => unknown;
}): MockEngine {
  return {
    search: async (_m, keyword) => {
      if (!handlers.search) throw new Error('未 mock 的引擎调用: search');
      return handlers.search(keyword) as unknown[];
    },
    bookInfo: async (_m, bookUrl) => {
      if (!handlers.bookInfo) throw new Error('未 mock 的引擎调用: bookInfo');
      return handlers.bookInfo(bookUrl);
    },
    chapterList: async (_m, bookUrl) => {
      if (!handlers.chapterList) throw new Error('未 mock 的引擎调用: chapterList');
      return handlers.chapterList(bookUrl) as unknown[];
    },
    chapterContent: async (_m, chapterUrl) => {
      if (!handlers.chapterContent) throw new Error('未 mock 的引擎调用: chapterContent');
      return handlers.chapterContent(chapterUrl) as string;
    },
  };
}

/** 设置/恢复 window.pomAPI.booksourceRead（与 import-via-source.service.spec.ts 同模式） */
async function withPomApi<T>(
  pomApi: { booksourceRead?: BooksourceRead } | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const w = window as unknown as { pomAPI?: { booksourceRead?: BooksourceRead } };
  const orig = w.pomAPI;
  if (pomApi === undefined) delete w.pomAPI;
  else w.pomAPI = pomApi;
  try {
    return await fn();
  } finally {
    if (orig === undefined) delete w.pomAPI;
    else w.pomAPI = orig;
  }
}

const read: BooksourceRead = async () => '{"format":"pomreader.booksource"}';

describe('SourceTestService.runTest', () => {
  it('window.pomAPI 缺失 → load 步骤失败，不进入引擎', async () => {
    const svc = makeService(makeEngine({}));
    const result = await withPomApi(undefined, () => svc.runTest(makeMeta(), '庆余年'));
    expect(result.fileName).toBe('test.json');
    expect(result.allPassed).toBe(false);
    expect(result.steps).toEqual([
      { step: 'load', passed: false, message: 'booksourceRead IPC 不可用', durationMs: 0 },
    ]);
  });

  it('booksourceRead 抛错 → load 步骤失败并透传错误消息', async () => {
    const svc = makeService(makeEngine({}));
    const result = await withPomApi(
      {
        booksourceRead: async () => {
          throw new Error('磁盘读取失败');
        },
      },
      () => svc.runTest(makeMeta(), '庆余年'),
    );
    expect(result.allPassed).toBe(false);
    expect(result.steps).toEqual([
      { step: 'load', passed: false, message: '磁盘读取失败', durationMs: 0 },
    ]);
  });

  it('search 失败（无结果）→ 后续步骤跳过，chapterContent 标记无章节 URL 可测', async () => {
    const svc = makeService(makeEngine({ search: () => [] }));
    const result = await withPomApi({ booksourceRead: read }, () =>
      svc.runTest(makeMeta(), '庆余年'),
    );
    expect(result.allPassed).toBe(false);
    expect(result.steps.map((s) => [s.step, s.passed, s.message])).toEqual([
      ['search', false, '搜索「庆余年」无结果'],
      ['chapterContent', false, '无章节 URL 可测'],
    ]);
  });

  it('search 校验分支：非数组 / 空数组 / 结果项缺 url 分别报对应错误', async () => {
    await withPomApi({ booksourceRead: read }, async () => {
      const meta = makeMeta();
      const r1 = await makeService(makeEngine({ search: () => 'not-array' })).runTest(meta, 'kw');
      expect(r1.steps[0]).toMatchObject({ step: 'search', passed: false, message: '返回值非数组' });

      const r2 = await makeService(makeEngine({ search: () => [] })).runTest(meta, 'kw');
      expect(r2.steps[0]).toMatchObject({
        step: 'search',
        passed: false,
        message: '搜索「kw」无结果',
      });

      const r3 = await makeService(makeEngine({ search: () => [{ name: 'a' }] })).runTest(
        meta,
        'kw',
      );
      expect(r3.steps[0]).toMatchObject({
        step: 'search',
        passed: false,
        message: '结果项缺 url/bookUrl',
      });
    });
  });

  it('search 抛 Error → catch 分支记录 message；抛非 Error 值 → String(e) 兜底', async () => {
    await withPomApi({ booksourceRead: read }, async () => {
      const meta = makeMeta();
      const r1 = await makeService(
        makeEngine({
          search: () => {
            throw new Error('网络超时');
          },
        }),
      ).runTest(meta, 'kw');
      expect(r1.steps[0]).toMatchObject({ step: 'search', passed: false, message: '网络超时' });

      const r2 = await makeService(
        makeEngine({
          search: () => {
            throw '字符串错误';
          },
        }),
      ).runTest(meta, 'kw');
      expect(r2.steps[0]).toMatchObject({ step: 'search', passed: false, message: '字符串错误' });
    });
  });

  it('bookInfo 失败 → 回退 chapterList 入口 + chapterContent 链路仍可成功', async () => {
    const svc = makeService(
      makeEngine({
        search: () => [{ name: '书A', url: 'https://a/b/1' }],
        bookInfo: () => {
          throw new Error('详情页 404');
        },
        chapterList: () => [{ name: '第1章', url: 'https://a/c/1' }],
        chapterContent: () => '正文内容',
      }),
    );
    const result = await withPomApi({ booksourceRead: read }, () => svc.runTest(makeMeta(), 'kw'));
    expect(result.allPassed).toBe(false); // bookInfo 失败 → 不全通过
    expect(result.steps.map((s) => [s.step, s.passed, s.message])).toEqual([
      ['search', true, '命中 1 条'],
      ['bookInfo', false, '详情页 404'],
      ['chapterList', true, '共 1 章'],
      ['chapterContent', true, '正文 4 字符'],
    ]);
  });

  it('全链路成功：bookInfo 含章节 → chapterList 复用 bookInfo 结果', async () => {
    const svc = makeService(
      makeEngine({
        search: () => [{ name: '书A', bookUrl: 'https://a/b/1' }],
        bookInfo: () => ({
          title: '测试书',
          author: '测试作者',
          chapters: [{ name: '第1章', url: 'https://a/c/1' }],
        }),
        chapterContent: () => 'abc',
      }),
    );
    const result = await withPomApi({ booksourceRead: read }, () => svc.runTest(makeMeta(), 'kw'));
    expect(result.allPassed).toBe(true);
    expect(result.steps.map((s) => [s.step, s.passed, s.message])).toEqual([
      ['search', true, '命中 1 条'],
      ['bookInfo', true, '《测试书》 测试作者'],
      ['chapterList', true, '共 1 章（来自 bookInfo）'],
      ['chapterContent', true, '正文 3 字符'],
    ]);
  });

  it('bookInfo 仅有 name 字段（无 title/author）也通过校验，ok 消息回退 name', async () => {
    const svc = makeService(
      makeEngine({
        search: () => [{ url: 'https://a/b/1' }],
        bookInfo: () => ({ name: '无名书', chapters: [{ url: 'https://a/c/1' }] }),
        chapterContent: () => 'x',
      }),
    );
    const result = await withPomApi({ booksourceRead: read }, () => svc.runTest(makeMeta(), 'kw'));
    const infoStep = result.steps.find((s) => s.step === 'bookInfo');
    expect(infoStep).toMatchObject({ passed: true, message: '《无名书》' });
    expect(result.allPassed).toBe(true);
  });

  it('bookInfo 校验分支：返回值非对象 / 缺 title 与 name 字段', async () => {
    await withPomApi({ booksourceRead: read }, async () => {
      const meta = makeMeta();
      const base = { search: () => [{ url: 'https://a/b/1' }] };
      const r1 = await makeService(makeEngine({ ...base, bookInfo: () => 'str' })).runTest(
        meta,
        'kw',
      );
      expect(r1.steps.find((s) => s.step === 'bookInfo')).toMatchObject({
        passed: false,
        message: '返回值非对象',
      });

      const r2 = await makeService(
        makeEngine({ ...base, bookInfo: () => ({ author: 'a' }) }),
      ).runTest(meta, 'kw');
      expect(r2.steps.find((s) => s.step === 'bookInfo')).toMatchObject({
        passed: false,
        message: '缺 title/name 字段',
      });
    });
  });

  it('bookInfo 无章节 → 回退 chapterList 入口：非数组与空目录分别报错', async () => {
    await withPomApi({ booksourceRead: read }, async () => {
      const meta = makeMeta();
      const base = {
        search: () => [{ url: 'https://a/b/1' }],
        bookInfo: () => ({ title: '书A' }),
      };
      const r1 = await makeService(makeEngine({ ...base, chapterList: () => null })).runTest(
        meta,
        'kw',
      );
      expect(r1.steps.find((s) => s.step === 'chapterList')).toMatchObject({
        passed: false,
        message: '返回值非数组',
      });

      const r2 = await makeService(makeEngine({ ...base, chapterList: () => [] })).runTest(
        meta,
        'kw',
      );
      expect(r2.steps.find((s) => s.step === 'chapterList')).toMatchObject({
        passed: false,
        message: '目录为空',
      });
    });
  });

  it('chapterContent 校验分支：非字符串 / 空白字符串', async () => {
    await withPomApi({ booksourceRead: read }, async () => {
      const meta = makeMeta();
      const base = {
        search: () => [{ url: 'https://a/b/1' }],
        bookInfo: () => ({ title: '书A', chapters: [{ url: 'https://a/c/1' }] }),
      };
      const r1 = await makeService(
        makeEngine({ ...base, chapterContent: () => 42 as unknown as string }),
      ).runTest(meta, 'kw');
      expect(r1.steps.find((s) => s.step === 'chapterContent')).toMatchObject({
        passed: false,
        message: '返回值非字符串',
      });

      const r2 = await makeService(makeEngine({ ...base, chapterContent: () => '   ' })).runTest(
        meta,
        'kw',
      );
      expect(r2.steps.find((s) => s.step === 'chapterContent')).toMatchObject({
        passed: false,
        message: '正文为空',
      });
    });
  });

  it('单项超时：search 悬挂 → withTimeout 按剩余时间拒绝并报步骤超时', async () => {
    vi.useFakeTimers();
    try {
      const svc = makeService(makeEngine({ search: () => new Promise(() => {}) }));
      const promise = withPomApi({ booksourceRead: read }, () => svc.runTest(makeMeta(), 'kw', 30));
      await vi.advanceTimersByTimeAsync(30_000);
      const result = await promise;
      expect(result.allPassed).toBe(false);
      expect(result.steps.map((s) => [s.step, s.passed, s.message])).toEqual([
        ['search', false, '步骤超时（30s）'],
        ['chapterContent', false, '无章节 URL 可测'],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('总超时：deadline 已过 → run 直接失败且不调用引擎入口', async () => {
    const searchSpy = vi.fn(() => [{ url: 'https://a/b/1' }]);
    const svc = makeService(makeEngine({ search: searchSpy }));
    const result = await withPomApi({ booksourceRead: read }, () =>
      svc.runTest(makeMeta(), 'kw', -1),
    );
    expect(searchSpy).not.toHaveBeenCalled();
    expect(result.allPassed).toBe(false);
    expect(result.steps[0]).toMatchObject({
      step: 'search',
      passed: false,
      message: '超出单项总超时 -1s',
      durationMs: 0,
    });
  });
});
