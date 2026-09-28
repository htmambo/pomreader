/**
 * BookService facade 未覆盖分支补充（Phase 5 覆盖率收紧）
 *
 * 覆盖（与 book.service.spec.ts / 各专项 spec 互补，不重复）：
 * - load()：repo 成功镜像 / ready 态短路 / 失败置 error 并抛出
 * - getById / getChapters / getChaptersSync（loader 委托 + 缓存镜像）
 * - addBook：同 id 原地更新 / 空章节数组跳过章节持久化
 * - importOnlineBook：目录 → 章节创建 + 前 3 章预加载（PRELOAD_COUNT）
 * - refreshBookInfo：错误分支（书不存在 / 非 online / 缺 sourceUrl）+
 *   元数据合并（resolved 优先，空值回落旧值）+ sourceName 查找
 * - refreshChapters：_chaptersCache 命中分支（跳过 db.chapterAll）+ 缓存与 db 均空分支
 * - updateProgress：内存镜像更新 / updater 抛错 console.warn 兜底仍镜像 / 书不在书架 no-op
 * - 章节操作委托：loadChapterContent / refreshChapter / clearChapterContents / updateChapter
 *   透传到 ChapterLoader（参数与返回值不变）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { signal, computed } from '@angular/core';
import { BookService } from './book.service';
import { BookSourceRegistry } from '../book-source/book-source.registry';
import { BookSourceAdapter, PageFetcher, ResolvedBook } from '../book-source/book-source.adapter';
import { ImportViaSourceService } from '../book-source/import-via-source.service';
import { type BookRepositoryPort } from './book.repository';
import { Book } from '../models/book.model';
import { Chapter } from '../models/chapter.model';

function emptyFetcher(): PageFetcher {
  return {
    fetchHtml: async () => '',
    fetchRendered: async () => '',
  };
}

class StubAdapter implements BookSourceAdapter {
  constructor(
    public readonly name: string,
    public readonly meta?: { uuid?: string },
  ) {}
  match(): boolean {
    return true;
  }
  async fetchCatalog(): Promise<ResolvedBook> {
    return { title: 'stub', author: 'stub', chapters: [{ title: 'ch1', url: 'http://a/1' }] };
  }
  async fetchChapter(): Promise<string> {
    return '抓取的正文';
  }
}

function makeBook(overrides: Partial<Book> = {}): Book {
  return {
    id: 'book-1',
    title: '连城诀',
    author: '金庸',
    chapterCount: 0,
    totalChars: 0,
    importedAt: '2026-01-01T00:00:00.000Z',
    lastReadAt: '2026-02-01T12:00:00.000Z',
    source: 'online',
    sourceUrl: 'https://old.example.com/book/1',
    bookSourceUuid: 'stub-uuid',
    ...overrides,
  };
}

function makeChapter(bookId: string, idx: number, overrides: Partial<Chapter> = {}): Chapter {
  return {
    bookId,
    index: idx,
    title: `第${idx + 1}章`,
    content: '',
    sourceUrl: `http://old/${idx + 1}`,
    loaded: false,
    ...overrides,
  };
}

/** 假 DbService：内存 chapters + books，实现 facade 链路需要的最小接口 */
function makeFakeDb(initialChapters: Chapter[] = []) {
  let chapters = [...initialChapters];
  const fakeDb = {
    bookPut: vi.fn(async () => undefined),
    bookDelete: vi.fn(async (id: string) => {
      chapters = chapters.filter((c) => c.bookId !== id);
    }),
    chapterPut: vi.fn(async (ch: Chapter) => {
      const idx = chapters.findIndex((c) => c.bookId === ch.bookId && c.index === ch.index);
      if (idx >= 0) chapters[idx] = ch;
      else chapters.push(ch);
    }),
    chapterPutMany: vi.fn(async (chs: Chapter[]) => {
      for (const nc of chs) {
        const idx = chapters.findIndex((c) => c.index === nc.index && c.bookId === nc.bookId);
        if (idx >= 0) chapters[idx] = nc;
        else chapters.push(nc);
      }
    }),
    chapterAll: vi.fn(async (bookId: string) =>
      chapters.filter((c) => c.bookId === bookId).sort((a, b) => a.index - b.index),
    ),
    chapterGet: vi.fn(
      async (bookId: string, index: number) =>
        chapters.find((c) => c.bookId === bookId && c.index === index) ?? null,
    ),
  };
  return { fakeDb };
}

