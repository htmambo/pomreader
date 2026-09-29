import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BookSourceListStateService } from './book-source-list-state.service';
import { BookSourceMeta } from './source-meta.types';

/**
 * BookSourceListStateService spec 锁定 stale-while-revalidate + 乐观更新回滚
 */

function makeMeta(overrides: Partial<BookSourceMeta> = {}): BookSourceMeta {
  return {
    fileName: 'test.json',
    name: 'Test',
    enabled: true,
    ...overrides,
  };
}

describe('BookSourceListStateService', () => {
  let svc: BookSourceListStateService;

  let pomApiMock: any;

  beforeEach(() => {
    pomApiMock = {
      booksourceListJson: vi.fn(async () => []),
      booksourceToggleJson: vi.fn(async () => undefined),
      booksourceDeleteJson: vi.fn(async () => undefined),
    };

    (globalThis as any).window = { pomAPI: pomApiMock };
    svc = new BookSourceListStateService();
  });

  describe('refresh', () => {
    it('首次 refresh 应设置 sources + loaded=true', async () => {
      const sources = [makeMeta({ fileName: 'a.json' }), makeMeta({ fileName: 'b.json' })];
      pomApiMock.booksourceListJson.mockResolvedValueOnce(sources);
      await svc.refresh(true);
      expect(svc.sources()).toEqual(sources);
      expect(svc.loaded()).toBe(true);
      expect(svc.refreshing()).toBe(false);
    });

    it('IPC 返回非数组时应兜底为 []', async () => {
      pomApiMock.booksourceListJson.mockResolvedValueOnce(null);
      await svc.refresh(true);
      expect(svc.sources()).toEqual([]);
    });

    it('refresh(showLoading=false) 应跳过 loading 但仍走后台刷新', async () => {
      const sources = [makeMeta({ fileName: 'a.json' })];
      pomApiMock.booksourceListJson.mockResolvedValueOnce(sources);
      await svc.refresh(false);
      expect(svc.refreshing()).toBe(false); // finally 清理
      expect(svc.sources()).toEqual(sources);
    });

    it('IPC 不可用时应抛 Error("IPC 不可用")', async () => {
      (globalThis as any).window = {};

      const fresh = new (BookSourceListStateService as any)();
      await expect(fresh.refresh(true)).rejects.toThrow('IPC 不可用');
    });
  });

  describe('toggle 乐观更新 + 回滚', () => {
    it('成功切换 enabled 后应持久化新值', async () => {
      svc.sources.set([makeMeta({ fileName: 'a.json', enabled: true })]);
      await svc.toggle(makeMeta({ fileName: 'a.json', enabled: true }), false);
      expect(svc.sources()[0].enabled).toBe(false);
      expect(pomApiMock.booksourceToggleJson).toHaveBeenCalledWith('a.json', false, undefined);
    });

    it('IPC 抛错时 enabled 应回滚到原值并向上传播', async () => {
      svc.sources.set([makeMeta({ fileName: 'a.json', enabled: true })]);
      pomApiMock.booksourceToggleJson.mockRejectedValueOnce(new Error('IPC failed'));
      await expect(
        svc.toggle(makeMeta({ fileName: 'a.json', enabled: true }), false),
      ).rejects.toThrow('IPC failed');
      expect(svc.sources()[0].enabled).toBe(true); // 回滚
    });

    it('IPC 不可用时应抛 Error', async () => {
      (globalThis as any).window = {};

      const fresh = new (BookSourceListStateService as any)();
      fresh.sources.set([makeMeta()]);
      await expect(fresh.toggle(makeMeta(), false)).rejects.toThrow('IPC 不可用');
    });
  });

  describe('remove', () => {
    it('成功删除后应从 sources 中移除', async () => {
      svc.sources.set([makeMeta({ fileName: 'a.json' }), makeMeta({ fileName: 'b.json' })]);
      await svc.remove(makeMeta({ fileName: 'a.json' }));
      expect(svc.sources().map((s) => s.fileName)).toEqual(['b.json']);
      expect(pomApiMock.booksourceDeleteJson).toHaveBeenCalledWith('a.json', undefined);
    });

    it('IPC 抛错时 sources 应保留条目并向上抛错', async () => {
      svc.sources.set([makeMeta({ fileName: 'a.json' })]);
      pomApiMock.booksourceDeleteJson.mockRejectedValueOnce(new Error('IPC failed'));
      await expect(svc.remove(makeMeta({ fileName: 'a.json' }))).rejects.toThrow('IPC failed');
      expect(svc.sources()).toHaveLength(1); // 未删除
    });

    it('IPC 不可用时应抛 Error', async () => {
      (globalThis as any).window = {};

      const fresh = new (BookSourceListStateService as any)();
      await expect(fresh.remove(makeMeta())).rejects.toThrow('IPC 不可用');
    });
  });
});
