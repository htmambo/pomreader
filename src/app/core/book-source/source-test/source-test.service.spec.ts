import { describe, it, expect, vi } from 'vitest';
import {
  SourceTestService,
  pickBookUrl,
  pickChapterUrl,
  extractChapters,
} from './source-test.service';
import { type BookSourceMeta } from '../js-source/source-meta.types';

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

// ========== SourceTestService.runTest 步骤链 ==========

type BooksourceRead = (fileName: string, sourceDir?: string | null) => Promise<string>;

interface MockSandbox {
  load: (fileName: string, source: string) => Promise<{ fileName: string; fns: string[] }>;
  call: (fileName: string, fn: string, args: unknown[]) => Promise<unknown>;
}

/** 与 ImportViaSourceService.forTest 同模式：Object.create 绕开 inject()，手动注入 mock sandbox */
function makeService(sandbox: MockSandbox): SourceTestService {
  const svc = Object.create(SourceTestService.prototype) as SourceTestService;
  (svc as unknown as { sandbox: MockSandbox }).sandbox = sandbox;
  return svc;
}

function makeMeta(): BookSourceMeta {
  return {
    sourceKey: 'uuid-test',
    uuid: 'uuid-test',
    fileName: 'test.js',
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

/** mock 沙箱：load 返回固定 fns；call 按 fn 名分发到 handlers（未 mock 的调用抛错防漏配） */
function makeSandbox(
  fns: string[],
  handlers: Record<string, (args: unknown[]) => unknown> = {},
): MockSandbox {
  return {
    load: async (fileName) => ({ fileName, fns }),
    call: async (_file, fn, args) => {
      const h = handlers[fn];
      if (!h) throw new Error(`未 mock 的沙箱调用: ${fn}`);
      return h(args);
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

const read: BooksourceRead = async () => '// source';

describe('SourceTestService.runTest', () => {
  it('window.pomAPI 缺失 → load 步骤失败，不进入沙箱', async () => {
    const svc = makeService(makeSandbox(['search']));
    const result = await withPomApi(undefined, () => svc.runTest(makeMeta(), '庆余年'));
    expect(result.fileName).toBe('test.js');
    expect(result.allPassed).toBe(false);
    expect(result.steps).toEqual([
      { step: 'load', passed: false, message: 'booksourceRead IPC 不可用', durationMs: 0 },
    ]);
  });

  it('booksourceRead 抛错 → load 步骤失败并透传错误消息', async () => {
    const svc = makeService(makeSandbox(['search']));
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

  it('书源未定义 search() → search 失败；无 bookUrl 时 chapterContent 标记无章节 URL 可测', async () => {
    const svc = makeService(makeSandbox([]));
    const result = await withPomApi({ booksourceRead: read }, () =>
      svc.runTest(makeMeta(), '庆余年'),
    );
    expect(result.allPassed).toBe(false);
    expect(result.steps.map((s) => [s.step, s.passed, s.message])).toEqual([
      ['search', false, '书源未定义 search()'],
      ['chapterContent', false, '无章节 URL 可测'],
    ]);
  });

  it('search 校验分支：非数组 / 空数组 / 结果项缺 url 分别报对应错误', async () => {
    await withPomApi({ booksourceRead: read }, async () => {
      const meta = makeMeta();
      const r1 = await makeService(makeSandbox(['search'], { search: () => 'not-array' })).runTest(
        meta,
        'kw',
      );
      expect(r1.steps[0]).toMatchObject({ step: 'search', passed: false, message: '返回值非数组' });

      const r2 = await makeService(makeSandbox(['search'], { search: () => [] })).runTest(
        meta,
        'kw',
      );
      expect(r2.steps[0]).toMatchObject({
        step: 'search',
        passed: false,
        message: '搜索「kw」无结果',
      });

      const r3 = await makeService(
        makeSandbox(['search'], { search: () => [{ name: 'a' }] }),
      ).runTest(meta, 'kw');
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
        makeSandbox(['search'], {
          search: () => {
            throw new Error('网络超时');
          },
        }),
      ).runTest(meta, 'kw');
      expect(r1.steps[0]).toMatchObject({ step: 'search', passed: false, message: '网络超时' });

      const r2 = await makeService(
        makeSandbox(['search'], {
          search: () => {
            throw '字符串错误';
          },
        }),
      ).runTest(meta, 'kw');
      expect(r2.steps[0]).toMatchObject({ step: 'search', passed: false, message: '字符串错误' });
    });
  });

  it('有 bookUrl 但未定义 bookInfo() → 标记未定义；回退 toc() + content() 链路成功', async () => {
    const svc = makeService(
      makeSandbox(['search', 'toc', 'content'], {
        search: () => [{ name: '书A', url: 'https://a/b/1' }],
        toc: () => [{ name: '第1章', url: 'https://a/c/1' }],
        content: () => '正文内容',
      }),
    );
    const result = await withPomApi({ booksourceRead: read }, () => svc.runTest(makeMeta(), 'kw'));
    expect(result.allPassed).toBe(false); // bookInfo 失败 → 不全通过
    expect(result.steps.map((s) => [s.step, s.passed, s.message])).toEqual([
      ['search', true, '命中 1 条'],
      ['bookInfo', false, '书源未定义 bookInfo()'],
      ['chapterList', true, '共 1 章'],
      ['chapterContent', true, '正文 4 字符'],
    ]);
  });

  it('全链路成功：bookInfo 含章节 → chapterList 复用 bookInfo 结果，explore 通过', async () => {
    const svc = makeService(
      makeSandbox(['search', 'bookInfo', 'chapterContent', 'explore'], {
        search: () => [{ name: '书A', bookUrl: 'https://a/b/1' }],
        bookInfo: () => ({
          title: '测试书',
          author: '测试作者',
          chapters: [{ name: '第1章', url: 'https://a/c/1' }],
        }),
        chapterContent: () => 'abc',
        explore: () => [{ name: '分类' }],
      }),
    );
    const result = await withPomApi({ booksourceRead: read }, () => svc.runTest(makeMeta(), 'kw'));
    expect(result.allPassed).toBe(true);
    expect(result.steps.map((s) => [s.step, s.passed, s.message])).toEqual([
      ['search', true, '命中 1 条'],
      ['bookInfo', true, '《测试书》 测试作者'],
      ['chapterList', true, '共 1 章（来自 bookInfo）'],
      ['chapterContent', true, '正文 3 字符'],
      ['explore', true, 'explore 可调用'],
    ]);
  });

  it('bookInfo 仅有 name 字段（无 title/author）也通过校验，ok 消息回退 name', async () => {
    const svc = makeService(
      makeSandbox(['search', 'bookInfo', 'chapterContent'], {
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
      const r1 = await makeService(
        makeSandbox(['search', 'bookInfo'], { ...base, bookInfo: () => 'str' }),
      ).runTest(meta, 'kw');
      expect(r1.steps.find((s) => s.step === 'bookInfo')).toMatchObject({
        passed: false,
        message: '返回值非对象',
      });

      const r2 = await makeService(
        makeSandbox(['search', 'bookInfo'], { ...base, bookInfo: () => ({ author: 'a' }) }),
      ).runTest(meta, 'kw');
      expect(r2.steps.find((s) => s.step === 'bookInfo')).toMatchObject({
        passed: false,
        message: '缺 title/name 字段',
      });
    });
  });

  it('bookInfo 无章节 → 回退 chapterList()：非数组与空目录分别报错', async () => {
    await withPomApi({ booksourceRead: read }, async () => {
      const meta = makeMeta();
      const base = {
        search: () => [{ url: 'https://a/b/1' }],
        bookInfo: () => ({ title: '书A' }),
      };
      const r1 = await makeService(
        makeSandbox(['search', 'bookInfo', 'chapterList'], { ...base, chapterList: () => null }),
      ).runTest(meta, 'kw');
      expect(r1.steps.find((s) => s.step === 'chapterList')).toMatchObject({
        passed: false,
        message: '返回值非数组',
      });

      const r2 = await makeService(
        makeSandbox(['search', 'bookInfo', 'chapterList'], { ...base, chapterList: () => [] }),
      ).runTest(meta, 'kw');
      expect(r2.steps.find((s) => s.step === 'chapterList')).toMatchObject({
        passed: false,
        message: '目录为空',
      });
    });
  });

  it('chapterList 回退成功 + explore 返回 null 失败但不计入 allPassed', async () => {
    const svc = makeService(
      makeSandbox(['search', 'bookInfo', 'chapterList', 'chapterContent', 'explore'], {
        search: () => [{ url: 'https://a/b/1' }],
        bookInfo: () => ({ title: '书A' }),
        chapterList: () => [{ name: '第1章', url: 'https://a/c/1' }],
        chapterContent: () => '正文',
        explore: () => null,
      }),
    );
    const result = await withPomApi({ booksourceRead: read }, () => svc.runTest(makeMeta(), 'kw'));
    expect(result.steps.find((s) => s.step === 'chapterList')).toMatchObject({
      passed: true,
      message: '共 1 章',
    });
    expect(result.steps.find((s) => s.step === 'explore')).toMatchObject({
      passed: false,
      message: '返回 null',
    });
    expect(result.allPassed).toBe(true); // explore 不参与 allPassed
  });

  it('chapterContent 校验分支：非字符串 / 空白字符串 / 未定义 content 函数', async () => {
    await withPomApi({ booksourceRead: read }, async () => {
      const meta = makeMeta();
      const base = {
        search: () => [{ url: 'https://a/b/1' }],
        bookInfo: () => ({ title: '书A', chapters: [{ url: 'https://a/c/1' }] }),
      };
      const r1 = await makeService(
        makeSandbox(['search', 'bookInfo', 'chapterContent'], {
          ...base,
          chapterContent: () => 42,
        }),
      ).runTest(meta, 'kw');
      expect(r1.steps.find((s) => s.step === 'chapterContent')).toMatchObject({
        passed: false,
        message: '返回值非字符串',
      });

      const r2 = await makeService(
        makeSandbox(['search', 'bookInfo', 'chapterContent'], {
          ...base,
          chapterContent: () => '   ',
        }),
      ).runTest(meta, 'kw');
      expect(r2.steps.find((s) => s.step === 'chapterContent')).toMatchObject({
        passed: false,
        message: '正文为空',
      });

      const r3 = await makeService(makeSandbox(['search', 'bookInfo'], base)).runTest(meta, 'kw');
      expect(r3.steps.find((s) => s.step === 'chapterContent')).toMatchObject({
        passed: false,
        message: '书源未定义 chapterContent()/content()',
      });
    });
  });

  it('单项超时：search 悬挂 → withTimeout 按剩余时间拒绝并报步骤超时', async () => {
    vi.useFakeTimers();
    try {
      const svc = makeService(makeSandbox(['search'], { search: () => new Promise(() => {}) }));
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

  it('总超时：deadline 已过 → run 直接失败且不调用沙箱函数', async () => {
    const searchSpy = vi.fn(() => [{ url: 'https://a/b/1' }]);
    const svc = makeService(makeSandbox(['search'], { search: searchSpy }));
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
