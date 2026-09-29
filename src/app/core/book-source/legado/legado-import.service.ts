/**
 * Legado 订阅源导入编排服务
 *
 * 流程：parseLegadoText / fetchAndParseLegadoUrl → translateLegadoToDoc →
 *      pomAPI.booksourceListJson 查现有 → 生成 LegadoImportItem[] → 用户勾选 →
 *      pomAPI.booksourceSaveJson 写盘（BookSourceDoc，主进程校验 + 序列化落盘）
 *
 * 骨架项（翻译失败）同样写盘为 enabled:false 的 JSON 草稿，由 UI 提示用户后续编辑启用。
 */
import { Injectable, inject } from '@angular/core';
import { type LegadoSource, type LegadoImportItem } from './legado-types';
import { parseLegadoText, fetchAndParseLegadoUrl } from './legado-parser';
import { translateLegadoToDoc } from './legado-translator';
import { type BookSourceDoc } from '../../models/book-source-doc.model';
import { ToastService } from '../../services/toast.service';

interface PomApiSubset {
  booksourceListJson?: () => Promise<Array<{ fileName: string }>>;
  booksourceSaveJson?: (fileName: string, doc: BookSourceDoc, sourceDir?: string) => Promise<void>;
}

function pomApi(): PomApiSubset | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { pomAPI?: PomApiSubset }).pomAPI ?? null;
}

@Injectable({ providedIn: 'root' })
export class LegadoImportService {
  private readonly toast = inject(ToastService);

  /** 解析文本 → 翻译 → 返回待选列表（不写盘） */
  async prepareFromText(raw: string): Promise<LegadoImportItem[]> {
    const sources = parseLegadoText(raw);
    return this.prepareMany(sources);
  }

  /** 拉订阅 URL → 翻译 → 返回待选列表（不写盘） */
  async prepareFromUrl(url: string): Promise<LegadoImportItem[]> {
    const sources = await fetchAndParseLegadoUrl(url);
    return this.prepareMany(sources);
  }

  /** 把勾选的项写盘；返回成功写入数量 + 骨架数 + 失败原因汇总 */
  async persistSelected(items: LegadoImportItem[]): Promise<{
    written: number;
    skeletons: number;
    failed: Array<{ fileName: string; error: string }>;
  }> {
    const api = pomApi();
    if (!api?.booksourceSaveJson) {
      this.toast.error('IPC 不可用（浏览器降级或 preload 未加载）');
      return { written: 0, skeletons: 0, failed: [] };
    }
    const failed: Array<{ fileName: string; error: string }> = [];
    let written = 0;
    let skeletons = 0;
    for (const it of items) {
      try {
        await api.booksourceSaveJson(it.fileName, it.doc);
        written++;
        if (it.isSkeleton) skeletons++;
      } catch (e) {
        failed.push({ fileName: it.fileName, error: (e as Error).message ?? String(e) });
      }
    }
    return { written, skeletons, failed };
  }

  // ── 内部 ───────────────────────────────────────────────────────────────

  private async prepareMany(sources: LegadoSource[]): Promise<LegadoImportItem[]> {
    const existing = await this.fetchExistingFileNames();
    const out: LegadoImportItem[] = [];
    for (const src of sources) {
      const fileName = deriveFileName(src);
      const { doc, isSkeleton, error } = translateLegadoToDoc(src);
      out.push({
        fileName,
        uuid: doc.uuid,
        source: src,
        doc,
        isSkeleton,
        translateError: error,
        overwritesExisting: existing.has(fileName),
      });
    }
    return out;
  }

  private async fetchExistingFileNames(): Promise<Set<string>> {
    const api = pomApi();
    if (!api?.booksourceListJson) return new Set();
    try {
      const list = await api.booksourceListJson();
      return new Set((list ?? []).map((m) => m.fileName));
    } catch {
      return new Set();
    }
  }
}

/** 把书源名 slug 成文件名（去 emoji / 特殊字符 / 限长，加 .json 后缀） */
export function deriveFileName(src: LegadoSource): string {
  const raw = src.bookSourceName || 'legado-imported';
  const slug = raw
    .replace(/[\s/\\:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 80)
    .replace(/^_+|_+$/g, '');
  return `${slug || 'legado-imported'}.json`;
}
