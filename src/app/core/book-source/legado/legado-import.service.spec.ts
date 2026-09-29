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
import { buildSourceDoc, serializeSourceDoc } from '../../logic/source-doc-build';

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

/**
 * 一份**过得了 schema** 的文档文本。
 *
 * `persistSelected` 现在有落盘前的 schema 门（外部评审 R1），所以这些用例不能再用
 * `'js1'` 这种占位串 —— 那样测的是"占位串被门拦下"，不是"逐项写入"。
 */
function validDocText(name = '示例'): string {
  return serializeSourceDoc(
    buildSourceDoc({
      uuid: `u-${name}`,
      name,
      homepage: 'https://example.com',
      rules: {
        siteName: '示例站点',
        searchPath: '/s?q={keyword}',
        searchItemPattern: 'ul.list li',
        bookTitlePattern: 'h1',
        bookAuthorPattern: 'css:.author',
        chapterItemPattern: 'ul.c a',
        contentPattern: 'div#content',
      },
    }),
  );
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

/** 一份最小的合法 legado 订阅文本（提到模块级：多个 describe 都要用） */
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
    it('合法订阅 JSON → 生成可写盘的 import item', async () => {
      const { svc } = setupTestBed({ booksourceList: async () => [] });
      const items = await svc.prepareFromText(validJson);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        fileName: 'Test_Source.json',
        isSkeleton: false,
        translateError: null,
        overwritesExisting: false,
      });
      expect(items[0].uuid).toMatch(/^legado-[0-9a-f]{8}$/);
      expect(items[0].translatedJson.length).toBeGreaterThan(0);
      expect(items[0].source.bookSourceName).toBe('Test Source');
    });

    it('booksourceList 含同名文件 → overwritesExisting=true', async () => {
      const { svc } = setupTestBed({
        booksourceList: async () => [{ fileName: 'Test_Source.json' }],
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
      expect(items[0].translatedJson.length).toBeGreaterThan(0);
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
      expect(items[0].fileName).toBe('legado-imported.json');
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
      expect(items[0].fileName).toBe('Remote_Src.json');
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
        { fileName: 'a.json', translatedJson: validDocText('A'), isSkeleton: false },
        { fileName: 'b.json', translatedJson: validDocText('B'), isSkeleton: true },
        { fileName: 'c.json', translatedJson: validDocText('C'), isSkeleton: false },
      ];
      const result = await svc.persistSelected(items);
      expect(saveMock).toHaveBeenCalledTimes(3);
      expect(result.written).toBe(3);
      expect(result.skeletons).toBe(1);
      expect(result.failed).toEqual([]);
    });

    it('IPC 抛错应收集到 failed 但继续后续项', async () => {
      const saveMock = vi.fn(async (fileName: string) => {
        if (fileName === 'b.json') throw new Error('disk full');
      });

      const { svc } = setupTestBed({ booksourceSave: saveMock });
      const result = await svc.persistSelected([
        { fileName: 'a.json', translatedJson: validDocText('A'), isSkeleton: false },
        { fileName: 'b.json', translatedJson: validDocText('B'), isSkeleton: false },
        { fileName: 'c.json', translatedJson: validDocText('C'), isSkeleton: false },
      ]);
      expect(result.written).toBe(2);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0]).toMatchObject({ fileName: 'b.json', error: 'disk full' });
    });

    it('error 无 message 时用 String(e) 兜底收集', async () => {
      const saveMock = vi.fn(async () => {
        throw 'string failure';
      });
      const { svc } = setupTestBed({ booksourceSave: saveMock });
      const result = await svc.persistSelected([
        { fileName: 'a.json', translatedJson: validDocText('S'), isSkeleton: false },
      ]);
      expect(result.written).toBe(0);
      expect(result.failed[0]).toEqual({ fileName: 'a.json', error: 'string failure' });
    });

    it('window 完全不存在（非浏览器环境）时按 IPC 不可用处理', async () => {
      const { svc, toastMock } = setupTestBed({});
      delete (globalThis as any).window;
      const result = await svc.persistSelected([
        { fileName: 'a.json', translatedJson: validDocText('S'), isSkeleton: false },
      ]);
      expect(toastMock.error).toHaveBeenCalledWith(expect.stringContaining('IPC'));
      expect(result.written).toBe(0);
    });
  });

  describe('deriveFileName', () => {
    it('基础源名应加 .json 后缀', () => {
      expect(deriveFileName(makeLegadoSource({ bookSourceName: 'My Source' }))).toBe(
        'My_Source.json',
      );
    });

    it('特殊字符应替换为 _ 并折叠连续 _', () => {
      expect(deriveFileName(makeLegadoSource({ bookSourceName: 'a/b\\c:d*e?f' }))).toBe(
        'a_b_c_d_e_f.json',
      );
    });

    it('空字符串 + 源名应 fallback legado-imported', () => {
      expect(deriveFileName(makeLegadoSource({ bookSourceName: '' }))).toBe('legado-imported.json');
    });

    it('只有特殊字符的源名应 fallback legado-imported', () => {
      expect(deriveFileName(makeLegadoSource({ bookSourceName: '///' }))).toBe(
        'legado-imported.json',
      );
    });

    it('超长源名应截断到 80 字符', () => {
      const longName = 'a'.repeat(200);
      const result = deriveFileName(makeLegadoSource({ bookSourceName: longName }));
      expect(result.length).toBeLessThanOrEqual(80 + '.json'.length);
      expect(result.endsWith('.json')).toBe(true);
    });

    it('控制字符应被剥离', () => {
      expect(deriveFileName(makeLegadoSource({ bookSourceName: 'foo\x00bar\x1fbaz' }))).toBe(
        'foo_bar_baz.json',
      );
    });
  });
});

