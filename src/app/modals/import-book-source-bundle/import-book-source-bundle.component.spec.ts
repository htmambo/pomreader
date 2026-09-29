import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import 'zone.js';
import { TestBed } from '@angular/core/testing';
import {
  BrowserDynamicTestingModule,
  platformBrowserDynamicTesting,
} from '@angular/platform-browser-dynamic/testing';
import { NZ_MODAL_DATA, NzModalRef } from 'ng-zorro-antd/modal';
import {
  ImportBookSourceBundleComponent,
  toPreviewItem,
  isSelectable,
} from './import-book-source-bundle.component';
import { ToastService } from '../../core/services/toast.service';

/**
 * ImportBookSourceBundleComponent spec — 分组渲染数据 / 默认勾选规则 / 统计 / 损坏条目
 *
 * 契约（设计 §5.3 / §8 取舍 4）：
 *  - new / update 默认勾选；conflict 默认不勾
 *  - identical 灰显不可勾、不计入统计
 *  - content 未通过 BookSourceDocSchema 的条目标记损坏：不可勾、不计入统计（渲染端双保险）
 *  - 统计行 = 可勾选条目总数 / 已勾选数
 *
 * 实现说明：组件用 templateUrl，vitest JIT 无法解析外部模板（同
 * book-source-list.component.spec.ts 的结论），故用 runInInjectionContext 直接实例化，
 * 验证驱动渲染的 groups / selectedFileNames / 统计 computed —— 分组渲染的正确性由
 * groups() 的形状锁定（模板只是 @for 遍历它）。
 */

const MIN_RULES = {
  siteName: '示例站',
  searchPath: '/search?keyword={keyword}',
  searchItemPattern: 'css:dl.list dd',
  bookTitlePattern: 'css:h1',
  bookAuthorPattern: 'css:.author',
  chapterItemPattern: 'css:#list a',
  contentPattern: 'css:#content',
};

/** 构造一条 content 合法的 DiffEntry */
function makeEntry(
  kind: BookSourceBundleDiffEntry['kind'],
  fileName: string,
  overrides: Record<string, unknown> = {},
): BookSourceBundleDiffEntry {
  const doc = {
    format: 'pomreader.booksource',
    schemaVersion: 1,
    uuid: fileName,
    name: `源-${fileName}`,
    author: '作者',
    homepage: 'https://example.com',
    urls: ['https://example.com'],
    enabled: true,
    sourceType: 'novel',
    tags: ['标签A'],
    minDelayMs: 0,
    requireUrls: [],
    headers: {},
    rules: MIN_RULES,
    ...overrides,
  };
  return { kind, fileName, uuid: fileName, matchedFileName: null, content: JSON.stringify(doc) };
}

/** 构造一条 content 损坏的 DiffEntry（schema 校验失败：缺 rules） */
function makeCorruptedEntry(
  kind: BookSourceBundleDiffEntry['kind'],
  fileName: string,
): BookSourceBundleDiffEntry {
  return {
    kind,
    fileName,
    uuid: fileName,
    matchedFileName: null,
    content: JSON.stringify({ format: 'other' }),
  };
}

