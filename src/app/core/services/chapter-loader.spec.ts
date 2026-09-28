import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ChapterLoader } from './chapter-loader';
import { Chapter } from '../models/chapter.model';
import { BookSourceRegistry } from '../book-source/book-source.registry';

function makeChapter(overrides: Partial<Chapter> = {}): Chapter {
  return {
    bookId: 'book-1',
    index: 0,
    title: 'Chapter 1',
    content: '',
    sourceUrl: 'https://example.com/c1',
    loaded: false,
    ...overrides,
  };
}

function makeDb(chapters: Record<string, Chapter[]> = {}) {
  return {
    chapterAll: async (bookId: string) => chapters[bookId] ?? [],
    chapterGet: async (bookId: string, idx: number) =>
      (chapters[bookId] ?? []).find((c) => c.index === idx) ?? null,
    chapterPut: async () => undefined,
    chapterPutMany: async () => undefined,
  };
}

// BookSourceRegistry.forTest 期望 PageFetcher，但 ChapterLoader 大部分方法不依赖 sources
// 创建一个 minimal stub（不会真的被调用除非 loadChapterContent/refreshChapter）
const stubFetcher = { fetch: async () => 'unused' } as never;

describe('ChapterLoader', () => {
  let loader: ChapterLoader;
  let db: ReturnType<typeof makeDb>;
  let sources: BookSourceRegistry;

  beforeEach(() => {
    db = makeDb();
    sources = BookSourceRegistry.forTest(stubFetcher);
    loader = ChapterLoader.forTest(db as never, sources);
  });

  describe('getChapters + getChaptersSync', () => {
    it('应能从 db 拉取并填充', async () => {
      const chs = [makeChapter({ index: 0 }), makeChapter({ index: 1 })];
      loader.db = { ...db, chapterAll: async () => chs };
      const result = await loader.getChapters('book-1');
      expect(result).toEqual(chs);
      expect(loader.getChaptersSync('book-1')).toEqual(chs);
    });

    it('缓存 hit 时直接返回（不调 db）', async () => {
      const chs = [makeChapter({ index: 0 })];
      loader.db = { ...db, chapterAll: async () => chs };
      await loader.getChapters('book-1');
      // 第二次：chapterAll 抛错（如果被调用会失败）
      loader.db = {
        ...db,
        chapterAll: async () => {
          throw new Error('should not be called');
        },
      };
      const result = await loader.getChapters('book-1');
      expect(result).toEqual(chs);
    });

    it('空列表不写入缓存', async () => {
      loader.db = { ...db, chapterAll: async () => [] };
      const result = await loader.getChapters('book-empty');
      expect(result).toEqual([]);
      expect(loader.getChaptersSync('book-empty')).toBeUndefined();
    });
  });

  describe('evictCache', () => {
    it('应能从缓存中移除 book', async () => {
      const chs = [makeChapter({ index: 0 })];
      loader.db = { ...db, chapterAll: async () => chs };
      await loader.getChapters('book-1');
      expect(loader.getChaptersSync('book-1')).toBeDefined();
      loader.evictCache('book-1');
      expect(loader.getChaptersSync('book-1')).toBeUndefined();
    });
  });

  describe('loadChapterContent', () => {
    it('缓存命中且章节已 loaded 时直接返回（不抓取）', async () => {
      const chs = [makeChapter({ index: 0, loaded: true, content: '已缓存' })];
      const sources = { fetchChapter: vi.fn(async () => '不应被调用') };
      loader = ChapterLoader.forTest(
        { ...db, chapterAll: async () => chs } as never,
        sources as never,
      );
      await loader.getChapters('book-1');
      await loader.loadChapterContent('book-1', 0);
      expect(sources.fetchChapter).not.toHaveBeenCalled();
      expect(loader.chaptersVersion()).toBe(0);
    });

    it('无 sourceUrl 的章节直接返回（不抓取）', async () => {
      const sources = { fetchChapter: vi.fn(async () => 'x') };
      loader = ChapterLoader.forTest(
        { ...db, chapterGet: async () => makeChapter({ sourceUrl: '' }) } as never,
        sources as never,
      );
      await loader.loadChapterContent('book-1', 0);
      expect(sources.fetchChapter).not.toHaveBeenCalled();
    });

    it('缓存与 db 都无该章节时静默返回', async () => {
      const sources = { fetchChapter: vi.fn(async () => 'x') };
      loader = ChapterLoader.forTest(
        { ...db, chapterGet: async () => null } as never,
        sources as never,
      );
      await loader.loadChapterContent('book-x', 5);
      expect(sources.fetchChapter).not.toHaveBeenCalled();
      expect(loader.chaptersVersion()).toBe(0);
    });

    it('缓存 miss → 从 db 取章节并抓取成功 → 写 db + bump version', async () => {
      const ch = makeChapter({ index: 0 });
      const putSpy = vi.fn(async () => undefined);
      const sources = { fetchChapter: vi.fn(async () => '正文内容') };
      loader = ChapterLoader.forTest(
        { ...db, chapterGet: async () => ch, chapterPut: putSpy } as never,
        sources as never,
      );
      await loader.loadChapterContent('book-1', 0);
      expect(sources.fetchChapter).toHaveBeenCalledWith({
        title: 'Chapter 1',
        url: 'https://example.com/c1',
      });
      expect(putSpy).toHaveBeenCalledWith(
        expect.objectContaining({ content: '正文内容', loaded: true }),
      );
      // 缓存列表缺失（!list）分支：写 db 但不写内存缓存
      expect(loader.getChaptersSync('book-1')).toBeUndefined();
      expect(loader.chaptersVersion()).toBe(1);
    });

    it('缓存列表存在时就地更新目标章节、保留其它章节', async () => {
      const chs = [makeChapter({ index: 0 }), makeChapter({ index: 1, title: 'Chapter 2' })];
      const sources = { fetchChapter: vi.fn(async () => '抓取内容') };
      loader = ChapterLoader.forTest(
        { ...db, chapterAll: async () => chs } as never,
        sources as never,
      );
      await loader.getChapters('book-1');
      await loader.loadChapterContent('book-1', 0);
      const cached = loader.getChaptersSync('book-1');
      expect(cached?.[0]).toMatchObject({ content: '抓取内容', loaded: true });
      expect(cached?.[1]).toMatchObject({ title: 'Chapter 2', loaded: false });
    });

    it('抓取失败时静默吞错：不写 db、不 bump version', async () => {
      const putSpy = vi.fn(async () => undefined);
      const sources = {
        fetchChapter: vi.fn(async () => {
          throw new Error('network down');
        }),
      };
      loader = ChapterLoader.forTest(
        { ...db, chapterGet: async () => makeChapter(), chapterPut: putSpy } as never,
        sources as never,
      );
      await loader.loadChapterContent('book-1', 0);
      expect(putSpy).not.toHaveBeenCalled();
      expect(loader.chaptersVersion()).toBe(0);
    });
  });

  describe('refreshChapter', () => {
    it('缓存与 db 都无该章节时返回 false', async () => {
      loader = ChapterLoader.forTest(
        { ...db, chapterGet: async () => null } as never,
        sources as never,
      );
      expect(await loader.refreshChapter('book-x', 3)).toBe(false);
    });

    it('章节无 sourceUrl 时返回 false', async () => {
      loader = ChapterLoader.forTest(
        { ...db, chapterGet: async () => makeChapter({ sourceUrl: '' }) } as never,
        sources as never,
      );
      expect(await loader.refreshChapter('book-1', 0)).toBe(false);
    });

    it('忽略 loaded 标记强制重抓：成功返回 true + 更新缓存 + bump version', async () => {
      const chs = [makeChapter({ index: 0, loaded: true, content: '旧内容' })];
      const stubSources = { fetchChapter: vi.fn(async () => '新内容') };
      loader = ChapterLoader.forTest(
        { ...db, chapterAll: async () => chs } as never,
        stubSources as never,
      );
      await loader.getChapters('book-1');
      const ok = await loader.refreshChapter('book-1', 0);
      expect(ok).toBe(true);
      expect(stubSources.fetchChapter).toHaveBeenCalledTimes(1);
      expect(loader.getChaptersSync('book-1')?.[0].content).toBe('新内容');
      expect(loader.chaptersVersion()).toBe(1);
    });

    it('抓取失败返回 false 且不 bump version', async () => {
      const stubSources = {
        fetchChapter: vi.fn(async () => {
          throw new Error('cf blocked');
        }),
      };
      loader = ChapterLoader.forTest(
        { ...db, chapterGet: async () => makeChapter() } as never,
        stubSources as never,
      );
      expect(await loader.refreshChapter('book-1', 0)).toBe(false);
      expect(loader.chaptersVersion()).toBe(0);
    });

    it('缓存列表缺失时仍返回 true（只写 db + bump version）', async () => {
      const stubSources = { fetchChapter: vi.fn(async () => 'x') };
      loader = ChapterLoader.forTest(
        { ...db, chapterGet: async () => makeChapter() } as never,
        stubSources as never,
      );
      expect(await loader.refreshChapter('book-1', 0)).toBe(true);
      expect(loader.getChaptersSync('book-1')).toBeUndefined();
      expect(loader.chaptersVersion()).toBe(1);
    });
  });

  describe('clearChapterContents', () => {
    it('缓存已填充时直接使用缓存（不再查 db）', async () => {
      const chs = [makeChapter({ index: 0, content: 'x', loaded: true })];
      loader.db = {
        ...db,
        chapterAll: async () => chs,
        chapterPutMany: async () => undefined,
      };
      await loader.getChapters('book-1');
      // 换成会抛错的 chapterAll：若 clearChapterContents 再查 db 则测试失败
      loader.db = {
        ...db,
        chapterAll: async () => {
          throw new Error('should not be called');
        },
        chapterPutMany: async () => undefined,
      };
      await loader.clearChapterContents('book-1');
      expect(loader.getChaptersSync('book-1')?.[0].loaded).toBe(false);
      expect(loader.chaptersVersion()).toBe(1);
    });

    it('应能清空缓存标记 loaded=false', async () => {
      const chs = [
        makeChapter({ index: 0, content: 'x', loaded: true }),
        makeChapter({ index: 1, content: 'y', loaded: true }),
      ];
      loader.db = {
        ...db,
        chapterAll: async () => chs,
        chapterPutMany: async () => undefined,
      };
      await loader.clearChapterContents('book-1');
      const cached = loader.getChaptersSync('book-1');
      expect(cached?.[0].content).toBe('');
      expect(cached?.[0].loaded).toBe(false);
      expect(cached?.[1].content).toBe('');
      expect(loader.chaptersVersion()).toBe(1);
    });

    it('无章节时直接返回', async () => {
      loader.db = { ...db, chapterAll: async () => [] };
      await loader.clearChapterContents('book-empty');
      expect(loader.chaptersVersion()).toBe(0);
    });
  });

  describe('updateChapter', () => {
    it('缓存未加载时只写 db、不写入单章部分缓存（防止被当成完整目录）', async () => {
      const ch = makeChapter({ title: 'old' });
      loader.db = {
        ...db,
        chapterGet: async () => ch,
        chapterAll: async () => [{ ...ch, title: 'new' }],
      };
      await loader.updateChapter('book-1', 0, { title: 'new' });
      // 缓存保持缺席（不污染），version 照常 bump 通知 reader 刷新
      expect(loader.getChaptersSync('book-1')).toBeUndefined();
      expect(loader.chaptersVersion()).toBe(1);
      // 下次读取从 db 懒加载全量列表（含更新）
      const list = await loader.getChapters('book-1');
      expect(list[0].title).toBe('new');
    });

    it('缺章节时静默返回', async () => {
      loader.db = { ...db, chapterGet: async () => null };
      await loader.updateChapter('book-empty', 0, { title: 'x' });
      expect(loader.chaptersVersion()).toBe(0);
    });

    it('缓存列表存在时应 map 更新匹配章节、保留其它章节', async () => {
      const chs = [makeChapter({ index: 0, title: 'A' }), makeChapter({ index: 1, title: 'B' })];
      loader.db = { ...db, chapterAll: async () => chs };
      await loader.getChapters('book-1');
      await loader.updateChapter('book-1', 1, { title: 'B2' });
      const cached = loader.getChaptersSync('book-1');
      expect(cached?.[0].title).toBe('A');
      expect(cached?.[1].title).toBe('B2');
      expect(loader.chaptersVersion()).toBe(1);
    });
  });
});
