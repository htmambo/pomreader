import { describe, it, expect, beforeEach, vi, beforeAll } from 'vitest';
import 'zone.js';
import { TestBed } from '@angular/core/testing';
import {
  BrowserDynamicTestingModule,
  platformBrowserDynamicTesting,
} from '@angular/platform-browser-dynamic/testing';
import { AutoImportService } from './auto-import.service';
import { ToastService } from './toast.service';
import { LocalTxtImportService } from './local-txt-import.service';

/**
 * AutoImportService spec — 自动导入监控（万能搜索 webview）
 * 使用 Angular TestBed 上下文（其他 0% service 多用此模式）
 */

// Mock ToastService + LocalTxtImportService（auto-import 依赖）
function setupTestBed(autoImportApi: unknown) {
  const toastMock: any = { error: vi.fn(), info: vi.fn(), success: vi.fn(), warn: vi.fn() };

  const importerMock: any = {
    hasBook: vi.fn(() => false),
    titleOf: vi.fn((name: string) => name.replace(/\.[^.]+$/, '')),
    importText: vi.fn(async (fileName: string, _text: string, _source: string) => ({
      book: { id: 'txt-' + Date.now(), title: fileName },
      chapters: [{ bookId: 'x', index: 0, title: 'c1', content: '', loaded: true }],
      singleChapter: false,
    })),
  };

  (globalThis as any).window = { pomAPI: autoImportApi };

  TestBed.configureTestingModule({
    providers: [
      AutoImportService,
      { provide: ToastService, useValue: toastMock },
      { provide: LocalTxtImportService, useValue: importerMock },
    ],
  });

  return { toastMock, importerMock };
}

describe('AutoImportService', () => {
  let toastMock: any;

  let importerMock: any;
  let svc: AutoImportService;

  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserDynamicTestingModule, platformBrowserDynamicTesting());
  });

  beforeEach(() => {
    const setup = setupTestBed({
      onAutoImport: vi.fn(),
      autoImportFromUrl: vi.fn(async () => ({ fileName: 'test.txt', txtName: 'tmp-1' })),
      autoImportReadText: vi.fn(async () => '第一章\n正文'),
    });
    toastMock = setup.toastMock;
    importerMock = setup.importerMock;
    svc = TestBed.inject(AutoImportService);
  });

  describe('importFromUrl', () => {
    it('non-importable URL 应返回 false 不触发 IPC', async () => {
      const result = await svc.importFromUrl('https://example.com/index.html');
      expect(result).toBe(false);
    });

    it('importable URL 应触发 autoImportFromUrl 并返回 true', async () => {
      // 注意：isImportableUrl 通过扩展名判定（.txt / .zip）
      const result = await svc.importFromUrl('https://example.com/book.txt');
      expect(result).toBe(true);
    });

    it('autoImportFromUrl 抛错时应 toast.error + 仍返回 true（受理后阻止导航）', async () => {
      (globalThis as any).window = {
        pomAPI: {
          onAutoImport: vi.fn(),
          autoImportFromUrl: vi.fn(async () => {
            throw new Error('IPC failed');
          }),
        },
      };
      TestBed.resetTestingModule();
      setupTestBed((globalThis as any).window.pomAPI);

      const fresh: any = TestBed.inject(AutoImportService);
      const result = await fresh.importFromUrl('https://example.com/book.txt');
      expect(result).toBe(true);
    });
  });

  describe('onDetected（constructor 注册的回调）', () => {
    // 取当前 beforeEach 创建的最新 service 对应的 callback

    function getCallback(): (p: unknown) => Promise<void> {
      const calls = ((globalThis as any).window.pomAPI.onAutoImport as any).mock.calls;
      return calls[calls.length - 1][0] as (p: unknown) => Promise<void>;
    }

    it('payload 带 error 时应 toast.error', () => {
      getCallback()({ fileName: 'a.txt', error: 'decode failed' });
      expect(toastMock.error).toHaveBeenCalled();
    });

    it('payload 缺 txtName 时应 toast.error', () => {
      getCallback()({ fileName: 'a.txt' });
      expect(toastMock.error).toHaveBeenCalled();
    });

    it('shelf 已存在同名书时应 toast.info + 跳过', async () => {
      importerMock.hasBook.mockReturnValueOnce(true);
      await getCallback()({ fileName: '天龙八部.txt', txtName: 'tmp-1' });
      expect(toastMock.info).toHaveBeenCalledWith(expect.stringContaining('天龙八部'));
      expect(importerMock.importText).not.toHaveBeenCalled();
    });

    it('happy path 应调 importText + toast.success', async () => {
      // callback 走 fire-and-forget（void this.onDetected(p)）—— 需等 microtask 完成
      getCallback()({ fileName: 'new.txt', txtName: 'tmp-2' });
      // 等待 onDetected 异步链（autoImportReadText + importText + toast.success）
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(importerMock.importText).toHaveBeenCalledWith(
        'new.txt',
        '第一章\n正文',
        'auto-import',
      );
      expect(toastMock.success).toHaveBeenCalled();
    });
  });
});