type Harness = {
  component: ImportBookSourceBundleComponent;
  modalRef: { close: ReturnType<typeof vi.fn> };
  toast: { success: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
  onImported: ReturnType<typeof vi.fn>;
};

describe('ImportBookSourceBundleComponent', () => {
  let pomApiMock: {
    booksourceBundleOpen: ReturnType<typeof vi.fn>;
    booksourceBundleApply: ReturnType<typeof vi.fn>;
  };
  let h: Harness;

  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserDynamicTestingModule, platformBrowserDynamicTesting());
  });

  beforeEach(() => {
    pomApiMock = {
      booksourceBundleOpen: vi.fn(async () => ({ error: null, entries: [] })),
      booksourceBundleApply: vi.fn(async () => ({ written: [], failed: [] })),
    };
    (globalThis as any).window = { pomAPI: pomApiMock };

    const modalRef = { close: vi.fn() };
    const toast = { success: vi.fn(), error: vi.fn() };
    const onImported = vi.fn();

    TestBed.configureTestingModule({
      providers: [
        { provide: NZ_MODAL_DATA, useValue: { onImported } },
        { provide: NzModalRef, useValue: modalRef },
        { provide: ToastService, useValue: toast },
      ],
    });

    const component = TestBed.runInInjectionContext(() => new ImportBookSourceBundleComponent());
    h = { component, modalRef, toast, onImported };
  });

  /** 等构造里 void this.open() 的微任务链跑完 */
  async function flushOpen(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  async function openWith(result: BookSourceBundleOpenResult): Promise<void> {
    pomApiMock.booksourceBundleOpen.mockResolvedValueOnce(result);
    await (h.component as unknown as { open(): Promise<void> }).open();
  }

  describe('open 入口三分支', () => {
    it('entries → phase=preview，逐条 valibot parse 出展示 meta', async () => {
      await openWith({
        error: null,
        entries: [makeEntry('new', 'a.json')],
      });
      expect(h.component['phase']()).toBe('preview');
      const item = h.component['items']()[0];
      expect(item.name).toBe('源-a.json');
      expect(item.tags).toEqual(['标签A']);
      expect(item.corrupted).toBe(false);
    });

    it('{ error } → phase=error 并停留（不关弹窗）', async () => {
      await openWith({ error: 'format 不匹配', entries: [] });
      expect(h.component['phase']()).toBe('error');
      expect(h.component['errorMsg']()).toBe('format 不匹配');
      expect(h.modalRef.close).not.toHaveBeenCalled();
    });

    it('null（用户取消选文件）→ 直接关弹窗，不进入 preview 也不报 error', async () => {
      await openWith(null);
      expect(h.modalRef.close).toHaveBeenCalled();
      expect(h.component['phase']()).not.toBe('error');
      expect(h.component['items']()).toEqual([]);
    });
  });

  describe('分组渲染（groups computed）', () => {
    it('按 new → update → conflict → identical 固定顺序，空组不渲染', async () => {
      await openWith({
        error: null,
        entries: [
          makeEntry('identical', 'same.json'),
          makeEntry('update', 'upd.json'),
          makeEntry('new', 'new.json'),
          makeEntry('conflict', 'cft.json'),
        ],
      });
      const groups = h.component['groups']();
      expect(groups.map((g) => g.kind)).toEqual(['new', 'update', 'conflict', 'identical']);
      expect(groups.map((g) => g.items.map((i) => i.fileName))).toEqual([
        ['new.json'],
        ['upd.json'],
        ['cft.json'],
        ['same.json'],
      ]);
    });

    it('本地导入无 conflict / identical 时只渲染命中的组', async () => {
      await openWith({
        error: null,
        entries: [makeEntry('new', 'a.json'), makeEntry('update', 'b.json')],
      });
      expect(h.component['groups']().map((g) => g.kind)).toEqual(['new', 'update']);
    });
  });

  describe('默认勾选规则', () => {
    beforeEach(async () => {
      await openWith({
        error: null,
        entries: [
          makeEntry('new', 'new.json'),
          makeEntry('update', 'upd.json'),
          makeEntry('conflict', 'cft.json'),
          makeEntry('identical', 'same.json'),
          makeCorruptedEntry('new', 'bad.json'),
        ],
      });
    });

    it('new / update 默认勾；conflict 不勾；identical / 损坏条目不可勾', () => {
      const selected = h.component['selectedFileNames']();
      expect(selected.has('new.json')).toBe(true);
      expect(selected.has('upd.json')).toBe(true);
      expect(selected.has('cft.json')).toBe(false);
      expect(selected.has('same.json')).toBe(false);
      expect(selected.has('bad.json')).toBe(false);
    });

    it('统计：共 N 条（可勾选基数，identical / 损坏不计入），将写入 M 条', () => {
      // 可勾选 = new + update + conflict = 3；默认勾 new + update = 2
      expect(h.component['totalCount']()).toBe(3);
      expect(h.component['selectedCount']()).toBe(2);
      expect(h.component['corruptedCount']()).toBe(1);
    });

    it('conflict 可手动勾选计入将写入数；identical / 损坏条目 toggle 无效', () => {
      const items = h.component['items']();
      const byName = (n: string) => items.find((i) => i.fileName === n)!;

      h.component['toggle'](byName('cft.json'));
      expect(h.component['selectedCount']()).toBe(3);

      h.component['toggle'](byName('same.json'));
      h.component['toggle'](byName('bad.json'));
      expect(h.component['selectedCount']()).toBe(3); // 不可勾，数量不变
    });
  });

  describe('toPreviewItem / isSelectable（渲染端双保险）', () => {
    it('JSON 非法 → 损坏条目，name=null（UI 回退展示 fileName）', () => {
      const item = toPreviewItem({
        kind: 'new',
        fileName: 'x.json',
        uuid: 'x.json',
        content: '{not-json',
      });
      expect(item.corrupted).toBe(true);
      expect(item.name).toBeNull();
      expect(isSelectable(item)).toBe(false);
    });

    it('schema 校验失败 → 损坏条目且不计入勾选基数', () => {
      const item = toPreviewItem(makeCorruptedEntry('update', 'y.json'));
      expect(item.corrupted).toBe(true);
      expect(isSelectable(item)).toBe(false);
    });

    it('identical 即使 content 合法也不可勾', () => {
      const item = toPreviewItem(makeEntry('identical', 'z.json'));
      expect(item.corrupted).toBe(false);
      expect(isSelectable(item)).toBe(false);
    });
  });

  describe('apply', () => {
    it('勾选条目 → apply 通道只收到 { fileName, content }，成功后回调刷新并关弹窗', async () => {
      await openWith({
        error: null,
        entries: [makeEntry('new', 'a.json'), makeEntry('new', 'b.json')],
      });
      pomApiMock.booksourceBundleApply.mockResolvedValueOnce({
        written: ['a.json', 'b.json'],
        failed: [],
      });

      await (h.component as unknown as { apply(): Promise<void> }).apply();

      const decisions = pomApiMock.booksourceBundleApply.mock.calls[0][0];
      expect(decisions.map((d: { fileName: string }) => d.fileName)).toEqual(['a.json', 'b.json']);
      expect(Object.keys(decisions[0]).sort()).toEqual(['content', 'fileName']);
      expect(h.toast.success).toHaveBeenCalled();
      expect(h.onImported).toHaveBeenCalled();
      expect(h.modalRef.close).toHaveBeenCalled();
    });

    it('部分失败 → error toast 报告 written/failed（§8 取舍 1：失败项收集报告）', async () => {
      await openWith({
        error: null,
        entries: [makeEntry('new', 'a.json'), makeEntry('new', 'b.json')],
      });
      pomApiMock.booksourceBundleApply.mockResolvedValueOnce({
        written: ['a.json'],
        failed: [{ fileName: 'b.json', error: '写盘失败' }],
      });

      await (h.component as unknown as { apply(): Promise<void> }).apply();

      expect(h.toast.error).toHaveBeenCalledWith(expect.stringContaining('b.json'));
    });
  });

  describe('构造函数自启动 open', () => {
    it('mock 直接返回 entries 时，构造后自动进入 preview', async () => {
      pomApiMock.booksourceBundleOpen.mockResolvedValue({
        error: null,
        entries: [makeEntry('new', 'a.json')],
      });
      const comp = TestBed.runInInjectionContext(() => new ImportBookSourceBundleComponent());
      await flushOpen();
      expect(comp['phase']()).toBe('preview');
    });
  });
});
