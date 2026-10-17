import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import 'zone.js';
import { TestBed } from '@angular/core/testing';
import {
  BrowserDynamicTestingModule,
  platformBrowserDynamicTesting,
} from '@angular/platform-browser-dynamic/testing';
import { ImportLocalTxtComponent } from './import-local-txt.component';
import { ToastService } from '../../core/services/toast.service';
import { LocalTxtImportService } from '../../core/services/local-txt-import.service';

/**
 * ImportLocalTxtComponent spec — 批量导入的并发守卫与跳过规则
 *
 * 契约（外部审查 P0/P1）：
 *  - 重解码（onEncodingChange）进行中：confirm 必须立即返回 false 且不动书架
 *    （否则未重解码的条目会以旧编码入库 → 混合编码导入）
 *  - 重解码不可重入：第二次切换编码被忽略，不发生第二次 arrayBuffer 读取
 *  - confirm 不可重入：导入进行中再次 confirm 返回 false，importText 只调用一次
 *  - 已导入（imported）条目不参与重解码（避免预览与库内内容不一致）
 *  - 重复条目（书架已有）跳过并计入 skipped，成功 toast 同时报告导入数与跳过数
 *
 * 实现说明：组件用 templateUrl，vitest JIT 无法解析外部模板（同
 * import-book-source-bundle.component.spec.ts 的结论），故用 runInInjectionContext
 * 直接实例化，验证驱动行为的 signal / computed 与方法契约。
 */

type Harness = {
  component: ImportLocalTxtComponent;
  toast: {
    success: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
  };
  importer: {
    importText: ReturnType<typeof vi.fn>;
    hasBook: ReturnType<typeof vi.fn>;
    titleOf: (name: string) => string;
    split: ReturnType<typeof vi.fn>;
  };
};

/** 构造一个可控 arrayBuffer 的假 File；resolveBuf 由测试在需要时调用 */
function makeControlledFile(name: string) {
  let resolveBuf: (b: ArrayBuffer) => void = () => {};
  const file = {
    name,
    size: 10,
    arrayBuffer: vi.fn(
      () =>
        new Promise<ArrayBuffer>((r) => {
          resolveBuf = r;
        }),
    ),
  };
  return {
    file: file as unknown as File,
    arrayBuffer: file.arrayBuffer,
    resolveBuf: (b: ArrayBuffer) => resolveBuf(b),
  };
}

function makeEntry(name: string, overrides: Record<string, unknown> = {}) {
  return {
    name,
    sizeLabel: '10 B',
    file: { name, size: 10, arrayBuffer: async () => new ArrayBuffer(4) } as unknown as File,
    text: '第一章\n正文',
    encoding: 'gb18030',
    chapters: [{ title: '第一章', startLine: 0, endLine: 1 }],
    error: '',
    status: 'pending',
    ...overrides,
  };
}

