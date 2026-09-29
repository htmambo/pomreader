import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import 'zone.js';
import { TestBed } from '@angular/core/testing';
import {
  BrowserDynamicTestingModule,
  platformBrowserDynamicTesting,
} from '@angular/platform-browser-dynamic/testing';
import { NZ_MODAL_DATA, NzModalRef } from 'ng-zorro-antd/modal';
import {
  LegacyConvertTryComponent,
  type LegacyConvertTryResult,
} from './legacy-convert-try.component';
import { ToastService } from '../../core/services/toast.service';

/**
 * LegacyConvertTryComponent spec — legacy .js「尝试转换」弹窗
 *
 * 契约：
 *  - needs-manual → 展示详细原因（validation 为 null，无保存入口）
 *  - ok/skeleton → 渲染端 valibot BookSourceDocSchema 全量验证：通过才可保存
 *  - 保存成功 → booksourceSaveJson(jsonFileName, doc) + modalRef.close('saved')
 *  - IPC 不可用 / 调用抛错 → 按 needs-manual 展示原因
 *
 * 实现说明：比照 import-book-source-bundle.component.spec.ts 的
 * runInInjectionContext 直实例化风格，验证驱动渲染的 result/validation/docJson。
 */

function makeValidDoc(): Record<string, unknown> {
  return {
    format: 'pomreader.booksource',
    schemaVersion: 1,
    uuid: 'sample.js',
    name: '样本站',
    homepage: 'https://sample.invalid',
    urls: ['https://sample.invalid'],
    enabled: true,
    sourceType: 'novel',
    tags: [],
    minDelayMs: 0,
    requireUrls: [],
    headers: {},
    rules: {
      siteName: '样本站',
      searchPath: '/search?keyword={keyword}',
      searchItemPattern: 'css:dl dd',
      bookTitlePattern: 'css:h1',
      bookAuthorPattern: 'css:.author',
      chapterItemPattern: 'css:#list a',
      contentPattern: 'css:#content',
    },
  };
}

function makeResult(overrides: Partial<LegacyConvertTryResult> = {}): LegacyConvertTryResult {
  return {
    outcome: 'ok',
    uuid: 'sample.js',
    jsonFileName: 'sample.json',
    doc: makeValidDoc(),
    ...overrides,
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe('LegacyConvertTryComponent', () => {
  let modalRef: { close: ReturnType<typeof vi.fn> };
  let convertTry: ReturnType<typeof vi.fn>;
  let saveJson: ReturnType<typeof vi.fn>;

  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserDynamicTestingModule, platformBrowserDynamicTesting());
  });

  beforeEach(() => {
    modalRef = { close: vi.fn() };
    convertTry = vi.fn();
    saveJson = vi.fn();
    (window as unknown as { pomAPI: unknown }).pomAPI = {
      booksourceLegacyConvertTry: convertTry,
      booksourceSaveJson: saveJson,
    };
    TestBed.configureTestingModule({
      providers: [
        { provide: NZ_MODAL_DATA, useValue: { fileName: 'sample.js', existingJson: false } },
        { provide: NzModalRef, useValue: modalRef },
        { provide: ToastService, useValue: { success: vi.fn(), error: vi.fn() } },
      ],
    });
  });

  function create(): LegacyConvertTryComponent {
    return TestBed.runInInjectionContext(() => new LegacyConvertTryComponent());
  }

  it('needs-manual：展示详细原因，validation 为 null（无保存入口）', async () => {
    convertTry.mockResolvedValue(
      makeResult({
        outcome: 'needs-manual',
        doc: undefined,
        reason: '必填规则缺失或为空: contentPattern（CONTENT_RULE 常量）',
      }),
    );
    const c = create();
    await settle();
    expect(c.loading()).toBe(false);
    expect(c.result()?.outcome).toBe('needs-manual');
    expect(c.result()?.reason).toContain('CONTENT_RULE 常量');
    expect(c.validation()).toBeNull();
  });

  it('ok + 合法 doc：validation 通过，docJson 为格式化 JSON', async () => {
    convertTry.mockResolvedValue(makeResult());
    const c = create();
    await settle();
    expect(c.result()?.outcome).toBe('ok');
    expect(c.validation()).toEqual({ ok: true, issues: [] });
    expect(c.docJson()).toContain('"uuid": "sample.js"');
  });

  it('ok + 非法 doc：validation 不通过且列出 issues（保存被禁用）', async () => {
    const bad = makeValidDoc();
    delete bad.name;
    convertTry.mockResolvedValue(makeResult({ doc: bad }));
    const c = create();
    await settle();
    const check = c.validation();
    expect(check?.ok).toBe(false);
    expect(check?.issues.length).toBeGreaterThan(0);
    expect(check?.issues.join(';')).toContain('name');
    await c.save();
    expect(saveJson).not.toHaveBeenCalled();
    expect(modalRef.close).not.toHaveBeenCalled();
  });

  it('保存成功：调 booksourceSaveJson(jsonFileName, doc) 并以 saved 关窗', async () => {
    convertTry.mockResolvedValue(makeResult());
    saveJson.mockResolvedValue(undefined);
    const c = create();
    await settle();
    await c.save();
    expect(saveJson).toHaveBeenCalledWith(
      'sample.json',
      expect.objectContaining({ uuid: 'sample.js' }),
    );
    expect(modalRef.close).toHaveBeenCalledWith('saved');
  });

  it('IPC 不可用 / 调用抛错：按 needs-manual 展示原因', async () => {
    (window as unknown as { pomAPI: unknown }).pomAPI = {};
    const c1 = create();
    await settle();
    expect(c1.result()?.reason).toBe('IPC 不可用');

    (window as unknown as { pomAPI: unknown }).pomAPI = {
      booksourceLegacyConvertTry: convertTry,
      booksourceSaveJson: saveJson,
    };
    convertTry.mockRejectedValue(new Error('channel boom'));
    const c2 = create();
    await settle();
    expect(c2.result()?.outcome).toBe('needs-manual');
    expect(c2.result()?.reason).toContain('channel boom');
  });
});
