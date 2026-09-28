import { describe, it, expect, beforeEach, vi, beforeAll } from 'vitest';
import 'zone.js';
import { TestBed } from '@angular/core/testing';
import {
  BrowserDynamicTestingModule,
  platformBrowserDynamicTesting,
} from '@angular/platform-browser-dynamic/testing';
import { LegadoImportService, deriveFileName } from './legado-import.service';
import { ToastService } from '../../services/toast.service';
import { LegadoSource } from './legado-types';

/**
 * LegadoImportService spec — Legado 订阅源导入编排
 *
 * 覆盖：
 * - 2 个公开方法 (prepareFromText/prepareFromUrl/persistSelected) 的 IPC 编排契约
 * - deriveFileName slug 规则
 * - IPC 不可用降级行为
 */

function makeLegadoSource(overrides: Partial<LegadoSource> = {}): LegadoSource {
  return {
    bookSourceName: 'Test Source',
    bookSourceUrl: 'https://example.com/',
    bookSourceComment: '',
    customOrder: 0,
    enabled: true,
    enabledExplore: true,
    ...overrides,
  };
}

function setupTestBed(api: { booksourceList?: unknown; booksourceSave?: unknown }): any {
  const toastMock: any = {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
  };

  (globalThis as any).window = { pomAPI: api };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [LegadoImportService, { provide: ToastService, useValue: toastMock }],
  });
  return { svc: TestBed.inject(LegadoImportService), toastMock };
}

