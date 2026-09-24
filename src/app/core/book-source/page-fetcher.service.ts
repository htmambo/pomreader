import { Injectable } from '@angular/core';
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
    };
  }
}

/**
 * PageFetcher 实现 — 渲染进程通过 preload contextBridge 调主进程 net.request（绕 CORS）。
 * 浏览器环境（ng serve）降级为 fetch（受 CORS 限制，书站基本失败，仅占位保 UI 不崩）。
 */
@Injectable({ providedIn: 'root' })
export class PageFetcherService implements PageFetcher {
  async fetchHtml(
    url: string,
    encoding: 'auto' | 'utf-8' | 'gbk' = 'auto'
  ): Promise<string> {
    if (window.pomAPI?.fetchHtml) {
      const res = await window.pomAPI.fetchHtml(url, encoding);
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
      const res = await window.pomAPI.fetchRendered(url);
      if (res.error) throw new FetchError(res.error as FetchError['code']);
      if (!res.text) throw new FetchError('parse-failed');
      return res.text;
    }
    // 浏览器环境无渲染抓取能力
    throw new FetchError('source-unavailable');
  }
}
