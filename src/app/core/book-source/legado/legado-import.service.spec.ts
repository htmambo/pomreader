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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function setupTestBed(api: { booksourceList?: unknown; booksourceSave?: unknown }): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const toastMock: any = {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).window = { pomAPI: api };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      LegadoImportService,
      { provide: ToastService, useValue: toastMock },
    ],
  });
  return { svc: TestBed.inject(LegadoImportService), toastMock };
}

describe('LegadoImportService', () => {
  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserDynamicTestingModule, platformBrowserDynamicTesting());
  });

  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).window;
  });

  describe('persistSelected', () => {
    it('IPC 不可用时应 toast.error + 返回 { written:0, skeletons:0, failed:[] }', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { svc, toastMock } = setupTestBed({});
      const result = await svc.persistSelected([]);
      expect(toastMock.error).toHaveBeenCalledWith(expect.stringContaining('IPC'));
      expect(result).toEqual({ written: 0, skeletons: 0, failed: [] });
    });

    it('IPC 成功应逐项写入 + 累计 written / skeletons', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const saveMock = vi.fn(async () => undefined);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const saveMock = vi.fn(async (fileName: string) => {
        if (fileName === 'b.js') throw new Error('disk full');
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
  });

  describe('deriveFileName', () => {
    it('基础源名应加 .js 后缀', () => {
      expect(deriveFileName(makeLegadoSource({ bookSourceName: 'My Source' }))).toBe(
        'My_Source.js',
      );
    });

    it('特殊字符应替换为 _ 并折叠连续 _', () => {
      expect(
        deriveFileName(makeLegadoSource({ bookSourceName: 'a/b\\c:d*e?f' })),
      ).toBe('a_b_c_d_e_f.js');
    });

    it('空字符串 + 源名应 fallback legado-imported', () => {
      expect(deriveFileName(makeLegadoSource({ bookSourceName: '' }))).toBe(
        'legado-imported.js',
      );
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
      expect(
        deriveFileName(makeLegadoSource({ bookSourceName: 'foo\x00bar\x1fbaz' })),
      ).toBe('foo_bar_baz.js');
    });
  });
});