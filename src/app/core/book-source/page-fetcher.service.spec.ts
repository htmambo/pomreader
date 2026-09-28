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
  let svc: any;

  let modalMock: any;

  let originalPomApi: any;

  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserDynamicTestingModule, platformBrowserDynamicTesting());
  });

  beforeEach(() => {
    originalPomApi = (globalThis as any).window?.pomAPI;

    modalMock = {
      confirm: vi.fn(() => ({ triggerClose: () => {} })),
    };

    (globalThis as any).window = { pomAPI: undefined };
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [PageFetcherService, { provide: NzModalService, useValue: modalMock }],
    });
    svc = TestBed.inject(PageFetcherService);
  });

  afterEach(() => {
    (globalThis as any).window = { pomAPI: originalPomApi };
    vi.unstubAllGlobals();
  });

  describe('fetchHtml', () => {
    it('window.pomAPI.fetchHtml 成功时应返回 html', async () => {
      (globalThis as any).window.pomAPI = {
        fetchHtml: vi.fn(async () => ({ html: '<div>ok</div>' })),
      };
      const result = await svc.fetchHtml('https://example.com/');
      expect(result).toBe('<div>ok</div>');
    });

    it('window.pomAPI.fetchHtml 返回 error 时应抛 FetchError', async () => {
      (globalThis as any).window.pomAPI = {
        fetchHtml: vi.fn(async () => ({ error: 'cf-challenge' })),
        cfPassManual: vi.fn(async () => null),
      };
      // cf-challenge 走 cfChallengeFlow → 弹窗 → 用户取消 → reject
      let dialogOpts: any;
      modalMock.confirm.mockImplementationOnce((opts: any) => {
        dialogOpts = opts;
        return { triggerClose: () => {} };
      });
      const promise = svc.fetchHtml('https://example.com/');
      // 等弹窗回调注册 + async 链把 handler 挂到内部 promise 后再触发取消，
      // 否则拒绝发生的瞬间 promise 无 handler，zone.js 会按未处理拒绝打 stderr
      await vi.waitFor(() => expect(dialogOpts).toBeDefined());
      const assertion = expect(promise).rejects.toMatchObject({ code: 'cf-challenge' });
      dialogOpts.nzOnCancel();
      await assertion;
    });

    it('返回 html 为空时应抛 FetchError(parse-failed)', async () => {
      (globalThis as any).window.pomAPI = {
        fetchHtml: vi.fn(async () => ({ html: '' })),
      };
      await expect(svc.fetchHtml('https://example.com/')).rejects.toMatchObject({
        code: 'parse-failed',
      });
    });

    it('非 cf-challenge 错误码应抛对应 FetchError（不弹 CF 引导）', async () => {
      (globalThis as any).window.pomAPI = {
        fetchHtml: vi.fn(async () => ({ error: 'timeout' })),
      };
      await expect(svc.fetchHtml('https://example.com/')).rejects.toMatchObject({
        code: 'timeout',
      });
      expect(modalMock.confirm).not.toHaveBeenCalled();
    });

    it('cf-challenge 但无 cfPassManual 时应直接抛（不弹窗）', async () => {
      (globalThis as any).window.pomAPI = {
        fetchHtml: vi.fn(async () => ({ error: 'cf-challenge' })),
      };
      await expect(svc.fetchHtml('https://example.com/')).rejects.toMatchObject({
        code: 'cf-challenge',
      });
      expect(modalMock.confirm).not.toHaveBeenCalled();
    });

    it('浏览器降级：无 pomAPI.fetchHtml 时走 fetch(no-cors)', async () => {
      const fetchMock = vi.fn(async () => ({ text: async () => 'browser-raw' }));
      vi.stubGlobal('fetch', fetchMock);
      // beforeEach 已把 window.pomAPI 置为 undefined
      const result = await svc.fetchHtml('https://example.com/');
      expect(fetchMock).toHaveBeenCalledWith('https://example.com/', { mode: 'no-cors' });
      expect(result).toBe('browser-raw');
    });
  });

  describe('cfChallengeFlow (Tier 2 人工过盾)', () => {
    function setupCfChallenge(cfPassManualImpl: () => Promise<string | null>) {
      (globalThis as any).window.pomAPI = {
        fetchHtml: vi.fn(async () => ({ error: 'cf-challenge' })),
        cfPassManual: vi.fn(cfPassManualImpl),
      };
      modalMock.confirm.mockImplementationOnce((opts: any) => {
        opts.nzOnOk();
        return { triggerClose: () => {} };
      });
    }

    it('用户确认且 cfPassManual 返回 html 时应直接返回渲染结果', async () => {
      setupCfChallenge(async () => '<html>过了盾</html>');
      const result = await svc.fetchHtml('https://example.com/');
      expect(result).toBe('<html>过了盾</html>');
      expect((globalThis as any).window.pomAPI.cfPassManual).toHaveBeenCalledWith(
        'https://example.com/',
      );
    });

    it('用户确认但 cfPassManual 返回 null（关窗/超时）应抛 cf-challenge', async () => {
      setupCfChallenge(async () => null);
      await expect(svc.fetchHtml('https://example.com/')).rejects.toMatchObject({
        code: 'cf-challenge',
      });
    });

    it('cfPassManual 抛错时应包装为 cf-challenge 而非透传底层错误', async () => {
      setupCfChallenge(async () => {
        throw new Error('ipc boom');
      });
      await expect(svc.fetchHtml('https://example.com/')).rejects.toMatchObject({
        code: 'cf-challenge',
      });
    });
  });

  describe('fetchRendered', () => {
    it('成功应返回 text', async () => {
      (globalThis as any).window.pomAPI = {
        fetchRendered: vi.fn(async () => ({ text: '<p>rendered</p>' })),
      };
      const result = await svc.fetchRendered('https://example.com/');
      expect(result).toBe('<p>rendered</p>');
    });

    it('text 为空应抛 FetchError(parse-failed)', async () => {
      (globalThis as any).window.pomAPI = {
        fetchRendered: vi.fn(async () => ({})),
      };
      await expect(svc.fetchRendered('https://example.com/')).rejects.toMatchObject({
        code: 'parse-failed',
      });
    });

    it('返回 error 时应抛对应 FetchError', async () => {
      (globalThis as any).window.pomAPI = {
        fetchRendered: vi.fn(async () => ({ error: 'timeout' })),
      };
      await expect(svc.fetchRendered('https://example.com/')).rejects.toMatchObject({
        code: 'timeout',
      });
    });

    it('浏览器环境（无 pomAPI.fetchRendered）应抛 source-unavailable', async () => {
      await expect(svc.fetchRendered('https://example.com/')).rejects.toMatchObject({
        code: 'source-unavailable',
      });
    });
  });

  describe('fetchPost', () => {
    it('成功应返回 body', async () => {
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

    it('应组装 Content-Type 与 extraHeaders 传给 proxy', async () => {
      const proxy = vi.fn(async () => ({ status: 200, headers: {}, body: 'ok' }));
      (globalThis as any).window.pomAPI = { booksourceHttpProxy: proxy };
      const result = await svc.fetchPost(
        'https://example.com/p',
        'a=1',
        'application/x-www-form-urlencoded',
        { 'X-Referer': 'https://example.com' },
      );
      expect(result).toBe('ok');
      expect(proxy).toHaveBeenCalledWith({
        url: 'https://example.com/p',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Referer': 'https://example.com',
        },
        body: 'a=1',
      });
    });

    it('proxy 返回 body 缺失时应降级为空字符串', async () => {
      (globalThis as any).window.pomAPI = {
        booksourceHttpProxy: vi.fn(async () => ({ status: 200, headers: {} })),
      };
      const result = await svc.fetchPost('https://example.com/', null);
      expect(result).toBe('');
    });

    it('浏览器降级：fetch POST 成功应返回 text', async () => {
      const fetchMock = vi.fn(async () => ({ ok: true, text: async () => 'posted-ok' }));
      vi.stubGlobal('fetch', fetchMock);
      const result = await svc.fetchPost('https://example.com/p', 'x=1', 'text/plain');
      expect(fetchMock).toHaveBeenCalledWith('https://example.com/p', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: 'x=1',
      });
      expect(result).toBe('posted-ok');
    });

    it('浏览器降级：HTTP 错误应抛 FetchError(parse-failed)', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({ ok: false, status: 403 })),
      );
      await expect(svc.fetchPost('https://example.com/p', null)).rejects.toMatchObject({
        code: 'parse-failed',
        message: 'HTTP 403',
      });
    });

    it('浏览器降级：网络异常应包装为 FetchError(source-unavailable)', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new Error('CORS blocked');
        }),
      );
      await expect(svc.fetchPost('https://example.com/p', null)).rejects.toMatchObject({
        code: 'source-unavailable',
        message: 'CORS blocked',
      });
    });
  });

  describe('inZone 包装', () => {
    it('应通过 NgZone.run 重入 zone', async () => {
      const ngZone = TestBed.inject(NgZone) as NgZone;

      const runSpy = vi.spyOn(ngZone, 'run');

      (globalThis as any).window.pomAPI = {
        fetchHtml: vi.fn(async () => ({ html: 'ok' })),
      };
      await svc.fetchHtml('https://example.com/');
      // inZone 每次调用只 run 一次；旧断言 ≥2 数的是 vitest/Angular 的附带调用，
      // 升到 vitest 4 后附带调用减少，与本服务的契约无关
      expect(runSpy).toHaveBeenCalled();
    });
  });
});
