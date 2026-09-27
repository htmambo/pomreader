import { describe, it, expect, beforeEach, vi, beforeAll } from 'vitest';
import 'zone.js';
import { TestBed } from '@angular/core/testing';
import {
  BrowserDynamicTestingModule,
  platformBrowserDynamicTesting,
} from '@angular/platform-browser-dynamic/testing';
import { NgZone } from '@angular/core';
import { NzModalService } from 'ng-zorro-antd/modal';
import { PageFetcherService } from './page-fetcher.service';

/**
 * PageFetcherService spec — IPC 抓取 + Zone.js 重入 + CF 挑战
 *
 * 关键契约：
 * - fetchHtml 走 window.pomAPI.fetchHtml
 * - inZone 包装 promise → NgZone.run 重入
 * - cf-challenge 错误码 → 走 cfChallengeFlow（二次引导）
 * - fetchPost 走 booksourceHttpProxy
 * - 浏览器降级：fetchHtml 用 fetch no-cors / fetchRendered 抛 source-unavailable
 */

describe('PageFetcherService', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let svc: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let modalMock: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let originalPomApi: any;

  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserDynamicTestingModule, platformBrowserDynamicTesting());
  });

  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    originalPomApi = (globalThis as any).window?.pomAPI;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    modalMock = {
      confirm: vi.fn(() => ({ triggerClose: () => {} })),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).window = { pomAPI: undefined };
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        PageFetcherService,
        { provide: NzModalService, useValue: modalMock },
      ],
    });
    svc = TestBed.inject(PageFetcherService);
  });

  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).window = { pomAPI: originalPomApi };
  });

  describe('fetchHtml', () => {
    it('window.pomAPI.fetchHtml 成功时应返回 html', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).window.pomAPI = {
        fetchHtml: vi.fn(async () => ({ html: '<div>ok</div>' })),
      };
      const result = await svc.fetchHtml('https://example.com/');
      expect(result).toBe('<div>ok</div>');
    });

    it('window.pomAPI.fetchHtml 返回 error 时应抛 FetchError', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).window.pomAPI = {
        fetchHtml: vi.fn(async () => ({ error: 'cf-challenge' })),
      };
      // cf-challenge 走 cfChallengeFlow → 弹窗 → 用户取消 → reject
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      modalMock.confirm.mockImplementationOnce((opts: any) => {
        opts.nzOnCancel();
        return { triggerClose: () => {} };
      });
      await expect(svc.fetchHtml('https://example.com/')).rejects.toMatchObject({
        code: 'cf-challenge',
      });
    });

    it('返回 html 为空时应抛 FetchError(parse-failed)', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).window.pomAPI = {
        fetchHtml: vi.fn(async () => ({ html: '' })),
      };
      await expect(svc.fetchHtml('https://example.com/')).rejects.toMatchObject({
        code: 'parse-failed',
      });
    });
  });

  describe('fetchRendered', () => {
    it('成功应返回 text', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).window.pomAPI = {
        fetchRendered: vi.fn(async () => ({ text: '<p>rendered</p>' })),
      };
      const result = await svc.fetchRendered('https://example.com/');
      expect(result).toBe('<p>rendered</p>');
    });

    it('text 为空应抛 FetchError(parse-failed)', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).window.pomAPI = {
        fetchRendered: vi.fn(async () => ({})),
      };
      await expect(svc.fetchRendered('https://example.com/')).rejects.toMatchObject({
        code: 'parse-failed',
      });
    });
  });

  describe('fetchPost', () => {
    it('成功应返回 body', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).window.pomAPI = {
        booksourceHttpProxy: vi.fn(async () => ({
          status: 200,
          headers: {},
          body: '<html>posted</html>',
        })),
      };
      const result = await svc.fetchPost('https://example.com/', 'a=1');
      expect(result).toBe('<html>posted</html>');
    });

    it('HTTP 4xx/5xx 应抛 FetchError(parse-failed)', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).window.pomAPI = {
        booksourceHttpProxy: vi.fn(async () => ({
          status: 500,
          headers: {},
          body: '',
        })),
      };
      await expect(svc.fetchPost('https://example.com/', null)).rejects.toMatchObject({
        code: 'parse-failed',
      });
    });

    it('cfChallenge 标记应抛 FetchError(cf-challenge)', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).window.pomAPI = {
        booksourceHttpProxy: vi.fn(async () => ({
          status: 200,
          headers: {},
          body: '',
          cfChallenge: true,
        })),
      };
      await expect(svc.fetchPost('https://example.com/', null)).rejects.toMatchObject({
        code: 'cf-challenge',
      });
    });
  });

  describe('inZone 包装', () => {
    it('应通过 NgZone.run 重入 zone', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ngZone = TestBed.inject(NgZone) as NgZone;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const runSpy = vi.spyOn(ngZone, 'run');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).window.pomAPI = {
        fetchHtml: vi.fn(async () => ({ html: 'ok' })),
      };
      await svc.fetchHtml('https://example.com/');
      // 至少 2 次 run（成功 + 完成）—— 实测 4 次（resolve + reject 双 callback）
      expect(runSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });
});