describe('ImportLocalTxtComponent（批量导入并发守卫）', () => {
  let h: Harness;

  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserDynamicTestingModule, platformBrowserDynamicTesting());
  });

  beforeEach(() => {
    const toast = { success: vi.fn(), error: vi.fn(), warn: vi.fn() };
    const importer = {
      importText: vi.fn(async () => ({})),
      hasBook: vi.fn((_name: string) => false),
      titleOf: (name: string) => name.replace(/\.txt$/i, ''),
      split: vi.fn((_text: string) => [{ title: '第一章', startLine: 0, endLine: 1 }]),
    };
    TestBed.configureTestingModule({
      providers: [
        { provide: ToastService, useValue: toast },
        { provide: LocalTxtImportService, useValue: importer },
      ],
    });
    const component = TestBed.runInInjectionContext(() => new ImportLocalTxtComponent());
    h = { component, toast, importer };
  });

  it('重解码进行中 confirm 被拒：返回 false、不调用 importText（防混合编码导入）', async () => {
    const { file, arrayBuffer, resolveBuf } = makeControlledFile('a.txt');
    h.component.entries.set([makeEntry('a.txt', { file })] as never[]);

    const p = h.component.onEncodingChange('utf-8');
    expect(h.component.reencoding()).toBe(true);
    expect(arrayBuffer).toHaveBeenCalledTimes(1);

    await expect(h.component.confirm()).resolves.toBe(false);
    expect(h.importer.importText).not.toHaveBeenCalled();

    resolveBuf(new ArrayBuffer(4));
    await p;
    expect(h.component.reencoding()).toBe(false);
  });

  it('重解码不可重入：第二次切换编码被忽略，不发起第二次读取', async () => {
    const { file, arrayBuffer, resolveBuf } = makeControlledFile('a.txt');
    h.component.entries.set([makeEntry('a.txt', { file })] as never[]);

    const p1 = h.component.onEncodingChange('utf-8');
    await h.component.onEncodingChange('gbk'); // reencoding=true → 立即返回
    expect(arrayBuffer).toHaveBeenCalledTimes(1);

    resolveBuf(new ArrayBuffer(4));
    await p1;
    expect(h.component.reencoding()).toBe(false);
  });

  it('confirm 不可重入：导入进行中再次 confirm 返回 false，importText 只调一次', async () => {
    let resolveImport: () => void = () => {};
    h.importer.importText.mockImplementation(
      () =>
        new Promise<object>((r) => {
          resolveImport = () => r({});
        }),
    );
    h.component.entries.set([makeEntry('a.txt')] as never[]);

    const p1 = h.component.confirm();
    expect(h.component.importing()).toBe(true);
    await expect(h.component.confirm()).resolves.toBe(false);
    expect(h.importer.importText).toHaveBeenCalledTimes(1);

    resolveImport();
    await expect(p1).resolves.toBe(true);
    expect(h.component.importing()).toBe(false);
  });

  it('已导入条目不参与重解码：不读取文件、文本保持不变', async () => {
    const { file, arrayBuffer } = makeControlledFile('a.txt');
    const entry = makeEntry('a.txt', { file, status: 'imported', text: '旧文本' });
    h.component.entries.set([entry] as never[]);

    await h.component.onEncodingChange('utf-8');
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(h.component.entries()[0].text).toBe('旧文本');
  });

  it('failed 行经重编码复位为 pending 可重试：重解码后 confirm 成功导入', async () => {
    const entry = makeEntry('a.txt', { status: 'failed' });
    h.component.entries.set([entry] as never[]);

    await h.component.onEncodingChange('utf-8');
    expect(h.component.entries()[0].status).toBe('pending');

    await expect(h.component.confirm()).resolves.toBe(true);
    expect(h.importer.importText).toHaveBeenCalledTimes(1);
    expect(h.component.entries()[0].status).toBe('imported');
  });

  it('重复条目跳过并计数：toast 同时报告导入数与跳过数', async () => {
    h.importer.hasBook.mockImplementation((name: string) => name === 'b.txt');
    h.component.entries.set([makeEntry('a.txt'), makeEntry('b.txt')] as never[]);

    await expect(h.component.confirm()).resolves.toBe(true);
    expect(h.importer.importText).toHaveBeenCalledTimes(1);
    expect(h.importer.importText).toHaveBeenCalledWith('a.txt', '第一章\n正文');
    expect(h.toast.success).toHaveBeenCalledWith('已导入 1 本，跳过重复 1 本');
    expect(h.toast.error).not.toHaveBeenCalled();
  });

  it('ok=0 时纯跳过摘要降级为 warn：不与失败 error toast 级别冲突', async () => {
    h.importer.hasBook.mockImplementation((name: string) => name === 'b.txt');
    h.importer.importText.mockRejectedValueOnce(new Error('db full'));
    h.component.entries.set([makeEntry('a.txt'), makeEntry('b.txt')] as never[]);

    await expect(h.component.confirm()).resolves.toBe(false);
    expect(h.toast.success).not.toHaveBeenCalled();
    expect(h.toast.warn).toHaveBeenCalledWith('跳过重复 1 本');
    expect(h.toast.error).toHaveBeenCalledWith('导入失败 1 本：a.txt');
  });
});
