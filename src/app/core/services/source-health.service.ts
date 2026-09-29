/**
 * 书源健康检测服务（JSON 规则书源版）
 *
 * 实现：「JSON 合法性 + 必填规则非空」校验：读 .json → JSON.parse → BookSourceDocSchema
 * safeParse；全通过 → 四入口能力全开；任一失败 → 空能力（列表页健康角标语义不变）。
 * detectBatch 接口保留（BATCH_CONCURRENCY 并发，单源失败不影响其他）。
 *（历史：沙箱时代曾取 JS 模块函数表判能力，沙箱链路已于 P4 删除。）
 */
import { Injectable } from '@angular/core';
import * as v from 'valibot';
import { BookSourceDocSchema } from '../models/book-source-doc.model';
import { type BookSourceMeta } from '../book-source/source-meta.types';

export interface SourceHealthSample {
  ok: boolean;
  durationMs: number;
  error?: string;
}

export interface SourceHealthReport {
  fileName: string;
  capabilities: string[];
  testedAt: number;
  sample?: SourceHealthSample;
}

const BATCH_CONCURRENCY = 5; // spec FR-1.7：批量 5 并发

/** JSON 书源四入口能力（schema 全过即全开 —— 必填规则非空由 minLength 保证） */
const ALL_CAPABILITIES = ['search', 'bookInfo', 'chapterList', 'chapterContent'];

interface PomReadApi {
  booksourceRead?: (fileName: string, sourceDir?: string | null) => Promise<string>;
}

function getPomApi(): PomReadApi | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { pomAPI?: PomReadApi }).pomAPI;
}

@Injectable({ providedIn: 'root' })
export class SourceHealthService {
  /**
   * 检测单个书源能力：JSON 合法性 + schema 校验（含 7 必填规则非空）。
   * 读不到文件 / JSON 非法 / schema 不过 → []（与旧版 load 失败返 [] 同语义）。
   */
  async detectCapabilities(fileName: string): Promise<string[]> {
    const source = await this.readSource(fileName);
    if (source === null) return [];
    try {
      const parsed = v.safeParse(BookSourceDocSchema, JSON.parse(source));
      return parsed.success ? [...ALL_CAPABILITIES] : [];
    } catch {
      return [];
    }
  }

  /**
   * 批量检测（BATCH_CONCURRENCY 并发）
   * 单书源失败仅记录 sample.error，整体不中断。
   */
  async detectBatch(metas: BookSourceMeta[]): Promise<Map<string, SourceHealthReport>> {
    const reports = new Map<string, SourceHealthReport>();
    for (let i = 0; i < metas.length; i += BATCH_CONCURRENCY) {
      const batch = metas.slice(i, i + BATCH_CONCURRENCY);
      const settled = await Promise.allSettled(batch.map((m) => this.probeOne(m)));
      for (const r of settled) {
        if (r.status === 'fulfilled') reports.set(r.value.fileName, r.value);
      }
    }
    return reports;
  }

  /**
   * 可选 sample 测试：v1 占位（不触发网络，避免批量检测时网络风暴）。
   * 实际能力图标在管理页通过 search/bookInfo 显式探测。
   */
  async sampleTest(_meta: BookSourceMeta): Promise<SourceHealthSample> {
    return { ok: true, durationMs: 0 };
  }

  private async probeOne(meta: BookSourceMeta): Promise<SourceHealthReport> {
    const start = Date.now();
    try {
      const capabilities = await this.detectCapabilities(meta.fileName);
      return {
        fileName: meta.fileName,
        capabilities,
        testedAt: Date.now(),
        sample: { ok: true, durationMs: Date.now() - start },
      };
    } catch (e) {
      return {
        fileName: meta.fileName,
        capabilities: [],
        testedAt: Date.now(),
        sample: { ok: false, durationMs: Date.now() - start, error: (e as Error).message },
      };
    }
  }

  private async readSource(fileName: string): Promise<string | null> {
    const read = getPomApi()?.booksourceRead;
    if (!read) return null;
    try {
      return await read(fileName, null);
    } catch {
      return null;
    }
  }
}
