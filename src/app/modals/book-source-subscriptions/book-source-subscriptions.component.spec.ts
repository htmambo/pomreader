import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import 'zone.js';
import { TestBed } from '@angular/core/testing';
import {
  BrowserDynamicTestingModule,
  platformBrowserDynamicTesting,
} from '@angular/platform-browser-dynamic/testing';
import { NzModalRef, NzModalService } from 'ng-zorro-antd/modal';
import {
  BookSourceSubscriptionsComponent,
  DEFAULT_INTERVAL_HOURS,
} from './book-source-subscriptions.component';
import { ToastService } from '../../core/services/toast.service';

/**
 * BookSourceSubscriptionsComponent spec — Phase 2 订阅管理弹窗（设计 §6.4）
 *
 * 覆盖：订阅表数据加载（含 lastError 展示所需字段透传）、新增 / 编辑保存的调用形状、
 * 删除二次确认、立即检查结果 toast（changed / conflicts / error 三分支）、启用开关、
 * 上次/下次检查列文案。
 *
 * 实现说明同 Phase 1：组件用 templateUrl，vitest JIT 无法解析外部模板，故用
 * runInInjectionContext 直接实例化，验证驱动渲染的 items / editing 等 signal 状态。
 */

function makeSub(overrides: Partial<BookSourceSubscription> = {}): BookSourceSubscription {
  return {
    id: 's1',
    name: '示例订阅',
    url: 'https://example.com/sources.json',
    enabled: true,
    intervalHours: 12,
    lastCheckedAt: 1789000000000,
    lastError: null,
    ...overrides,
  };
}

type Harness = {
  component: BookSourceSubscriptionsComponent;
  modalRef: { close: ReturnType<typeof vi.fn> };
  modal: { confirm: ReturnType<typeof vi.fn> };
  toast: {
    success: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
  };
};

