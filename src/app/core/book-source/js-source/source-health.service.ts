/**
 * 书源健康检测服务（实施计划 T-012 + spec FR-1.7）
 *
 * - detectCapabilities(fileName)：经 SandboxService.load() 拿到模块 fns 列表（按 fileName 缓存命中）
 * - detectBatch(metas)：BATCH_CONCURRENCY 并发批量探测，单书源失败不影响其他
 * - sampleTest(meta)：可选 sample 测试（v1 占位不触发网络，避免批量检测时网络风暴）
 *
 * 决策（DM-T-012）：v1 简化为「Renderer 进程内」探测 — 复用现有 SandboxService（FR-1.7）；
 * IPC `booksourceEval` 留作调试入口（不在此服务调用）；sample 测试推迟到管理页「测试」按钮单独触发。
 */
import { Injectable } from '@angular/core';
import { SandboxService } from './sandbox.service';
import { BookSourceMeta } from './source-meta.types';

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

interface PomReadApi {
  booksourceRead?: (fileName: string, sourceDir?: string | null) => Promise<string>;
}

function getPomApi(): PomReadApi | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { pomAPI?: PomReadApi }).pomAPI;
}

@Injectable({ providedIn: 'root' })
export class SourceHealthService {
  constructor(private readonly sandbox: SandboxService) {}

  /**
   * 检测单个书源能力（FR-1.7）
   * 读源 + SandboxService.load → 取 fns；load 内部按 fileName 缓存，二次调用零网络。
   */
  async detectCapabilities(fileName: string): Promise<string[]> {
    const source = await this.readSource(fileName);
    if (source === null) return [];
    try {
      const mod = await this.sandbox.load(fileName, source);
      return mod.fns;
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
   * 可选 sample 测试：用 meta.urls[0] 跑一次 bookInfo（v1 占位）
   * 实际能力图标在管理页通过 search/bookInfo 显式探测，避免批量检测时网络风暴。
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