import { Injectable } from '@angular/core';
import { CoverRequest } from './cover.types';

/**
 * 封面解析 + 缓存服务（实施计划 T-008 + spec FR-3）
 *
 * 设计要点：
 * - 命中缓存直返 `localRef`（不发起网络请求）
 * - 失败 fallback 纯色 SVG `data:` URL（避免 UI 卡住）
 * - 批量 6 并发 + 1 次重试（spec FR-3.7）
 * - IPC 不可用（浏览器降级模式）返回 0 / 走 fallback
 *
 * Window.pomAPI 类型声明统一在 page-fetcher.service.ts
 */

const BATCH_CONCURRENCY = 6;          // spec FR-3.7
const RETRY_BACKOFF_MS = 500;         // 重试退避
const MAX_RETRY = 1;                  // 总尝试次数 = 1（首次）+ 1 = 2 次

@Injectable({ providedIn: 'root' })
export class CoverService {
  /**
   * 解析单个封面 URL：命中缓存直返，未命中走 IPC 下载
   * 返回 renderer 可直接赋给 `<img src>` 的字符串（localRef / data: URL）
   */
  async resolve(req: CoverRequest | string): Promise<string> {
    const request: CoverRequest = typeof req === 'string' ? { url: req } : req;
    if (!window.pomAPI?.coverResolveCache) {
      // IPC 不可用：直接 fallback（浏览器模式不阻塞 UI）
      return this.fallbackDataUrl(request.url);
    }
    try {
      const result = await window.pomAPI.coverResolveCache(request);
      return result.localRef;
    } catch (e) {
      // 解析失败 → fallback 纯色 SVG
      console.warn(`[cover] 解析失败: ${request.url}`, e);
      return this.fallbackDataUrl(request.url);
    }
  }

  /**
   * 批量解析：6 并发 + 1 次重试（spec FR-3.7）
   * 失败的 URL 不入 Map，调用方按 missing 处理
   */
  async resolveAll(urls: string[]): Promise<Map<string, string>> {
    const results = new Map<string, string>();
    if (urls.length === 0) return results;

    const chunks: string[][] = [];
    for (let i = 0; i < urls.length; i += BATCH_CONCURRENCY) {
      chunks.push(urls.slice(i, i + BATCH_CONCURRENCY));
    }

    for (const batch of chunks) {
      const settled = await Promise.allSettled(
        batch.map(async (url) => {
          for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
            try {
              const localRef = await this.resolve(url);
              return [url, localRef] as const;
            } catch (e) {
              if (attempt >= MAX_RETRY) throw e;
              // 退避后重试
              await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS * (attempt + 1)));
            }
          }
          // TS 类型守卫：循环保证返回或抛出
          throw new Error('unreachable');
        }),
      );
      for (const r of settled) {
        if (r.status === 'fulfilled') results.set(r.value[0], r.value[1]);
      }
    }
    return results;
  }

  /** 缓存总字节数；IPC 不可用返回 0 */
  async size(): Promise<number> {
    if (!window.pomAPI?.coverCacheSize) return 0;
    try {
      return await window.pomAPI.coverCacheSize();
    } catch (e) {
      console.warn('[cover] 缓存 size 查询失败', e);
      return 0;
    }
  }

  /** 一键清理：返回释放字节数；IPC 不可用返回 0 */
  async clear(): Promise<number> {
    if (!window.pomAPI?.coverCacheClear) return 0;
    try {
      return await window.pomAPI.coverCacheClear();
    } catch (e) {
      console.warn('[cover] 缓存清理失败', e);
      return 0;
    }
  }

  /**
   * 失败 fallback：用 URL hash 派生 hue，生成纯色 SVG data: URL
   * 同一 URL 总生成相同颜色（避免重渲染抖动）
   */
  private fallbackDataUrl(url: string): string {
    const hash = Array.from(url).reduce(
      (h, c) => (h * 31 + c.charCodeAt(0)) | 0,
      0,
    );
    const hue = Math.abs(hash) % 360;
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 140">` +
      `<rect width="100" height="140" fill="hsl(${hue},40%,40%)"/>` +
      `<text x="50" y="75" font-size="14" fill="#fff" text-anchor="middle" font-family="sans-serif">Cover</text>` +
      `</svg>`;
    return 'data:image/svg+xml;base64,' + btoa(svg);
  }
}