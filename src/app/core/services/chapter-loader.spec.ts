import { describe, it, expect, beforeEach } from 'vitest';
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

  describe('clearChapterContents', () => {
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
    it('应能合并 patch 并更新缓存 + version', async () => {
      const ch = makeChapter({ title: 'old' });
      loader.db = { ...db, chapterGet: async () => ch };
      await loader.updateChapter('book-1', 0, { title: 'new' });
      const cached = loader.getChaptersSync('book-1');
      expect(cached?.[0].title).toBe('new');
      expect(loader.chaptersVersion()).toBe(1);
    });

    it('缺章节时静默返回', async () => {
      loader.db = { ...db, chapterGet: async () => null };
      await loader.updateChapter('book-empty', 0, { title: 'x' });
      expect(loader.chaptersVersion()).toBe(0);
    });
  });
});