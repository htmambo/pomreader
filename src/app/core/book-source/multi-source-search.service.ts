import { Injectable, signal } from '@angular/core';
import { BookSourceRegistry } from './book-source.registry';
import { RawSearchItem } from './book-source.adapter';

/**
 * 重新导出 RawSearchItem 以保留既有调用方 import 路径（多源聚合搜索服务对外契约），
 * 实际类型定义在 book-source.adapter.ts（适配器层公共类型，便于 JsSourceAdapter 等
 * 子模块复用，避免 multi-source → registry → js-source 循环依赖）。
 */
export type { RawSearchItem };

/** 跨源搜索进度（暴露给 UI 实时显示「正在搜索 a (x/y)」） */
export interface SearchProgress {
  /** 阶段：UI 据此切换文案 */
  phase: 'idle' | 'preparing' | 'searching' | 'finalizing' | 'done';
  /** 已完成的源数（searching 阶段递增） */
  done: number;
  /** 待搜索的总源数 */
  total: number;
  /** 当前正在处理的源名（batch 内最近开始；并发场景下展示「hetushu, 笔趣阁...」） */
  current: string;
}

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

/** 聚合后展示项 */
export interface SearchResultItem {
  /** 书源 fileName 或显示名 */
  source: string;
  sourceName: string;
  name: string;
  author?: string;
  /** 分类/题材（项目 Book.kind 对应） */
  kind?: string;
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
  /** 跨源搜索实时进度（UI 订阅显示「正在搜索 X (x/y)」） */
  readonly progress = signal<SearchProgress>({ phase: 'idle', done: 0, total: 0, current: '' });

  /**
   * 最近一次 searchAll 的源失败原因（"源名: 错误信息"格式），
   * 用于 UI 在结果为 0 时展示为什么没搜到。
   */
  lastErrors: string[] = [];

  constructor(private readonly registry: BookSourceRegistry) {}

  /**
   * 并发跨源搜索：分批并发 + 全局去重 + 失败隔离
   * @param keyword 搜索关键词
   * @param opts 配置项
   * @returns 聚合去重后的结果列表
   */
  async searchAll(keyword: string, opts: SearchOptions = {}): Promise<SearchResultItem[]> {
    this.lastErrors = [];
    this.progress.set({ phase: 'preparing', done: 0, total: 0, current: '' });

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

    if (filtered.length === 0) {
      // 诊断日志：让前端能直接看到为什么搜不到（registry 没加载 JS 书源 / 适配器未实现 search）
      const totalRegistered = supported.length;
      const withSearch = sources.length;
      console.warn(
        `[multi-source-search] 0 个源参与搜索：registry 共注册 ${totalRegistered} 个适配器，` +
        `${withSearch} 个实现 search()。可能原因：① 启动时未调用 registry.loadAllJsAdapters()；` +
        `② 用户未装书源；③ 所有书源都未实现 search() 函数。`,
      );
      this.progress.set({ phase: 'done', done: 0, total: 0, current: '' });
      return [];
    }

    this.progress.update((p) => ({ ...p, total: filtered.length, phase: 'searching' }));

    const results: SearchResultItem[] = [];
    const seen = new Set<string>();

    // 分批并发执行（避免 100 书源一次性 Promise.all）
    for (let i = 0; i < filtered.length; i += concurrency) {
      const batch = filtered.slice(i, i + concurrency);
      // 显示当前正在处理的 batch（并发场景下展示多个源名，逗号分隔）
      this.progress.update((p) => ({
        ...p,
        current: batch.map((s) => s.name).join(', '),
      }));

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
            this.lastErrors.push(`${src.name}: ${item.error}`);
            continue; // 错误项不展示
          }
          // 去重 key：name|author
          const key = `${(item.name || '').trim()}|${(item.author || '').trim()}`;
          if (seen.has(key)) continue;
          seen.add(key);
          results.push(item);
        }
        this.progress.update((p) => ({ ...p, done: p.done + 1 }));
      }
    }
    this.progress.set({ phase: 'done', done: filtered.length, total: filtered.length, current: '' });
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
        kind: it.kind,
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
