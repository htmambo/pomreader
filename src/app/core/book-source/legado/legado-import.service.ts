/**
 * Legado 订阅源导入编排服务
 *
 * 流程：parseLegadoText / fetchAndParseLegadoUrl → translateLegadoToJs →
 *      pomAPI.booksourceList 查现有 → 生成 LegadoImportItem[] → 用户勾选 →
 *      pomAPI.booksourceSave 写盘（仅 translatedJs !== null 的项）
 *
 * 不写盘的项（翻译失败）由 UI 弹 toast 提示用户走智能添加手写。
 */
import { Injectable, inject } from '@angular/core';
import { LegadoSource, LegadoImportItem } from './legado-types';
import { parseLegadoText, fetchAndParseLegadoUrl } from './legado-parser';
import { translateLegadoToJs } from './legado-translator';
import { BookSourceMeta } from '../js-source/source-meta.types';
import { ToastService } from '../../services/toast.service';

interface PomApiSubset {
  booksourceList?: () => Promise<BookSourceMeta[]>;
  booksourceSave?: (fileName: string, content: string) => Promise<void>;
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
    if (!api?.booksourceSave) {
      this.toast.error('IPC 不可用（浏览器降级或 preload 未加载）');
      return { written: 0, skeletons: 0, failed: [] };
    }
    const failed: Array<{ fileName: string; error: string }> = [];
    let written = 0;
    let skeletons = 0;
    for (const it of items) {
      try {
        await api.booksourceSave(it.fileName, it.translatedJs);
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
      const { js, isSkeleton, error } = translateLegadoToJs(src);
      out.push({
        fileName,
        uuid: deriveUuidFromName(src.bookSourceName || fileName),
        source: src,
        translatedJs: js,
        isSkeleton,
        translateError: error,
        overwritesExisting: existing.has(fileName),
      });
    }
    return out;
  }

  private async fetchExistingFileNames(): Promise<Set<string>> {
    const api = pomApi();
    if (!api?.booksourceList) return new Set();
    try {
      const list = await api.booksourceList();
      return new Set((list ?? []).map((m) => m.fileName));
    } catch {
      return new Set();
    }
  }
}

/** 把书源名 slug 成文件名（去 emoji / 特殊字符 / 限长，加 .js 后缀） */
export function deriveFileName(src: LegadoSource): string {
  const raw = src.bookSourceName || 'legado-imported';
  const slug = raw
    .replace(/[\s/\\:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 80)
    .replace(/^_+|_+$/g, '');
  return `${slug || 'legado-imported'}.js`;
}

/** 文件名级 uuid（与 legado-translator 派生规则保持一致——同名导入派生一致） */
function deriveUuidFromName(name: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `legado-${(h >>> 0).toString(16).padStart(8, '0')}`;
}
