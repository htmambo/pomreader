import { describe, it, expect, beforeEach, vi, beforeAll } from 'vitest';
import 'zone.js';
import { TestBed } from '@angular/core/testing';
import {
  BrowserDynamicTestingModule,
  platformBrowserDynamicTesting,
} from '@angular/platform-browser-dynamic/testing';
import { NzModalService } from 'ng-zorro-antd/modal';
import { CfPromptService } from './cf-prompt.service';
import { ToastService } from './toast.service';

/**
 * CfPromptService spec — CF Tier 2 人工过盾引导（JSON 规则书源链路）
 *
 * P4 起唯一链路：RuleEngineService 直调 public prompt()（方案 §3.2 配套 c）；
 * 沙箱时代的 SandboxService.cfChallengeHook 注册用例已随钩子一并删除，
 * 以下用例全部改为直接调 svc.prompt(url) 验证行为。
 *
 * 关键契约：
 * - 同一 host 一次会话最多弹一次（promptedHosts Set 防弹窗轰炸）
 * - cfManual 主进程 IPC 缺失时静默
 * - URL 解析失败时静默
 * - 用户取消/关窗 → 保留 host（不重弹）
 * - 验证成功 → 移除 host + toast.success
 * - 验证失败/超时 → toast.warn
 */

function setupTestBed(cfManual?: (url: string) => Promise<string | null>): any {
  const toastMock: any = {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
  };
  // modal.confirm 返回一个 nzOnOk 调用器（直接 invoke）+ 记录 nzOnCancel

  const modalMock: any = {
    confirm: vi.fn((opts: any) => {
      const captured: any = opts;

      (modalMock as any).lastOpts = captured;
      return { triggerClose: () => {} };
    }),
  };

  (globalThis as any).window = {
    pomAPI: cfManual ? { cfPassManual: vi.fn(cfManual) } : {},
  };

  TestBed.configureTestingModule({
    providers: [
      CfPromptService,
      { provide: ToastService, useValue: toastMock },
      { provide: NzModalService, useValue: modalMock },
    ],
  });

  return { svc: TestBed.inject(CfPromptService), toastMock, modalMock };
}

describe('CfPromptService', () => {
  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserDynamicTestingModule, platformBrowserDynamicTesting());
  });

  beforeEach(() => {
    delete (globalThis as any).window;
  });

  describe('promptedHosts 去重', () => {
    it('同一 host 应只弹一次（promptedHosts 防弹窗轰炸）', () => {
      const { svc, modalMock } = setupTestBed(async () => null);
      svc.prompt('https://example.com/page1');
      svc.prompt('https://example.com/page2');
      svc.prompt('https://example.com/page3');

      expect(modalMock.confirm).toHaveBeenCalledTimes(1);
    });

    it('不同 host 应分别弹一次', () => {
      const { svc, modalMock } = setupTestBed(async () => null);
      svc.prompt('https://a.com/page');
      svc.prompt('https://b.com/page');

      expect(modalMock.confirm).toHaveBeenCalledTimes(2);
    });
  });

  describe('URL / IPC 缺失静默', () => {
    it('window.pomAPI.cfPassManual 缺失时应静默不弹窗', () => {
      const { svc, modalMock } = setupTestBed(undefined);
      svc.prompt('https://example.com/');

      expect(modalMock.confirm).not.toHaveBeenCalled();
    });

    it('URL 解析失败时应静默不弹窗', () => {
      const { svc, modalMock } = setupTestBed(async () => null);
      svc.prompt('not-a-valid-url');

      expect(modalMock.confirm).not.toHaveBeenCalled();
    });
  });

  describe('验证结果分支', () => {
    it('验证成功（cfManual 返回 html）应 toast.success 并允许再次弹同 host', async () => {
      const { svc, toastMock, modalMock } = setupTestBed(async () => '<html>ok</html>');
      svc.prompt('https://example.com/');

      await (modalMock as any).lastOpts.nzOnOk();
      expect(toastMock.success).toHaveBeenCalledWith(expect.stringContaining('example.com'));
    });

    it('验证失败（cfManual 返回 null）应 toast.warn 且保留 promptedHosts', async () => {
      const { svc, toastMock, modalMock } = setupTestBed(async () => null);
      svc.prompt('https://example.com/');

      await (modalMock as any).lastOpts.nzOnOk();
      expect(toastMock.warn).toHaveBeenCalled();
      // 再次触发同 host 应不弹（仍 prompted）

      const callCountBefore = (modalMock.confirm as any).mock.calls.length;
      svc.prompt('https://example.com/page2');

      expect((modalMock.confirm as any).mock.calls.length).toBe(callCountBefore);
    });

    it('cfManual 抛错应静默 catch', async () => {
      const { svc, toastMock, modalMock } = setupTestBed(async () => {
        throw new Error('boom');
      });
      svc.prompt('https://example.com/');

      await expect((modalMock as any).lastOpts.nzOnOk()).resolves.toBeUndefined();
      expect(toastMock.warn).not.toHaveBeenCalled();
      expect(toastMock.success).not.toHaveBeenCalled();
    });
  });
});
