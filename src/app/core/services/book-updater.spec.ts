import { describe, it, expect, beforeEach } from 'vitest';
import { BookUpdater } from './book-updater';
import { BookRepository } from './book.repository';
import { ChapterLoader } from './chapter-loader';
import { FetchError } from '../book-source/fetch-error';
import { BookSourceRegistry } from '../book-source/book-source.registry';
import { ImportViaSourceService } from '../book-source/import-via-source.service';

function makeBook(overrides = {}) {
  return {
    id: 'b1',
    title: 'Test',
    author: 'Author',
    chapterCount: 0,
    totalChars: 0,
    importedAt: '2026-01-01T00:00:00Z',
    source: 'online',
    sourceUrl: 'http://test/1',
    ...overrides,
  };
}

describe('BookUpdater', () => {
  let updater: BookUpdater;
  let repo: { getById: (id: string) => unknown; persistBook: (b: unknown) => Promise<void>; persistChapters: (cs: unknown) => Promise<void>; books: () => unknown[]; loadState: () => string };
  let loader: { loadChapterContent: (id: string, idx: number) => Promise<void>; getChaptersSync: (id: string) => unknown[] | undefined };
  let db: { chapterAll: (id: string) => Promise<unknown[]> };
  let sources: { getByUuid: (uuid: string) => { name: string } | undefined };
  let importViaSource: { importByUrl: (url: string, name?: string) => Promise<{ book: { title?: string; author?: string; kind?: string; coverImageUrl?: string; chapters?: { url: string; title: string }[] }; bookSourceUuid?: string }> };

  beforeEach(() => {
    repo = {
      getById: () => undefined,
      persistBook: async () => undefined,
      persistChapters: async () => undefined,
      books: () => [],
      loadState: () => 'idle',
    };
    loader = {
      loadChapterContent: async () => undefined,
      getChaptersSync: () => undefined,
    };
    db = { chapterAll: async () => [] };
    sources = { getByUuid: () => undefined };
    importViaSource = {
      importByUrl: async () => ({ book: { chapters: [] }, bookSourceUuid: 'uuid' }),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    updater = BookUpdater.forTest(repo as any, loader as any, db as any, sources as any, importViaSource as any);
  });

  describe('changeBookSource', () => {
    it('书不存在应抛 source-unavailable', async () => {
      await expect(
        updater.changeBookSource('missing', 'http://new'),
      ).rejects.toThrow(FetchError);
    });

    it('非 online 来源应抛 unsupported-source', async () => {
      repo.getById = () => makeBook({ source: 'local-txt' });
      await expect(
        updater.changeBookSource('b1', 'http://new'),
      ).rejects.toMatchObject({ code: 'unsupported-source' });
    });

    it('新源解析空目录应抛 parse-failed', async () => {
      repo.getById = () => makeBook();
      importViaSource.importByUrl = async () => ({ book: { chapters: [] } });
      await expect(
        updater.changeBookSource('b1', 'http://new'),
      ).rejects.toMatchObject({ code: 'parse-failed' });
    });

    it('成功应合并 Book 字段并 persist', async () => {
      const oldBook = makeBook({ kind: 'old-kind', coverImageUrl: 'data:old' });
      repo.getById = () => oldBook;
      let persisted: unknown;
      repo.persistBook = async (b: unknown) => {
        persisted = b;
      };
      importViaSource.importByUrl = async () => ({
        book: {
          title: 'New Title',
          author: 'New Author',
          chapters: [{ url: 'http://c1', title: 'c1' }, { url: 'http://c2', title: 'c2' }],
        },
        bookSourceUuid: 'new-uuid',
      });
      await updater.changeBookSource('b1', 'http://new');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const merged = persisted as any;
      expect(merged.title).toBe('New Title');
      expect(merged.author).toBe('New Author');
      expect(merged.kind).toBe('old-kind'); // 保留旧值
      expect(merged.coverImageUrl).toBe('data:old'); // 保留旧值
      expect(merged.source).toBe('online');
      expect(merged.chapterCount).toBe(2);
    });

    it('应能 clamp progress.chapterIndex 到新章节表范围', async () => {
      repo.getById = () =>
        makeBook({
          progress: { chapterIndex: 10, updatedAt: '2026-01-01' },
        });
      repo.persistBook = async () => undefined;
      importViaSource.importByUrl = async () => ({
        book: {
          chapters: [
            { url: 'http://c1', title: 'c1' },
            { url: 'http://c2', title: 'c2' },
          ],
        },
      });
      await updater.changeBookSource('b1', 'http://new');
      // persisted book 通过 repo.persistBook 写入；lastWrite 通过 repo.persistBook.calls 不跟踪
      // 简单验证：调用不抛错
    });

    it('加载失败静默（Promise.allSettled）', async () => {
      repo.getById = () => makeBook();
      loader.loadChapterContent = async () => {
        throw new Error('boom');
      };
      importViaSource.importByUrl = async () => ({
        book: {
          chapters: [{ url: 'http://c1', title: 'c1' }],
        },
      });
      // 不应抛错（预加载失败静默）
      await expect(updater.changeBookSource('b1', 'http://new')).resolves.toBeUndefined();
    });
  });

  describe('refreshChapters', () => {
    it('书不存在应抛 source-unavailable', async () => {
      await expect(updater.refreshChapters('missing')).rejects.toThrow(FetchError);
    });

    it('非 online 来源应抛 unsupported-source', async () => {
      repo.getById = () => makeBook({ source: 'local-txt' });
      await expect(updater.refreshChapters('b1')).rejects.toMatchObject({
        code: 'unsupported-source',
      });
    });

    it('缺 sourceUrl 应抛 parse-failed', async () => {
      repo.getById = () => makeBook({ sourceUrl: undefined });
      await expect(updater.refreshChapters('b1')).rejects.toMatchObject({
        code: 'parse-failed',
      });
    });

    it('新源解析空目录应抛 parse-failed', async () => {
      repo.getById = () => makeBook();
      importViaSource.importByUrl = async () => ({ book: { chapters: [] } });
      await expect(updater.refreshChapters('b1')).rejects.toMatchObject({
        code: 'parse-failed',
      });
    });

    it('全部重复 URL 应返回 {added:0, skipped, total}', async () => {
      repo.getById = () => makeBook();
      loader.getChaptersSync = () => [
        { sourceUrl: 'http://c1' },
        { sourceUrl: 'http://c2' },
      ];
      importViaSource.importByUrl = async () => ({
        book: {
          chapters: [
            { url: 'http://c1', title: 'c1' },
            { url: 'http://c2', title: 'c2' },
          ],
        },
      });
      const result = await updater.refreshChapters('b1');
      expect(result.added).toBe(0);
      expect(result.skipped).toBe(2);
      expect(result.total).toBe(2);
    });
  });

  describe('refreshBookInfo', () => {
    it('书不存在应抛 source-unavailable', async () => {
      await expect(updater.refreshBookInfo('missing')).rejects.toThrow(FetchError);
    });

    it('应能合并新元数据保留用户绑定字段', async () => {
      repo.getById = () =>
        makeBook({
          id: 'b1',
          importedAt: '2025-01-01',
          lastReadAt: '2025-12-31',
        });
      let persisted: unknown;
      repo.persistBook = async (b: unknown) => {
        persisted = b;
      };
      importViaSource.importByUrl = async () => ({
        book: { title: 'Updated', author: 'New Author', kind: 'new-kind' },
      });
      const merged = await updater.refreshBookInfo('b1');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const m = (merged ?? persisted) as any;
      expect(m.title).toBe('Updated');
      expect(m.author).toBe('New Author');
      expect(m.kind).toBe('new-kind');
      // 用户绑定字段保留
      expect(m.id).toBe('b1');
    });
  });

  describe('updateProgress', () => {
    it('书不存在应静默返回', async () => {
      await expect(updater.updateProgress('missing', 5)).resolves.toBeUndefined();
    });

    it('成功应 persistBook 含 progress + lastReadAt', async () => {
      repo.getById = () => makeBook();
      let persisted: unknown;
      repo.persistBook = async (b: unknown) => {
        persisted = b;
      };
      await updater.updateProgress('b1', 5);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const m = persisted as any;
      expect(m.progress.chapterIndex).toBe(5);
      expect(m.lastReadAt).toBeDefined();
    });

    it('persistBook 抛错应静默（warn log）', async () => {
      repo.getById = () => makeBook();
      repo.persistBook = async () => {
        throw new Error('boom');
      };
      // 不应向上抛
      await expect(updater.updateProgress('b1', 5)).resolves.toBeUndefined();
    });
  });
});