describe('LegadoImportService', () => {
  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserDynamicTestingModule, platformBrowserDynamicTesting());
  });

  beforeEach(() => {
    delete (globalThis as any).window;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('prepareFromText', () => {
    const validJson = JSON.stringify([
      {
        bookSourceName: 'Test Source',
        bookSourceUrl: 'https://example.com',
        bookSourceType: 0,
        searchUrl: '/search?key={key}',
        ruleSearch: { bookList: '.result-list li', name: '.title' },
        ruleToc: { chapterList: '.chapter-list a' },
        ruleContent: { content: '#content' },
      },
    ]);

    it('合法订阅 JSON → 生成可写盘的 import item', async () => {
      const { svc } = setupTestBed({ booksourceList: async () => [] });
      const items = await svc.prepareFromText(validJson);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        fileName: 'Test_Source.js',
        isSkeleton: false,
        translateError: null,
        overwritesExisting: false,
      });
      expect(items[0].uuid).toMatch(/^legado-[0-9a-f]{8}$/);
      expect(items[0].translatedJs.length).toBeGreaterThan(0);
      expect(items[0].source.bookSourceName).toBe('Test Source');
    });

    it('booksourceList 含同名文件 → overwritesExisting=true', async () => {
      const { svc } = setupTestBed({
        booksourceList: async () => [{ fileName: 'Test_Source.js' }],
      });
      const items = await svc.prepareFromText(validJson);
      expect(items[0].overwritesExisting).toBe(true);
    });

    it('booksourceList 抛错 → 按无现有源处理（不中断导入）', async () => {
      const { svc } = setupTestBed({
        booksourceList: async () => {
          throw new Error('ipc down');
        },
      });
      const items = await svc.prepareFromText(validJson);
      expect(items).toHaveLength(1);
      expect(items[0].overwritesExisting).toBe(false);
    });

    it('booksourceList 返回 null 时不崩溃', async () => {
      const { svc } = setupTestBed({ booksourceList: async () => null });
      const items = await svc.prepareFromText(validJson);
      expect(items[0].overwritesExisting).toBe(false);
    });

    it('无 booksourceList（浏览器降级）也能生成列表', async () => {
      const { svc } = setupTestBed({});
      const items = await svc.prepareFromText(validJson);
      expect(items).toHaveLength(1);
      expect(items[0].overwritesExisting).toBe(false);
    });

    it('含 jsLib 的源 → 骨架 item（isSkeleton=true + translateError）', async () => {
      const skeletonJson = JSON.stringify([
        {
          bookSourceName: 'JS Source',
          bookSourceUrl: 'https://example.com',
          bookSourceType: 0,
          jsLib: 'console.log(1)',
        },
      ]);
      const { svc } = setupTestBed({});
      const items = await svc.prepareFromText(skeletonJson);
      expect(items[0].isSkeleton).toBe(true);
      expect(items[0].translateError).toContain('jsLib');
      expect(items[0].translatedJs.length).toBeGreaterThan(0);
    });

    it('空 bookSourceName → fileName 兜底 + uuid 用 fileName 派生', async () => {
      const json = JSON.stringify([
        {
          bookSourceName: '',
          bookSourceUrl: 'https://example.com',
          bookSourceType: 0,
          jsLib: 'x',
        },
      ]);
      const { svc } = setupTestBed({});
      const items = await svc.prepareFromText(json);
      expect(items[0].fileName).toBe('legado-imported.js');
      expect(items[0].uuid).toMatch(/^legado-[0-9a-f]{8}$/);
    });

    it('非法文本 → 抛解析错误', async () => {
      const { svc } = setupTestBed({});
      await expect(svc.prepareFromText('not json at all')).rejects.toThrow(/Legado 文本/);
    });
  });

  describe('prepareFromUrl', () => {
    it('fetch 成功 → 解析并生成 items', async () => {
      const json = JSON.stringify([
        {
          bookSourceName: 'Remote Src',
          bookSourceUrl: 'https://r.example.com',
          bookSourceType: 0,
          jsLib: 'x',
        },
      ]);
      const fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => json }));
      vi.stubGlobal('fetch', fetchMock);
      const { svc } = setupTestBed({});
      const items = await svc.prepareFromUrl('https://sub.example.com/legado.json');
      expect(fetchMock).toHaveBeenCalledWith('https://sub.example.com/legado.json', {
        method: 'GET',
      });
      expect(items).toHaveLength(1);
      expect(items[0].fileName).toBe('Remote_Src.js');
    });

    it('HTTP 非 2xx → 抛 订阅源 HTTP <status>', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({ ok: false, status: 404, text: async () => '' })),
      );
      const { svc } = setupTestBed({});
      await expect(svc.prepareFromUrl('https://x.example.com/')).rejects.toThrow('订阅源 HTTP 404');
    });

    it('网络异常 → 抛 拉订阅源失败（含原始错误信息）', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new Error('DNS fail');
        }),
      );
      const { svc } = setupTestBed({});
      await expect(svc.prepareFromUrl('https://x.example.com/')).rejects.toThrow(
        /拉订阅源失败.*DNS fail/,
      );
    });
  });

  describe('persistSelected', () => {
    it('IPC 不可用时应 toast.error + 返回 { written:0, skeletons:0, failed:[] }', async () => {
      const { svc, toastMock } = setupTestBed({});
      const result = await svc.persistSelected([]);
      expect(toastMock.error).toHaveBeenCalledWith(expect.stringContaining('IPC'));
      expect(result).toEqual({ written: 0, skeletons: 0, failed: [] });
    });

    it('IPC 成功应逐项写入 + 累计 written / skeletons', async () => {
      const saveMock = vi.fn(async () => undefined);

      const { svc } = setupTestBed({ booksourceSave: saveMock });
      const items = [
        { fileName: 'a.js', translatedJs: 'js1', isSkeleton: false },
        { fileName: 'b.js', translatedJs: 'js2', isSkeleton: true },
        { fileName: 'c.js', translatedJs: 'js3', isSkeleton: false },
      ];
      const result = await svc.persistSelected(items);
      expect(saveMock).toHaveBeenCalledTimes(3);
      expect(result.written).toBe(3);
      expect(result.skeletons).toBe(1);
      expect(result.failed).toEqual([]);
    });

    it('IPC 抛错应收集到 failed 但继续后续项', async () => {
      const saveMock = vi.fn(async (fileName: string) => {
        if (fileName === 'b.js') throw new Error('disk full');
      });

      const { svc } = setupTestBed({ booksourceSave: saveMock });
      const result = await svc.persistSelected([
        { fileName: 'a.js', translatedJs: 'js1', isSkeleton: false },
        { fileName: 'b.js', translatedJs: 'js2', isSkeleton: false },
        { fileName: 'c.js', translatedJs: 'js3', isSkeleton: false },
      ]);
      expect(result.written).toBe(2);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0]).toMatchObject({ fileName: 'b.js', error: 'disk full' });
    });

    it('error 无 message 时用 String(e) 兜底收集', async () => {
      const saveMock = vi.fn(async () => {
         
        throw 'string failure';
      });
      const { svc } = setupTestBed({ booksourceSave: saveMock });
      const result = await svc.persistSelected([
        { fileName: 'a.js', translatedJs: 'js', isSkeleton: false },
      ]);
      expect(result.written).toBe(0);
      expect(result.failed[0]).toEqual({ fileName: 'a.js', error: 'string failure' });
    });

    it('window 完全不存在（非浏览器环境）时按 IPC 不可用处理', async () => {
      const { svc, toastMock } = setupTestBed({});
      delete (globalThis as any).window;
      const result = await svc.persistSelected([
        { fileName: 'a.js', translatedJs: 'js', isSkeleton: false },
      ]);
      expect(toastMock.error).toHaveBeenCalledWith(expect.stringContaining('IPC'));
      expect(result.written).toBe(0);
    });
  });

  describe('deriveFileName', () => {
    it('基础源名应加 .js 后缀', () => {
      expect(deriveFileName(makeLegadoSource({ bookSourceName: 'My Source' }))).toBe(
        'My_Source.js',
      );
    });

    it('特殊字符应替换为 _ 并折叠连续 _', () => {
      expect(deriveFileName(makeLegadoSource({ bookSourceName: 'a/b\\c:d*e?f' }))).toBe(
        'a_b_c_d_e_f.js',
      );
    });

    it('空字符串 + 源名应 fallback legado-imported', () => {
      expect(deriveFileName(makeLegadoSource({ bookSourceName: '' }))).toBe('legado-imported.js');
    });

    it('只有特殊字符的源名应 fallback legado-imported', () => {
      expect(deriveFileName(makeLegadoSource({ bookSourceName: '///' }))).toBe(
        'legado-imported.js',
      );
    });

    it('超长源名应截断到 80 字符', () => {
      const longName = 'a'.repeat(200);
      const result = deriveFileName(makeLegadoSource({ bookSourceName: longName }));
      expect(result.length).toBeLessThanOrEqual(80 + '.js'.length);
      expect(result.endsWith('.js')).toBe(true);
    });

    it('控制字符应被剥离', () => {
      expect(deriveFileName(makeLegadoSource({ bookSourceName: 'foo\x00bar\x1fbaz' }))).toBe(
        'foo_bar_baz.js',
      );
    });
  });
});