describe('BookSourceSubscriptionsComponent', () => {
  let pomApiMock: {
    booksourceSubList: ReturnType<typeof vi.fn>;
    booksourceSubSave: ReturnType<typeof vi.fn>;
    booksourceSubDelete: ReturnType<typeof vi.fn>;
    booksourceSubCheck: ReturnType<typeof vi.fn>;
  };
  let h: Harness;

  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserDynamicTestingModule, platformBrowserDynamicTesting());
  });

  beforeEach(async () => {
    pomApiMock = {
      booksourceSubList: vi.fn(async () => [makeSub()]),
      booksourceSubSave: vi.fn(async () => undefined),
      booksourceSubDelete: vi.fn(async () => undefined),
      booksourceSubCheck: vi.fn(async () => ({ changed: 0, conflicts: 0, error: null })),
    };
    (globalThis as any).window = { pomAPI: pomApiMock };

    const modalRef = { close: vi.fn() };
    const modal = { confirm: vi.fn() };
    const toast = { success: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() };

    TestBed.configureTestingModule({
      providers: [
        { provide: NzModalRef, useValue: modalRef },
        { provide: NzModalService, useValue: modal },
        { provide: ToastService, useValue: toast },
      ],
    });

    const component = TestBed.runInInjectionContext(() => new BookSourceSubscriptionsComponent());
    h = { component, modalRef, modal, toast };
    // 等构造里 void this.load() 跑完
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  describe('load（订阅表渲染数据）', () => {
    it('打开即拉全量订阅，items 透传 lastError 等状态列字段', () => {
      expect(pomApiMock.booksourceSubList).toHaveBeenCalled();
      expect(h.component['loading']()).toBe(false);
      expect(h.component['items']()).toHaveLength(1);
      expect(h.component['items']()[0].name).toBe('示例订阅');
      // lastError 非空时状态列渲染「最近失败」—— 数据通路锁定
      pomApiMock.booksourceSubList.mockResolvedValueOnce([makeSub({ lastError: '网络超时' })]);
      return (h.component as unknown as { load(): Promise<void> }).load().then(() => {
        expect(h.component['items']()[0].lastError).toBe('网络超时');
      });
    });

    it('IPC 不可用 → loadError 非空，items 为空', async () => {
      (globalThis as any).window = {};
      const comp = TestBed.runInInjectionContext(() => new BookSourceSubscriptionsComponent());
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(comp['loadError']()).toBe('IPC 不可用');
      expect(comp['items']()).toEqual([]);
    });
  });

  describe('新增 / 编辑表单', () => {
    it('startAdd 打开空表单：id 空串、intervalHours 默认 12、enabled 默认 true', () => {
      expect(DEFAULT_INTERVAL_HOURS).toBe(12);
      h.component['startAdd']();
      const f = h.component['editing']()!;
      expect(f.id).toBe('');
      expect(f.intervalHours).toBe(12);
      expect(f.enabled).toBe(true);
      expect(h.component['canSave']()).toBe(false); // 名称 / URL 未填
    });

    it('canSave：名称与 URL 均非空才可提交', () => {
      h.component['startAdd']();
      const f = h.component['editing']()!;
      f.name = '  ';
      f.url = 'https://a';
      expect(h.component['canSave']()).toBe(false);
      f.name = '新订阅';
      expect(h.component['canSave']()).toBe(true);
    });

    it('保存新增：id 传空串、名称 / URL trim，成功后 toast + 收起表单 + 重拉列表', async () => {
      h.component['startAdd']();
      const f = h.component['editing']()!;
      f.name = '  新订阅  ';
      f.url = '  https://example.com/s.json  ';
      pomApiMock.booksourceSubList.mockClear();

      await (h.component as unknown as { save(): Promise<void> }).save();

      const saved = pomApiMock.booksourceSubSave.mock.calls[0][0] as BookSourceSubscription;
      expect(saved.id).toBe('');
      expect(saved.name).toBe('新订阅');
      expect(saved.url).toBe('https://example.com/s.json');
      expect(saved.intervalHours).toBe(12);
      expect(saved.enabled).toBe(true);
      expect(saved.lastCheckedAt).toBeNull();
      expect(saved.lastError).toBeNull();
      expect(h.toast.success).toHaveBeenCalledWith(expect.stringContaining('已新增'));
      expect(h.component['editing']()).toBeNull();
      expect(pomApiMock.booksourceSubList).toHaveBeenCalled(); // 重拉
    });

    it('编辑保存：startEdit 拷贝列表项，save 保留原 id 与基线字段', async () => {
      const sub = makeSub({ id: 's9', lastCheckedAt: 123, intervalHours: 6 });
      h.component['startEdit'](sub);
      const f = h.component['editing']()!;
      f.name = '改名';

      await (h.component as unknown as { save(): Promise<void> }).save();

      const saved = pomApiMock.booksourceSubSave.mock.calls[0][0] as BookSourceSubscription;
      expect(saved.id).toBe('s9');
      expect(saved.name).toBe('改名');
      expect(saved.lastCheckedAt).toBe(123);
      expect(saved.intervalHours).toBe(6);
      expect(h.toast.success).toHaveBeenCalledWith(expect.stringContaining('已保存'));
    });

    it('保存失败 → error toast，表单不收起', async () => {
      h.component['startAdd']();
      const f = h.component['editing']()!;
      f.name = 'x';
      f.url = 'https://a';
      pomApiMock.booksourceSubSave.mockRejectedValueOnce(new Error('写盘失败'));

      await (h.component as unknown as { save(): Promise<void> }).save();

      expect(h.toast.error).toHaveBeenCalledWith(expect.stringContaining('写盘失败'));
      expect(h.component['editing']()).not.toBeNull();
    });
  });

  describe('删除（二次确认）', () => {
    it('confirmDelete 弹确认框；确认后调 sub-delete 并重拉列表', async () => {
      const sub = makeSub({ id: 's1', name: '待删' });
      h.component['confirmDelete'](sub);

      expect(h.modal.confirm).toHaveBeenCalledTimes(1);
      const opts = h.modal.confirm.mock.calls[0][0] as {
        nzTitle: string;
        nzOnOk: () => Promise<void>;
      };
      expect(opts.nzTitle).toContain('待删');

      pomApiMock.booksourceSubList.mockClear();
      await opts.nzOnOk();

      expect(pomApiMock.booksourceSubDelete).toHaveBeenCalledWith('s1');
      expect(h.toast.success).toHaveBeenCalledWith(expect.stringContaining('已删除'));
      expect(pomApiMock.booksourceSubList).toHaveBeenCalled();
    });

    it('删除失败 → error toast', async () => {
      h.component['confirmDelete'](makeSub());
      const opts = h.modal.confirm.mock.calls[0][0] as { nzOnOk: () => Promise<void> };
      pomApiMock.booksourceSubDelete.mockRejectedValueOnce(new Error('IPC failed'));
      await opts.nzOnOk();
      expect(h.toast.error).toHaveBeenCalledWith(expect.stringContaining('删除失败'));
    });
  });

  describe('立即检查（checkNow）', () => {
    it('changed>0 且无冲突 → success toast 报更新数，并重拉刷新状态列', async () => {
      pomApiMock.booksourceSubCheck.mockResolvedValueOnce({
        changed: 3,
        conflicts: 0,
        error: null,
      });
      pomApiMock.booksourceSubList.mockClear();

      await (h.component as unknown as { checkNow(s: BookSourceSubscription): Promise<void> })[
        'checkNow'
      ](makeSub());

      expect(pomApiMock.booksourceSubCheck).toHaveBeenCalledWith('s1');
      expect(h.toast.success).toHaveBeenCalledWith(expect.stringContaining('已更新 3 个书源'));
      expect(pomApiMock.booksourceSubList).toHaveBeenCalled();
      expect(h.component['checkingId']()).toBeNull();
    });

    it('conflicts>0 → warn toast：冲突只提示，文案说明已跳过自动写入', async () => {
      pomApiMock.booksourceSubCheck.mockResolvedValueOnce({
        changed: 1,
        conflicts: 2,
        error: null,
      });

      await (h.component as unknown as { checkNow(s: BookSourceSubscription): Promise<void> })[
        'checkNow'
      ](makeSub());

      expect(h.toast.warn).toHaveBeenCalledWith(expect.stringContaining('2 条与本地修改冲突'));
      expect(h.toast.warn).toHaveBeenCalledWith(expect.stringContaining('已跳过自动写入'));
      expect(h.toast.success).not.toHaveBeenCalled();
    });

    it('error 非 null → error toast；changed/conflicts 忽略', async () => {
      pomApiMock.booksourceSubCheck.mockResolvedValueOnce({
        changed: 0,
        conflicts: 0,
        error: '拉取超时',
      });

      await (h.component as unknown as { checkNow(s: BookSourceSubscription): Promise<void> })[
        'checkNow'
      ](makeSub());

      expect(h.toast.error).toHaveBeenCalledWith(expect.stringContaining('拉取超时'));
    });

    it('changed / conflicts / error 全零 → info 已是最新', async () => {
      await (h.component as unknown as { checkNow(s: BookSourceSubscription): Promise<void> })[
        'checkNow'
      ](makeSub());
      expect(h.toast.info).toHaveBeenCalledWith(expect.stringContaining('已是最新'));
    });
  });

  describe('启用开关（setEnabled）', () => {
    it('复用 sub-save 通道，成功后本地 patch enabled', async () => {
      await (
        h.component as unknown as {
          setEnabled(s: BookSourceSubscription, next: boolean): Promise<void>;
        }
      )['setEnabled'](makeSub({ id: 's1', enabled: true }), false);

      const saved = pomApiMock.booksourceSubSave.mock.calls[0][0] as BookSourceSubscription;
      expect(saved.id).toBe('s1');
      expect(saved.enabled).toBe(false);
      expect(h.component['items']()[0].enabled).toBe(false);
    });

    it('失败 → error toast 并重拉纠正', async () => {
      pomApiMock.booksourceSubSave.mockRejectedValueOnce(new Error('IPC failed'));
      pomApiMock.booksourceSubList.mockClear();

      await (
        h.component as unknown as {
          setEnabled(s: BookSourceSubscription, next: boolean): Promise<void>;
        }
      )['setEnabled'](makeSub(), false);

      expect(h.toast.error).toHaveBeenCalledWith(expect.stringContaining('操作失败'));
      expect(pomApiMock.booksourceSubList).toHaveBeenCalled();
    });
  });

  describe('上次 / 下次检查列文案', () => {
    it('lastCheckedAt=null → 从未；否则 toLocaleString', () => {
      expect(h.component['formatTs'](null)).toBe('从未');
      expect(h.component['formatTs'](1789000000000)).toBe(new Date(1789000000000).toLocaleString());
    });

    it('停用 → —；启用但从未成功 → 下一调度跳；否则 lastCheckedAt + intervalHours', () => {
      expect(h.component['nextCheckText'](makeSub({ enabled: false }))).toBe('—');
      expect(h.component['nextCheckText'](makeSub({ lastCheckedAt: null }))).toBe('下一调度跳');
      const sub = makeSub({ lastCheckedAt: 1789000000000, intervalHours: 12 });
      expect(h.component['nextCheckText'](sub)).toBe(
        new Date(1789000000000 + 12 * 3600_000).toLocaleString(),
      );
    });
  });
});