/** 假 ImportViaSourceService：直接 resolve 到给定的 ResolvedBook */
function makeFakeImportViaSource(resolved: ResolvedBook, uuid: string): ImportViaSourceService {
  const svc = Object.create(ImportViaSourceService.prototype);
  svc.importByUrl = vi.fn(async () => ({ book: resolved, bookSourceUuid: uuid }));
  svc.supportedSources = vi.fn(() => ['stub']);
  return svc as ImportViaSourceService;
}

interface SvcOptions {
  chapters?: Chapter[];
  resolved?: ResolvedBook;
  repo?: BookRepositoryPort;
  loader?: Parameters<typeof BookService.forTest>[4];
  updater?: Parameters<typeof BookService.forTest>[5];
}

function makeSvc(opts: SvcOptions = {}) {
  const { fakeDb } = makeFakeDb(opts.chapters);
  const registry = BookSourceRegistry.forTest(emptyFetcher());
  registry.register(new StubAdapter('stub', { uuid: 'stub-uuid' }));
  const importViaSource = makeFakeImportViaSource(
    opts.resolved ?? { title: '新标题', author: '新作者', chapters: [] },
    'stub-uuid',
  );
  const svc = BookService.forTest(
    fakeDb as never,
    registry,
    importViaSource,
    opts.repo,
    opts.loader,
    opts.updater,
  );
  return { svc, fakeDb, registry, importViaSource };
}

/** 自定义 repo stub（load 链路用）：books / loadState 由测试控制 */
function makeRepoStub(init: {
  books?: Book[];
  loadState?: 'idle' | 'loading' | 'ready' | 'error';
}) {
  const books = signal<Book[]>(init.books ?? []);
  const loadState = signal<'idle' | 'loading' | 'ready' | 'error'>(init.loadState ?? 'idle');
  const repo: BookRepositoryPort = {
    books: books.asReadonly(),
    loadState: loadState.asReadonly(),
    count: computed(() => books().length),
    getById: (id: string) => books().find((b) => b.id === id),
    load: vi.fn(async () => undefined),
    persistBook: vi.fn(async () => undefined),
    persistChapters: vi.fn(async () => undefined),
    deleteBook: vi.fn(async () => undefined),
  };
  return { repo, books, loadState };
}

describe('BookService.load', () => {
  it('repo.load 成功后应镜像 books 与 loadState', async () => {
    const { repo } = makeRepoStub({ books: [makeBook()], loadState: 'ready' });
    const { svc } = makeSvc({ repo });
    await svc.load();
    expect(repo.load).toHaveBeenCalledTimes(1);
    expect(svc.loadState()).toBe('ready');
    expect(svc.books()).toHaveLength(1);
    expect(svc.books()[0].id).toBe('book-1');
  });

  it('loadState 已为 ready 时重复 load 应短路（不再调 repo.load）', async () => {
    const { repo } = makeRepoStub({ loadState: 'ready' });
    const { svc } = makeSvc({ repo });
    await svc.load();
    await svc.load();
    expect(repo.load).toHaveBeenCalledTimes(1);
  });

  it('repo.load 失败应置 error 状态、记录日志并抛出', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { repo } = makeRepoStub({});
      (repo.load as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'));
      const { svc } = makeSvc({ repo });
      await expect(svc.load()).rejects.toThrow('boom');
      expect(svc.loadState()).toBe('error');
      expect(err).toHaveBeenCalledWith('[BookService.load] failed', expect.any(Error));
    } finally {
      err.mockRestore();
    }
  });
});

