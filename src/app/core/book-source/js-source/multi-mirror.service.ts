import { Injectable } from '@angular/core';

/**
 * 多镜像 URL 轮询 + Cookie 持久化 metadata（实施计划 T-014）
 *
 * 设计要点：
 * - 失败自动 failover：按 urls 顺序逐镜像尝试，每镜像重试 retriesPerMirror 次
 * - 任一次成功立即返回；全失败返回 { ok:false, error }
 * - 限流：同书源（sourceId）最小请求间隔 minDelayMs（默认 500ms）
 * - Cookie 持久化：v1 仅 metadata（cookieJar 名称），不实际存储；
 *   v2 接 session.fromPartition().cookies 后扩展
 */

export interface MirrorOptions {
  /** 主 URL + 镜像 URL 列表（按顺序） */
  urls: string[];
  /** 每镜像最大尝试次数（含首次），默认 2 */
  retriesPerMirror?: number;
  /** 书源最小请求间隔 ms，默认 500 */
  minDelayMs?: number;
  /** 限流维度键（书源 fileName）；缺省取 urls[0] */
  sourceId?: string;
  /** Cookie jar 名称（v1 仅 metadata，调用方可记录未来扩展） */
  cookieJar?: string;
}

export interface MirrorResult<T = unknown> {
  ok: boolean;
  data?: T;
  triedUrls: string[];
  error?: string;
}

const DEFAULT_RETRIES = 2;
const DEFAULT_MIN_DELAY_MS = 500;

@Injectable({ providedIn: 'root' })
export class MultiMirrorService {
  /** 限流键（sourceId / url）→ 上次请求时间戳 ms */
  private readonly lastRequestAt = new Map<string, number>();

  /**
   * 多镜像轮询：依次尝试每个 URL，每 URL 重试 retriesPerMirror 次
   * @param fn 用户提供的请求函数（注入便于单测和沙箱替换）
   * @returns ok:true 时 data 已填充；ok:false 时 error 描述失败原因
   */
  async tryMirrors<T>(
    fn: (url: string) => Promise<T>,
    options: MirrorOptions,
  ): Promise<MirrorResult<T>> {
    if (!options.urls?.length) {
      return { ok: false, triedUrls: [], error: 'urls 为空' };
    }

    const retries = Math.max(1, options.retriesPerMirror ?? DEFAULT_RETRIES);
    const minDelayMs = Math.max(0, options.minDelayMs ?? DEFAULT_MIN_DELAY_MS);
    const rateKey = options.sourceId ?? options.urls[0]!;
    const triedUrls: string[] = [];

    for (const url of options.urls) {
      for (let attempt = 1; attempt <= retries; attempt++) {
        await this.enforceRateLimit(rateKey, minDelayMs);
        triedUrls.push(url);
        try {
          const data = await fn(url);
          return { ok: true, data, triedUrls };
        } catch {
          // 继续：要么本镜像重试，要么切下镜像
        }
      }
    }

    return { ok: false, triedUrls, error: '所有镜像均失败' };
  }

  /** 限流：距上次同 key 请求 < minDelayMs 时 sleep */
  private async enforceRateLimit(key: string, minDelayMs: number): Promise<void> {
    if (minDelayMs <= 0) return;
    const last = this.lastRequestAt.get(key) ?? 0;
    const elapsed = Date.now() - last;
    if (elapsed < minDelayMs) {
      await new Promise<void>((r) => setTimeout(r, minDelayMs - elapsed));
    }
    this.lastRequestAt.set(key, Date.now());
  }
}
