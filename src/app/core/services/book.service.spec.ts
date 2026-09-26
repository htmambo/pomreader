/**
 * BookService.changeBookSource 换源逻辑测试
 *
 * 覆盖：
 * - 仅 'online' 来源支持换源；其它 source 抛 FetchError('unsupported-source')
 * - user-bound 字段保留：bookId / importedAt / lastReadAt / progress.scrollOffset
 * - source-bound 字段替换：title / author / sourceUrl / bookSourceUuid / chapterCount
 * - progress.chapterIndex clamp 到 [0, newCount-1]
 * - 调用 importViaSource.importByUrl 传参正确（url + sourceName）
 * - PouchDB 层不直接测（chapterPutMany 升级的孤儿清理见 PouchDB 集成测试或 e2e）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BookService } from './book.service';
import { BookSourceRegistry } from '../book-source/book-source.registry';
import {
  BookSourceAdapter,
  PageFetcher,
  ResolvedBook,
} from '../book-source/book-source.adapter';
import { ImportViaSourceService } from '../book-source/import-via-source.service';
import { FetchError } from '../book-source/fetch-error';
import { UNIVERSAL_BOOK_SOURCE_UUID } from '../book-source/book-source.constants';
import { Book } from '../models/book.model';

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
  match(): boolean { return true; }
  async fetchCatalog(): Promise<ResolvedBook> {
    return { title: 'stub', author: 'stub', chapters: [{ title: 'ch1', url: 'http://a/1' }] };
  }
  async fetchChapter(): Promise<string> { return ''; }
}

interface AddBookCall { book: Book; chapters: Array<{ bookId: string; index: number; title: string; sourceUrl?: string; content: string; loaded: boolean }> }

/** 假 DbService：仅实现 addBook / refreshChapters 链路需要的最小接口 */
function makeFakeDb(initialChapters: Array<{ bookId: string; index: number; title: string; content?: string; sourceUrl?: string; loaded?: boolean }> = []) {
  let chapters = [...initialChapters];
  const fakeDb = {
    bookPut: vi.fn(async () => undefined),
    chapterPutMany: vi.fn(async (chs: typeof chapters) => {
      // 模拟 PouchDB upsert（chapterPutMany 同 _id 覆盖）
      for (const nc of chs) {
        const idx = chapters.findIndex((c) => c.index === nc.index && c.bookId === nc.bookId);
        if (idx >= 0) chapters[idx] = nc;
        else chapters.push(nc);
      }
    }),
    chapterAll: vi.fn(async () => [...chapters].sort((a, b) => a.index - b.index)),
  };
  return { fakeDb };
}

/** 拦截 BookService.addBook，记录参数；保留原实现让 _books/_chaptersCache 更新到位 */
function spyAddBook(svc: BookService, sink: AddBookCall[]): void {
  const original = (svc as unknown as { addBook: (b: Book, c: AddBookCall['chapters']) => Promise<void> }).addBook.bind(svc);
  (svc as unknown as { addBook: typeof original }).addBook = vi.fn(async (b, c) => {
    sink.push({ book: b, chapters: c });
    await original(b, c);
  });
}

/** 假 ImportViaSourceService：直接 resolve 到给定的 ResolvedBook */
function makeFakeImportViaSource(resolved: ResolvedBook, uuid: string): ImportViaSourceService {
  const svc = Object.create(ImportViaSourceService.prototype);
  svc.importByUrl = vi.fn(async () => ({ book: resolved, bookSourceUuid: uuid }));
  svc.supportedSources = vi.fn(() => ['stub']);
  return svc as ImportViaSourceService;
}

function makeBook(overrides: Partial<Book> = {}): Book {
  return {
    id: 'book-1',
    title: '连城诀',
    author: '金庸',
    chapterCount: 5,
    totalChars: 10000,
    importedAt: '2026-01-01T00:00:00.000Z',
    lastReadAt: '2026-02-01T12:00:00.000Z',
    source: 'online',
    sourceUrl: 'https://old.example.com/book/1',
    bookSourceUuid: 'old-uuid',
    ...overrides,
  };
}

