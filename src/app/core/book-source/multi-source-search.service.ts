import { Injectable } from '@angular/core';
import { BookSourceRegistry } from './book-source.registry';

/**
 * 多源聚合搜索（实施计划 T-006 + spec FR-2）
 *
 * 设计要点：
 * - 跨书源并发（默认 5 并发），单书源超时 30s 隔离失败
 * - 去重：相同 书名+作者 视为同一本书（spec ASSUMPTION-12），保留先返回
 * - 错误项不展示但记录在 console.warn（前端排障）
 * - 适配器 duck-typing `search(keyword, page)`：内置 BaseSourceAdapter 不暴露 search(),
 *   仅当适配器实现该方法才参与搜索（未来扩展无侵入）
 */

/** 书源搜索原始返回项（兼容 legado 风格：name/title, url/bookUrl, author, intro/description） */
export interface RawSearchItem {
  name?: string;
  title?: string;
  author?: string;
  url?: string;
  bookUrl?: string;
  intro?: string;
  description?: string;
}

/** 聚合后展示项 */
export interface SearchResultItem {
  /** 书源 fileName 或显示名 */
  source: string;
  sourceName: string;
  name: string;
  author?: string;
  /** 书页 URL（用于 toc） */
  url: string;
  intro?: string;
  /** 该书源响应耗时 ms */
  latencyMs: number;
  /** 书源失败时填充（前端不展示） */
  error?: string;
}

export interface SearchOptions {
  /** 限定书源名列表；空 = 全部 enabled */
  sourceNames?: string[];
  /** 并发数（默认 5） */
  concurrency?: number;
  /** 单书源超时 ms（默认 30000） */
  timeoutMs?: number;
}

const DEFAULT_CONCURRENCY = 5;
const DEFAULT_TIMEOUT_MS = 30_000;

interface BookSourceWithSearch {
  name: string;
  /** duck-typed: search(keyword, page) => Promise<RawSearchItem[]> */
  search?: (keyword: string, page?: number) => Promise<RawSearchItem[]>;
}

@Injectable({ providedIn: 'root' })
export class MultiSourceSearchService {
  constructor(private readonly registry: BookSourceRegistry) {}

  /**
   * 并发跨源搜索：分批并发 + 全局去重 + 失败隔离
   * @param keyword 搜索关键词
   * @param opts 配置项
   * @returns 聚合去重后的结果列表
   */
  async searchAll(keyword: string, opts: SearchOptions = {}): Promise<SearchResultItem[]> {
    const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    // 收集所有支持的源（duck-typed：有 search 方法的适配器才纳入）
    const supported = this.registry.supportedSources();
    const sources: BookSourceWithSearch[] = supported
      .map((name) => this.registry.get(name) as unknown as BookSourceWithSearch | undefined)
      .filter((a): a is BookSourceWithSearch => !!a && typeof a.search === 'function');

    // 按 sourceNames 过滤
    const filtered = opts.sourceNames?.length
      ? sources.filter((s) => opts.sourceNames!.includes(s.name))
      : sources;

    if (filtered.length === 0) return [];

    const results: SearchResultItem[] = [];
    const seen = new Set<string>();

    // 分批并发执行（避免 100 书源一次性 Promise.all）
    for (let i = 0; i < filtered.length; i += concurrency) {
      const batch = filtered.slice(i, i + concurrency);
      const settled = await Promise.allSettled(
        batch.map((src) => this.callSource(src, keyword, timeoutMs)),
      );
      for (let j = 0; j < settled.length; j++) {
        const r = settled[j];
        const src = batch[j];
        if (r.status !== 'fulfilled') continue;
        for (const item of r.value) {
          if (item.error) {
            console.warn(`[multi-source-search] 书源 ${src.name} 失败:`, item.error);
            continue; // 错误项不展示
          }
          // 去重 key：name|author
          const key = `${(item.name || '').trim()}|${(item.author || '').trim()}`;
          if (seen.has(key)) continue;
          seen.add(key);
          results.push(item);
        }
      }
    }
    return results;
  }

  /** 单书源调用：超时熔断 + 错误隔离，返回规范化项数组（失败时数组中含 error 项） */
  private async callSource(
    src: BookSourceWithSearch,
    keyword: string,
    timeoutMs: number,
  ): Promise<SearchResultItem[]> {
    const start = Date.now();
    try {
      const raw = await this.callWithTimeout(src, keyword, timeoutMs);
      return raw.map((it) => ({
        source: src.name,
        sourceName: src.name,
        name: (it.name || it.title || '').trim(),
        author: it.author,
        url: it.url || it.bookUrl || '',
        intro: it.intro || it.description,
        latencyMs: Date.now() - start,
      }));
    } catch (e) {
      return [{
        source: src.name,
        sourceName: src.name,
        name: '',
        url: '',
        latencyMs: Date.now() - start,
        error: (e as Error).message,
      }];
    }
  }

  /** Promise.race 超时熔断 */
  private callWithTimeout(
    src: BookSourceWithSearch,
    keyword: string,
    timeoutMs: number,
  ): Promise<RawSearchItem[]> {
    return Promise.race([
      src.search!(keyword, 1),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs),
      ),
    ]);
  }
}