describe('BookService.getById / getChapters / getChaptersSync', () => {
  let svc: BookService;
  let fakeDb: ReturnType<typeof makeFakeDb>['fakeDb'];

  beforeEach(() => {
    const made = makeSvc({ chapters: [makeChapter('book-1', 0), makeChapter('book-1', 1)] });
    svc = made.svc;
    fakeDb = made.fakeDb;
  });

  it('getById 命中应返回书，未命中应返回 undefined', async () => {
    await svc.addBook(makeBook(), []);
    expect(svc.getById('book-1')?.title).toBe('连城诀');
    expect(svc.getById('ghost')).toBeUndefined();
  });

  it('getChapters 应从 db 拉取并使 getChaptersSync 可读', async () => {
    expect(svc.getChaptersSync('book-1')).toBeUndefined();
    const chs = await svc.getChapters('book-1');
    expect(chs).toHaveLength(2);
    expect(fakeDb.chapterAll).toHaveBeenCalledWith('book-1');
    expect(svc.getChaptersSync('book-1')).toHaveLength(2);
  });

  it('getChaptersSync 未加载时应返回 undefined', () => {
    expect(svc.getChaptersSync('never-loaded')).toBeUndefined();
  });
});

describe('BookService.addBook 分支', () => {
  it('同 id 再次 addBook 应原地更新而非追加', async () => {
    const { svc } = makeSvc();
    await svc.addBook(makeBook({ title: '旧名' }), []);
    await svc.addBook(makeBook({ title: '新名' }), []);
    expect(svc.count()).toBe(1);
    expect(svc.getById('book-1')?.title).toBe('新名');
  });

  it('chapters 为空数组时应跳过章节持久化', async () => {
    const { svc, fakeDb } = makeSvc();
    await svc.addBook(makeBook(), []);
    expect(fakeDb.chapterPutMany).not.toHaveBeenCalled();
  });
});

describe('BookService.importOnlineBook', () => {
  it('应根据目录创建 unloaded 章节并预加载前 3 章正文', async () => {
    const { svc, fakeDb } = makeSvc();
    const catalog = Array.from({ length: 5 }, (_, i) => ({
      title: `第${i + 1}章`,
      url: `http://new/${i + 1}`,
    }));
    await svc.importOnlineBook(makeBook(), catalog);

    // 目录 → 5 个 unloaded 章节入库
    const persisted = fakeDb.chapterPutMany.mock.calls[0][0] as Chapter[];
    expect(persisted).toHaveLength(5);
    expect(persisted[0]).toMatchObject({
      bookId: 'book-1',
      index: 0,
      title: '第1章',
      sourceUrl: 'http://new/1',
      content: '',
      loaded: false,
    });
    // 预加载仅覆盖前 PRELOAD_COUNT=3 章：chapterPut（单章写回正文）恰好 3 次
    expect(fakeDb.chapterPut).toHaveBeenCalledTimes(3);
    const loadedIdx = fakeDb.chapterPut.mock.calls.map((c) => (c[0] as Chapter).index).sort();
    expect(loadedIdx).toEqual([0, 1, 2]);
    for (const call of fakeDb.chapterPut.mock.calls) {
      expect((call[0] as Chapter).content).toBe('抓取的正文');
      expect((call[0] as Chapter).loaded).toBe(true);
    }
  });
});