function makeResolved(overrides: Partial<ResolvedBook> = {}): ResolvedBook {
  return {
    title: '连城诀（新源）',
    author: '金庸',
    kind: '武侠',
    chapters: [
      { title: '新第1章', url: 'http://new/1' },
      { title: '新第2章', url: 'http://new/2' },
      { title: '新第3章', url: 'http://new/3' },
    ],
    ...overrides,
  };
}

describe('BookService.changeBookSource', () => {
  let svc: BookService;
  let calls: AddBookCall[];
  let importViaSource: ImportViaSourceService;

  beforeEach(() => {
    const { fakeDb } = makeFakeDb();
    calls = [];
    const registry = BookSourceRegistry.forTest(emptyFetcher());
    registry.register(new StubAdapter('stub'));
    importViaSource = makeFakeImportViaSource(makeResolved(), 'new-uuid');
    svc = BookService.forTest(fakeDb as never, registry, importViaSource);
    spyAddBook(svc, calls);
  });

  it('throws when book does not exist', async () => {
    await expect(svc.changeBookSource('missing', 'http://new', 'stub')).rejects.toThrow(FetchError);
  });

  it('throws FetchError(unsupported-source) when source is local-txt', async () => {
    // 设置 in-memory _books 包含一本 local-txt 书
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (svc as any)._books.set([makeBook({ source: 'local-txt' })]);
    await expect(svc.changeBookSource('book-1', 'http://new', 'stub')).rejects.toMatchObject({
      code: 'unsupported-source',
    });
  });

  it('throws FetchError(unsupported-source) when source is auto-import', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (svc as any)._books.set([makeBook({ source: 'auto-import' })]);
    await expect(svc.changeBookSource('book-1', 'http://new', 'stub')).rejects.toMatchObject({
      code: 'unsupported-source',
    });
  });

  it('throws FetchError(parse-failed) when new catalog has 0 chapters', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (svc as any)._books.set([makeBook()]);
    const emptyResolved = makeResolved({ chapters: [] });
    const emptyVia = makeFakeImportViaSource(emptyResolved, 'new-uuid');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (svc as any).importViaSource = emptyVia;
    await expect(svc.changeBookSource('book-1', 'http://new', 'stub')).rejects.toMatchObject({
      code: 'parse-failed',
    });
  });

  it('replaces source-bound fields and preserves user-bound fields', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (svc as any)._books.set([makeBook()]);
    await svc.changeBookSource('book-1', 'http://new.example.com/book/1', 'stub');

    expect(calls).toHaveLength(1);
    const merged = calls[0].book;
    // source-bound 字段替换
    expect(merged.title).toBe('连城诀（新源）');
    expect(merged.author).toBe('金庸');
    expect(merged.kind).toBe('武侠');
    expect(merged.sourceUrl).toBe('http://new.example.com/book/1');
    expect(merged.bookSourceUuid).toBe('new-uuid');
    expect(merged.chapterCount).toBe(3);
    expect(merged.totalChars).toBe(3 * 2000); // 估算
    expect(merged.source).toBe('online'); // 不变
    // user-bound 字段保留
    expect(merged.id).toBe('book-1');
    expect(merged.importedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(merged.lastReadAt).toBe('2026-02-01T12:00:00.000Z');
  });

  it('preserves kind and coverImageUrl as fallback when new source lacks them', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (svc as any)._books.set([makeBook({ kind: '旧题材', coverImageUrl: 'data:old' })]);
    const resolvedNoExtras = makeResolved({ kind: undefined });
    delete (resolvedNoExtras as { kind?: string }).kind;
    const via = makeFakeImportViaSource(resolvedNoExtras, 'new-uuid');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (svc as any).importViaSource = via;

    await svc.changeBookSource('book-1', 'http://new', 'stub');
    const merged = calls[0].book;
    expect(merged.kind).toBe('旧题材');
    expect(merged.coverImageUrl).toBe('data:old');
  });

  it('clamps progress.chapterIndex to [0, newCount-1] when new source has fewer chapters', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (svc as any)._books.set([
      makeBook({
        progress: { chapterIndex: 4, scrollOffset: 100, updatedAt: '2026-02-15T10:00:00Z' },
      }),
    ]);
    // 旧 5 章 / 新 3 章 → chapterIndex 应 clamp 到 2 (newCount-1)
    await svc.changeBookSource('book-1', 'http://new', 'stub');
    const merged = calls[0].book;
    expect(merged.progress?.chapterIndex).toBe(2);
    expect(merged.progress?.scrollOffset).toBe(100); // scrollOffset 保留
    expect(merged.progress?.updatedAt).toBe('2026-02-15T10:00:00Z'); // updatedAt 保留
  });

  it('keeps progress.chapterIndex unchanged when within new range', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (svc as any)._books.set([
      makeBook({ progress: { chapterIndex: 1, updatedAt: '2026-02-15T10:00:00Z' } }),
    ]);
    // 旧 5 章 / 新 3 章 → chapterIndex 1 在新范围 [0, 2] 内 → 保留
    await svc.changeBookSource('book-1', 'http://new', 'stub');
    expect(calls[0].book.progress?.chapterIndex).toBe(1);
  });

  it('handles missing progress (legacy books without progress)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (svc as any)._books.set([makeBook({ progress: undefined })]);
    await svc.changeBookSource('book-1', 'http://new', 'stub');
    expect(calls[0].book.progress).toBeUndefined();
  });

  it('writes new chapters with content="" and loaded=false (lazy re-fetch)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (svc as any)._books.set([makeBook()]);
    await svc.changeBookSource('book-1', 'http://new', 'stub');
    const newChapters = calls[0].chapters;
    expect(newChapters).toHaveLength(3);
    expect(newChapters[0]).toMatchObject({
      bookId: 'book-1',
      index: 0,
      title: '新第1章',
      sourceUrl: 'http://new/1',
      content: '',
      loaded: false,
    });
  });

  it('passes newUrl and sourceName to importViaSource.importByUrl', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (svc as any)._books.set([makeBook()]);
    await svc.changeBookSource('book-1', 'http://new.example.com/book/1', 'stub');
    expect(importViaSource.importByUrl).toHaveBeenCalledWith('http://new.example.com/book/1', 'stub');
  });

  it('passes undefined sourceName to importViaSource when not specified', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (svc as any)._books.set([makeBook()]);
    await svc.changeBookSource('book-1', 'http://new.example.com/book/1');
    expect(importViaSource.importByUrl).toHaveBeenCalledWith('http://new.example.com/book/1', undefined);
  });

  it('falls back to old title/author when new resolved values are empty', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (svc as any)._books.set([makeBook()]);
    const emptyResolved: ResolvedBook = {
      title: '',
      author: '',
      chapters: [{ title: 'ch1', url: 'http://new/1' }],
    };
    const via = makeFakeImportViaSource(emptyResolved, 'new-uuid');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (svc as any).importViaSource = via;
    await svc.changeBookSource('book-1', 'http://new', 'stub');
    const merged = calls[0].book;
    expect(merged.title).toBe('连城诀'); // fallback
    expect(merged.author).toBe('金庸'); // fallback
  });

  it('forwards UNIVERSAL_BOOK_SOURCE_UUID when importByUrl returns universal uuid', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (svc as any)._books.set([makeBook()]);
    const via = makeFakeImportViaSource(makeResolved(), UNIVERSAL_BOOK_SOURCE_UUID);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (svc as any).importViaSource = via;
    await svc.changeBookSource('book-1', 'http://new');
    expect(calls[0].book.bookSourceUuid).toBe(UNIVERSAL_BOOK_SOURCE_UUID);
  });
});

