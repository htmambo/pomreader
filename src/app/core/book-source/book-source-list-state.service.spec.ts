import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BookSourceListStateService } from './book-source-list-state.service';
import { BookSourceMeta } from './source-meta.types';
import { ToastService } from '../services/toast.service';

/**
 * BookSourceListStateService spec 锁定 stale-while-revalidate + 乐观更新回滚
 * + pom:booksource-updated 广播：静默刷新 + source === 'subscription' 时弹订阅更新 toast
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
  let toastMock: { success: any; error: any; warn: any; info: any };
  /** 构造函数里注册到 pom:booksource-updated 的 listener */
  let updatedListener: ((payload: unknown) => void) | null;

  beforeEach(() => {
    updatedListener = null;
    pomApiMock = {
      booksourceListJson: vi.fn(async () => []),
      booksourceToggleJson: vi.fn(async () => undefined),
      booksourceDeleteJson: vi.fn(async () => undefined),
      on: vi.fn((channel: string, listener: (payload: unknown) => void) => {
        if (channel === 'pom:booksource-updated') updatedListener = listener;
        return () => undefined;
      }),
    };
    toastMock = { success: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() };

    (globalThis as any).window = { pomAPI: pomApiMock };
    svc = new BookSourceListStateService(toastMock as unknown as ToastService);
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

  describe('pom:booksource-updated 广播', () => {
    const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

    it('任何 source 都触发后台静默刷新列表', async () => {
      pomApiMock.booksourceListJson.mockResolvedValue([makeMeta({ fileName: 'x.json' })]);
      updatedListener!({ source: 'bundle-import', count: 1 });
      await flush();
      expect(svc.sources().map((s) => s.fileName)).toEqual(['x.json']);
    });

    it('source=subscription 且 conflicts>0 → warn toast，含订阅名 / 更新数 / 冲突数', async () => {
      pomApiMock.booksourceSubList = vi.fn(async () => [
        {
          id: 's1',
          name: '订阅A',
          url: 'https://a',
          enabled: true,
          intervalHours: 12,
          lastCheckedAt: 1,
          lastError: null,
        },
      ]);
      updatedListener!({ source: 'subscription', subscriptionId: 's1', changed: 2, conflicts: 1 });
      await flush();
      expect(toastMock.warn).toHaveBeenCalledWith(expect.stringContaining('订阅A'));
      expect(toastMock.warn).toHaveBeenCalledWith(expect.stringContaining('2 条'));
      expect(toastMock.warn).toHaveBeenCalledWith(expect.stringContaining('1 条'));
      expect(toastMock.success).not.toHaveBeenCalled();
    });

    it('source=subscription 且无冲突 → success toast', async () => {
      pomApiMock.booksourceSubList = vi.fn(async () => [
        {
          id: 's1',
          name: '订阅A',
          url: 'https://a',
          enabled: true,
          intervalHours: 12,
          lastCheckedAt: 1,
          lastError: null,
        },
      ]);
      updatedListener!({ source: 'subscription', subscriptionId: 's1', changed: 3, conflicts: 0 });
      await flush();
      expect(toastMock.success).toHaveBeenCalledWith(
        expect.stringContaining('订阅《订阅A》已更新 3 个书源'),
      );
      expect(toastMock.warn).not.toHaveBeenCalled();
    });

    it('订阅名解析失败（subList 不可用 / 抛错）→ toast 回退展示 subscriptionId', async () => {
      // 未提供 booksourceSubList
      updatedListener!({ source: 'subscription', subscriptionId: 's9', changed: 1, conflicts: 0 });
      await flush();
      expect(toastMock.success).toHaveBeenCalledWith(expect.stringContaining('s9'));

      pomApiMock.booksourceSubList = vi.fn(async () => {
        throw new Error('IPC failed');
      });
      updatedListener!({ source: 'subscription', subscriptionId: 's8', changed: 1, conflicts: 0 });
      await flush();
      expect(toastMock.success).toHaveBeenCalledWith(expect.stringContaining('s8'));
    });

    it('source 非 subscription（bundle-import / 缺省）→ 不弹订阅 toast', async () => {
      updatedListener!({ source: 'bundle-import', count: 2 });
      updatedListener!(undefined);
      await flush();
      expect(toastMock.success).not.toHaveBeenCalled();
      expect(toastMock.warn).not.toHaveBeenCalled();
    });
  });
});
