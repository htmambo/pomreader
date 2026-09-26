import { Injectable, NgZone, inject } from '@angular/core';
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
      }) => Promise<{ status: number; headers: Record<string, string>; body: string }>;
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
      if (res.error) throw new FetchError(res.error as FetchError['code']);
      if (!res.html) throw new FetchError('parse-failed');
      return res.html;
    }
    // 浏览器降级
    const r = await fetch(url, { mode: 'no-cors' });
    return await r.text();
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
}