/** refreshChapters 测试用：mock 一本含 3 章的 online 书，缓存为空时 chapterAll 兜底 */
function makeBookWithChapters() {
  const existing = [
    { bookId: 'book-1', index: 0, title: '旧第1章', sourceUrl: 'http://old/1', content: 'old1', loaded: true },
    { bookId: 'book-1', index: 1, title: '旧第2章', sourceUrl: 'http://old/2', content: 'old2', loaded: true },
    { bookId: 'book-1', index: 2, title: '旧第3章', sourceUrl: 'http://old/3', content: 'old3', loaded: true },
  ];
  return { existing };
}

describe('BookService.refreshChapters', () => {
  let svc: BookService;
  let calls: AddBookCall[];
  let importViaSource: ImportViaSourceService;
  let fakeDb: ReturnType<typeof makeFakeDb>['fakeDb'];

  beforeEach(() => {
    const { existing } = makeBookWithChapters();
    const result = makeFakeDb(existing);
    fakeDb = result.fakeDb;
    calls = [];
    const registry = BookSourceRegistry.forTest(emptyFetcher());
    // 注册带 meta.uuid 的 adapter：registry.getByUuid('stub-uuid') 才能命中
    registry.register(new StubAdapter('stub', { uuid: 'stub-uuid' }));
    // 默认 resolved：旧 3 章 + 2 个新章 + 1 个与旧 URL 重复的章（测去重）
    const resolved: ResolvedBook = {
      title: '连城诀',
      author: '金庸',
      chapters: [
        { title: '旧第1章', url: 'http://old/1' },     // 跳过（已存在 URL）
        { title: '旧第2章', url: 'http://old/2' },     // 跳过
        { title: '旧第3章', url: 'http://old/3' },     // 跳过
        { title: '新第4章', url: 'http://old/4' },     // 追加
        { title: '新第5章', url: 'http://old/5' },     // 追加
      ],
    };
    importViaSource = makeFakeImportViaSource(resolved, 'stub-uuid');
    svc = BookService.forTest(fakeDb as never, registry, importViaSource);
    spyAddBook(svc, calls);
  });

  it('throws when book does not exist', async () => {
    await expect(svc.refreshChapters('missing')).rejects.toThrow(FetchError);
  });

  it('throws FetchError(unsupported-source) when source is not online', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (svc as any)._books.set([makeBook({ source: 'local-txt' })]);
    await expect(svc.refreshChapters('book-1')).rejects.toMatchObject({
      code: 'unsupported-source',
    });
  });

  it('throws FetchError(parse-failed) when book has no sourceUrl', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (svc as any)._books.set([makeBook({ sourceUrl: undefined })]);
    await expect(svc.refreshChapters('book-1')).rejects.toMatchObject({
      code: 'parse-failed',
    });
  });

  it('throws FetchError(parse-failed) when new catalog has 0 chapters', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (svc as any)._books.set([makeBook()]);
    const emptyVia = makeFakeImportViaSource(
      { title: 'x', author: 'x', chapters: [] },
      'stub-uuid',
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (svc as any).importViaSource = emptyVia;
    await expect(svc.refreshChapters('book-1')).rejects.toMatchObject({
      code: 'parse-failed',
    });
  });

  it('returns {added:0, skipped, total} when all chapters are duplicates (no addBook call)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (svc as any)._books.set([makeBook()]);
    // 全部重复：只有旧 3 章
    const via = makeFakeImportViaSource(
      {
        title: 'x',
        author: 'x',
        chapters: [
          { title: '旧第1章', url: 'http://old/1' },
          { title: '旧第2章', url: 'http://old/2' },
          { title: '旧第3章', url: 'http://old/3' },
        ],
      },
      'stub-uuid',
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (svc as any).importViaSource = via;

    const result = await svc.refreshChapters('book-1');
    expect(result).toEqual({ added: 0, skipped: 3, total: 3 });
    // 无变化时不触发 addBook（避免无意义写）
    expect(calls).toHaveLength(0);
  });

  it('appends only new chapters (URL dedup), preserves existing chapter indices', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (svc as any)._books.set([makeBook()]);
    const result = await svc.refreshChapters('book-1');

    expect(result.added).toBe(2);
    expect(result.skipped).toBe(3);
    expect(result.total).toBe(5);

    // addBook 被调用一次；chapters 列表 = 旧 3 章 + 新 2 章（顺序按 index）
    expect(calls).toHaveLength(1);
    const chapters = calls[0].chapters;
    expect(chapters).toHaveLength(5);
    expect(chapters.map((c) => c.index)).toEqual([0, 1, 2, 3, 4]);
    // 新章追加在末尾
    expect(chapters[3]).toMatchObject({
      bookId: 'book-1',
      index: 3,
      title: '新第4章',
      sourceUrl: 'http://old/4',
      content: '',
      loaded: false,
    });
    expect(chapters[4]).toMatchObject({
      bookId: 'book-1',
      index: 4,
      title: '新第5章',
      sourceUrl: 'http://old/5',
      content: '',
      loaded: false,
    });
  });

  it('updates Book.chapterCount and totalChars without touching other fields', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (svc as any)._books.set([makeBook()]);
    await svc.refreshChapters('book-1');
    const merged = calls[0].book;
    expect(merged.chapterCount).toBe(5);
    expect(merged.totalChars).toBe(5 * 2000); // 估算
    // user-bound 字段不动
    expect(merged.id).toBe('book-1');
    expect(merged.title).toBe('连城诀');
    expect(merged.author).toBe('金庸');
    expect(merged.importedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(merged.lastReadAt).toBe('2026-02-01T12:00:00.000Z');
    expect(merged.sourceUrl).toBe('https://old.example.com/book/1');
    expect(merged.bookSourceUuid).toBe('old-uuid'); // 同源，不变
  });

  it('preserves progress.chapterIndex unchanged (no clamp needed)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (svc as any)._books.set([
      makeBook({ progress: { chapterIndex: 2, scrollOffset: 500, updatedAt: '2026-02-15T10:00:00Z' } }),
    ]);
    await svc.refreshChapters('book-1');
    const merged = calls[0].book;
    expect(merged.progress?.chapterIndex).toBe(2); // 旧章 index 不变 → 已读位置不动
    expect(merged.progress?.scrollOffset).toBe(500);
    expect(merged.progress?.updatedAt).toBe('2026-02-15T10:00:00Z');
  });

  it('passes source.name (looked up from bookSourceUuid) to importByUrl', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (svc as any)._books.set([makeBook({ bookSourceUuid: 'stub-uuid' })]);
    await svc.refreshChapters('book-1');
    expect(importViaSource.importByUrl).toHaveBeenCalledWith(
      'https://old.example.com/book/1',
      'stub',
    );
  });

  it('passes undefined sourceName when bookSourceUuid is UNIVERSAL_BOOK_SOURCE_UUID', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (svc as any)._books.set([makeBook({ bookSourceUuid: UNIVERSAL_BOOK_SOURCE_UUID })]);
    await svc.refreshChapters('book-1');
    expect(importViaSource.importByUrl).toHaveBeenCalledWith(
      'https://old.example.com/book/1',
      undefined,
    );
  });

  it('passes undefined sourceName when bookSourceUuid is missing', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (svc as any)._books.set([makeBook({ bookSourceUuid: undefined })]);
    await svc.refreshChapters('book-1');
    expect(importViaSource.importByUrl).toHaveBeenCalledWith(
      'https://old.example.com/book/1',
      undefined,
    );
  });

  it('fetches chapters from PouchDB when in-memory cache is empty (chapterAll fallback)', async () => {
    // _chaptersCache 空白（beforeEach 未预填）→ refreshChapters 应走 db.chapterAll
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (svc as any)._books.set([makeBook()]);
    expect(fakeDb.chapterAll).not.toHaveBeenCalled();
    await svc.refreshChapters('book-1');
    expect(fakeDb.chapterAll).toHaveBeenCalledWith('book-1');
  });

  it('treats missing sourceUrl on existing chapter as not-duplicate (still dedupes by URL presence)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (svc as any)._books.set([makeBook()]);
    // 把所有旧章 sourceUrl 清空 → existingUrls 是空集 → 全部视为新章（追加）
    const clearedFakeDb = makeFakeDb([
      { bookId: 'book-1', index: 0, title: 'ch1' },
      { bookId: 'book-1', index: 1, title: 'ch2' },
    ]).fakeDb;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (svc as any).db = clearedFakeDb;

    const result = await svc.refreshChapters('book-1');
    // existingUrls 是空集 → 旧 3 章视为新 → 全部追加
    expect(result.added).toBe(5);
    expect(result.skipped).toBe(0);
  });
});