describe('BookService.refreshBookInfo', () => {
  it('书不存在应抛 FetchError(source-unavailable)', async () => {
    const { svc } = makeSvc();
    await expect(svc.refreshBookInfo('ghost')).rejects.toMatchObject({
      code: 'source-unavailable',
    });
  });

  it('非 online 来源应抛 FetchError(unsupported-source)', async () => {
    const { svc } = makeSvc();
    (svc as any)._books.set([makeBook({ source: 'local-txt' })]);
    await expect(svc.refreshBookInfo('book-1')).rejects.toMatchObject({
      code: 'unsupported-source',
    });
  });

  it('缺少 sourceUrl 应抛 FetchError(parse-failed)', async () => {
    const { svc } = makeSvc();
    (svc as any)._books.set([makeBook({ sourceUrl: undefined })]);
    await expect(svc.refreshBookInfo('book-1')).rejects.toMatchObject({
      code: 'parse-failed',
    });
  });

  it('应按 resolved 刷新元数据并保留 user-bound 字段（返回合并后的 Book）', async () => {
    const resolved: ResolvedBook = {
      title: '连城诀（修订版）',
      author: '金庸 新修',
      kind: '武侠',
      coverImageUrl: 'http://img/new-cover',
      chapters: [],
    };
    const { svc, fakeDb, importViaSource } = makeSvc({ resolved });
    (svc as any)._books.set([makeBook({ kind: '旧题材' })]);
    const merged = await svc.refreshBookInfo('book-1');

    expect(merged.title).toBe('连城诀（修订版）');
    expect(merged.author).toBe('金庸 新修');
    expect(merged.kind).toBe('武侠');
    expect(merged.coverImageUrl).toBe('http://img/new-cover');
    // user-bound 字段保留
    expect(merged.id).toBe('book-1');
    expect(merged.importedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(merged.sourceUrl).toBe('https://old.example.com/book/1');
    // 不写章节（chapters 参数为空数组）但书持久化
    expect(fakeDb.bookPut).toHaveBeenCalledWith(merged);
    expect(fakeDb.chapterPutMany).not.toHaveBeenCalled();
    // sourceName 由 bookSourceUuid 查得
    expect(importViaSource.importByUrl).toHaveBeenCalledWith(
      'https://old.example.com/book/1',
      'stub',
    );
  });

  it('resolved 空 title/author/kind/cover 应回落到旧值', async () => {
    const resolved: ResolvedBook = { title: '', author: '', chapters: [] };
    const { svc } = makeSvc({ resolved });
    (svc as any)._books.set([makeBook({ kind: '旧题材', coverImageUrl: 'data:old-cover' })]);
    const merged = await svc.refreshBookInfo('book-1');
    expect(merged.title).toBe('连城诀');
    expect(merged.author).toBe('金庸');
    expect(merged.kind).toBe('旧题材');
    expect(merged.coverImageUrl).toBe('data:old-cover');
  });

  it('bookSourceUuid 查不到对应书源时应传 undefined sourceName', async () => {
    const { svc, importViaSource } = makeSvc();
    (svc as any)._books.set([makeBook({ bookSourceUuid: 'unknown-uuid' })]);
    await svc.refreshBookInfo('book-1');
    expect(importViaSource.importByUrl).toHaveBeenCalledWith(
      'https://old.example.com/book/1',
      undefined,
    );
  });
});

describe('BookService.refreshChapters 缓存分支', () => {
  it('_chaptersCache 已有章节时应优先用缓存（不调 db.chapterAll）', async () => {
    const resolved: ResolvedBook = {
      title: '连城诀',
      author: '金庸',
      chapters: [
        { title: '第1章', url: 'http://old/1' }, // 与缓存重复 → 跳过
        { title: '第2章', url: 'http://old/2' }, // 新增
      ],
    };
    const { svc, fakeDb } = makeSvc({ resolved });
    // addBook 镜像填充 _chaptersCache（loader 缓存为空不影响本路径）
    await svc.addBook(makeBook(), [makeChapter('book-1', 0)]);
    const result = await svc.refreshChapters('book-1');

    expect(result).toEqual({ added: 1, skipped: 1, total: 2 });
    expect(fakeDb.chapterAll).not.toHaveBeenCalled();
    // 新章追加在 index 1
    const persisted = fakeDb.chapterPutMany.mock.calls.at(-1)?.[0] as Chapter[];
    expect(persisted).toHaveLength(2);
    expect(persisted[1]).toMatchObject({ index: 1, title: '第2章', sourceUrl: 'http://old/2' });
  });

  it('缓存与 db 均为空时应从 index 0 开始全部视为新增', async () => {
    const resolved: ResolvedBook = {
      title: '连城诀',
      author: '金庸',
      chapters: [
        { title: '第1章', url: 'http://old/1' },
        { title: '第2章', url: 'http://old/2' },
      ],
    };
    const { svc, fakeDb } = makeSvc({ resolved });
    (svc as any)._books.set([makeBook()]);
    const result = await svc.refreshChapters('book-1');

    expect(result).toEqual({ added: 2, skipped: 0, total: 2 });
    expect(fakeDb.chapterAll).toHaveBeenCalledWith('book-1'); // 缓存 miss → db 兜底
    const persisted = fakeDb.chapterPutMany.mock.calls.at(-1)?.[0] as Chapter[];
    expect(persisted.map((c) => c.index)).toEqual([0, 1]);
  });
});

describe('BookService.updateProgress', () => {
  it('应更新内存镜像的 progress 与 lastReadAt', async () => {
    const { svc } = makeSvc();
    await svc.addBook(makeBook(), []);
    await svc.updateProgress('book-1', 3, 120);
    const b = svc.getById('book-1');
    expect(b?.progress?.chapterIndex).toBe(3);
    expect(b?.progress?.scrollOffset).toBe(120);
    expect(b?.lastReadAt).not.toBe('2026-02-01T12:00:00.000Z'); // 已刷新
  });

  it('updater 抛错时应 console.warn 兜底且仍更新内存镜像', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const failingUpdater = {
        updateProgress: vi.fn(async () => {
          throw new Error('db down');
        }),
      };
      const { svc } = makeSvc({ updater: failingUpdater as never });
      await svc.addBook(makeBook(), []);
      await expect(svc.updateProgress('book-1', 5, 10)).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith('[BookService.updateProgress] failed', expect.any(Error));
      // 兜底后内存镜像仍刷新（reader 不因此丢进度显示）
      expect(svc.getById('book-1')?.progress?.chapterIndex).toBe(5);
    } finally {
      warn.mockRestore();
    }
  });

  it('书不在书架时应为 no-op（不新增、不抛错）', async () => {
    const { svc } = makeSvc();
    await expect(svc.updateProgress('ghost', 1)).resolves.toBeUndefined();
    expect(svc.count()).toBe(0);
  });
});

