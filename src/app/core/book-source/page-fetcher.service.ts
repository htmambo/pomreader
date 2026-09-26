import { Injectable, NgZone, inject } from '@angular/core';
import { NzModalService } from 'ng-zorro-antd/modal';
import { PageFetcher } from './book-source.adapter';
import { FetchError } from './fetch-error';

declare global {
  interface Window {
    pomAPI?: {
      fetchHtml: (
        url: string,
        encoding?: 'auto' | 'utf-8' | 'gbk'
      ) => Promise<{ html?: string; error?: string }>;
      fetchRendered: (url: string) => Promise<{ text?: string; error?: string }>;
      /** Cloudflare Tier 2 人工过盾（弹可见窗口；返回渲染后的 HTML，null = 用户关窗/超时） */
      cfPassManual?: (url: string) => Promise<string | null>;
      /** 抓取 UA 设置（设置页用） */
      getFetchUA?: () => Promise<{ ua: string; defaultUa: string }>;
      setFetchUA?: (ua: string | null) => Promise<{ ua: string }>;
      openExternal: (url: string) => Promise<void>;
      /**
       * 书源 HTTP 代理（T-002 sandbox.service.ts 用）
       * 完整类型定义在 sandbox.service.ts 的同源声明中（page-fetcher.ts 跨文件引用）
       */
      booksourceHttpProxy?: (req: {
        url: string;
        method?: string;
        headers?: Record<string, string>;
        body?: string | null;
      }) => Promise<{ status: number; headers: Record<string, string>; body: string; cfChallenge?: boolean }>;
      /** 书源文件读取（T-004 js-source.adapter.ts 用） */
      booksourceRead?: (fileName: string, sourceDir?: string) => Promise<string>;
      /** 书源列表（T-004 registry 用） */
      booksourceList?: () => Promise<Array<{
        fileName: string;
        name: string;
        url: string;
        enabled: boolean;
        sourceDir?: string;
        [key: string]: unknown;
      }>>;
      /** 封面缓存 IPC（T-008 CoverService 用） */
      coverResolveCache?: (req: { url: string; referer?: string; headers?: Record<string, string> }) => Promise<{
        localPath: string;
        localRef: string;
      }>;
      coverCacheSize?: () => Promise<number>;
      coverCacheClear?: () => Promise<number>;
    };
  }
}

/**
 * PageFetcher 实现 — 渲染进程通过 preload contextBridge 调主进程 net.request（绕 CORS）。
 * 浏览器环境（ng serve）降级为 fetch（受 CORS 限制，书站基本失败，仅占位保 UI 不崩）。
 */
@Injectable({ providedIn: 'root' })
export class PageFetcherService implements PageFetcher {
  private readonly zone = inject(NgZone);
  private readonly modal = inject(NzModalService);

  /**
   * Electron contextBridge 的 IPC Promise 在 NgZone 外 resolve（Zone.js 捕获不到），
   * 调用方 await 之后的代码不触发变更检测（loading 卡死）——统一在本服务内重新进入 zone。
   */
  private inZone<T>(p: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) =>
      p.then(
        (v) => this.zone.run(() => resolve(v)),
        (e: unknown) => this.zone.run(() => reject(e))
      )
    );
  }

  async fetchHtml(
    url: string,
    encoding: 'auto' | 'utf-8' | 'gbk' = 'auto'
  ): Promise<string> {
    if (window.pomAPI?.fetchHtml) {
      const res = await this.inZone(window.pomAPI.fetchHtml(url, encoding));
      // Tier 1 自动过盾仍失败 → Tier 2：询问用户手动完成 CF 验证后重试一次
      if (res.error === 'cf-challenge' && window.pomAPI.cfPassManual) {
        return this.cfChallengeFlow(url, encoding);
      }
      if (res.error) throw new FetchError(res.error as FetchError['code']);
      if (!res.html) throw new FetchError('parse-failed');
      return res.html;
    }
    // 浏览器降级
    const r = await fetch(url, { mode: 'no-cors' });
    return await r.text();
  }

  /** CF 挑战：弹确认框 → 打开人工验证窗口 → 提取的渲染 HTML 直接返回；
   * 取消/用户关窗/超时 → 抛 cf-challenge */
  private cfChallengeFlow(
    url: string,
    encoding: 'auto' | 'utf-8' | 'gbk'
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const fail = (): void => reject(new FetchError('cf-challenge'));
      this.modal.confirm({
        nzTitle: 'Cloudflare 人机验证',
        nzContent: '该站点启用了 Cloudflare 人机验证，是否打开验证窗口？完成后将自动重试。',
        nzOkText: '打开验证',
        nzCancelText: '取消',
        nzOnOk: async () => {
          // nzOnOk 内不向外抛错（reject 会让 modal 悬停不关），统一 try-catch 后 fail()
          try {
            const api = window.pomAPI!;
            const html = await this.inZone(api.cfPassManual!(url));
            if (!html) { fail(); return; }
            resolve(html);
          } catch {
            fail();
          }
        },
        nzOnCancel: () => fail(),
      });
    });
  }

  async fetchRendered(url: string): Promise<string> {
    if (window.pomAPI?.fetchRendered) {
      const res = await this.inZone(window.pomAPI.fetchRendered(url));
      if (res.error) throw new FetchError(res.error as FetchError['code']);
      if (!res.text) throw new FetchError('parse-failed');
      return res.text;
    }
    // 浏览器环境无渲染抓取能力
    throw new FetchError('source-unavailable');
  }

  /**
   * POST 抓取 —— 智能添加页 testSearch 用,主进程走 booksourceHttpProxy（safe-net 已支持任意 method/body）
   * 失败时同样弹 Tier 2 CF 引导（cf-challenge hook 由 SandboxService 注册,此处复用同一错误码契约）
   */
  async fetchPost(
    url: string,
    body: string | null,
    contentType?: string,
    extraHeaders?: Record<string, string>,
  ): Promise<string> {
    const proxy = window.pomAPI?.booksourceHttpProxy;
    if (proxy) {
      const headers: Record<string, string> = {};
      if (contentType) headers['Content-Type'] = contentType;
      if (extraHeaders) Object.assign(headers, extraHeaders);
      const res = await this.inZone(proxy({ url, method: 'POST', headers, body: body ?? null }));
      if (res.cfChallenge) throw new FetchError('cf-challenge');
      if (res.status >= 400) throw new FetchError('parse-failed', `HTTP ${res.status}`);
      return res.body ?? '';
    }
    // 浏览器 dev 降级：用 fetch 直发 POST（受 CORS 限制,失败提示书源可达性）
    try {
      const headers: Record<string, string> = { ...(extraHeaders ?? {}) };
      if (contentType) headers['Content-Type'] = contentType;
      const r = await fetch(url, { method: 'POST', headers, body: body ?? undefined });
      if (!r.ok) throw new FetchError('parse-failed', `HTTP ${r.status}`);
      return await r.text();
    } catch (e) {
      if (e instanceof FetchError) throw e;
      throw new FetchError('source-unavailable', (e as Error).message);
    }
  }
}