describe('落盘前的两道门（外部评审 R1）', () => {
  it('uuid 取**文档里那个**，不二次派生（书源名缺失时两者本会不同）', async () => {
    const { svc } = setupTestBed({ booksourceList: async () => [] });
    const items = await svc.prepareFromText(validJson);
    const doc = JSON.parse(items[0].translatedJson);
    expect(items[0].uuid).toBe(doc.uuid);
  });

  it('uuid 与文件内容在书源名缺失的边界上仍一致', async () => {
    const { svc } = setupTestBed({ booksourceList: async () => [] });
    const noName = JSON.stringify({
      sources: [{ bookSourceUrl: 'https://x.test', ruleToc: { chapterList: '.c a' } }],
    });
    const items = await svc.prepareFromText(noName);
    expect(items[0].uuid).toBe(JSON.parse(items[0].translatedJson).uuid);
  });

  it('规则非法的项**不落盘**，进 failed 且带可读原因', async () => {
    const save = vi.fn(async () => {});
    const { svc } = setupTestBed({ booksourceList: async () => [], booksourceSave: save });
    const items = await svc.prepareFromText(validJson);
    // 模拟"翻译结果被外部改坏"（例如未来的转换缺陷）
    items[0].translatedJson = JSON.stringify({ format: 'pomreader.booksource' });
    const result = await svc.persistSelected(items);
    expect(save).not.toHaveBeenCalled();
    expect(result.written).toBe(0);
    expect(result.failed[0].error).toMatch(/规则非法/);
  });

  it('非 JSON 文本同样被拦（不落盘）', async () => {
    const save = vi.fn(async () => {});
    const { svc } = setupTestBed({ booksourceList: async () => [], booksourceSave: save });
    const items = await svc.prepareFromText(validJson);
    items[0].translatedJson = '{ broken';
    const result = await svc.persistSelected(items);
    expect(save).not.toHaveBeenCalled();
    expect(result.failed).toHaveLength(1);
  });

  it('合法项照常落盘（门不会误杀）', async () => {
    const save = vi.fn(async () => {});
    const { svc } = setupTestBed({ booksourceList: async () => [], booksourceSave: save });
    const items = await svc.prepareFromText(validJson);
    const result = await svc.persistSelected(items);
    expect(save).toHaveBeenCalledTimes(1);
    expect(result.written).toBe(1);
    expect(result.failed).toEqual([]);
  });
});