describe('BookService 章节操作委托 ChapterLoader', () => {
  it('loadChapterContent / refreshChapter / clearChapterContents / updateChapter 应原样透传', async () => {
    const loader = {
      getChapters: vi.fn(async () => []),
      getChaptersSync: vi.fn(() => undefined),
      loadChapterContent: vi.fn(async () => undefined),
      refreshChapter: vi.fn(async () => true),
      clearChapterContents: vi.fn(async () => undefined),
      updateChapter: vi.fn(async () => undefined),
      evictCache: vi.fn(),
    };
    const { svc } = makeSvc({ loader: loader as never });

    await svc.loadChapterContent('book-1', 2);
    expect(loader.loadChapterContent).toHaveBeenCalledWith('book-1', 2);

    await expect(svc.refreshChapter('book-1', 3)).resolves.toBe(true);
    expect(loader.refreshChapter).toHaveBeenCalledWith('book-1', 3);

    await svc.clearChapterContents('book-1');
    expect(loader.clearChapterContents).toHaveBeenCalledWith('book-1');

    await svc.updateChapter('book-1', 1, { title: '改名' });
    expect(loader.updateChapter).toHaveBeenCalledWith('book-1', 1, { title: '改名' });
  });
});

describe('BookService.deleteBook 镜像同步', () => {
  it('deleteBook 应清掉 books 镜像与章节缓存镜像', async () => {
    const { svc, fakeDb } = makeSvc();
    await svc.addBook(makeBook(), [makeChapter('book-1', 0)]);
    expect(svc.count()).toBe(1);
    await svc.deleteBook('book-1');
    expect(fakeDb.bookDelete).toHaveBeenCalledWith('book-1');
    expect(svc.count()).toBe(0);
    expect(svc.getById('book-1')).toBeUndefined();
    // _chaptersCache 镜像同步清除：refreshChapters 再走会回退 db.chapterAll
    const resolved: ResolvedBook = {
      title: 'x',
      author: 'x',
      chapters: [{ title: 'c1', url: 'http://old/1' }],
    };
    (svc as any).importViaSource = makeFakeImportViaSource(resolved, 'stub-uuid');
    (svc as any)._books.set([makeBook()]);
    await svc.refreshChapters('book-1');
    expect(fakeDb.chapterAll).toHaveBeenCalledWith('book-1');
  });
});
