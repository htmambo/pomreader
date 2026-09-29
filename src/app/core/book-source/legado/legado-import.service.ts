/**
 * Legado 订阅源导入编排服务
 *
 * 流程：parseLegadoText / fetchAndParseLegadoUrl → translateLegadoToDoc →
 *      pomAPI.booksourceList 查现有 → 生成 LegadoImportItem[] → 用户勾选 →
 *      pomAPI.booksourceSave 写盘（全部勾选项，含骨架）
 *
 * 不写盘的项（用户未勾选）由 UI 提示；骨架项照写但 `enabled: false`，不会被注册。
 * 📌 书源 JSON 规则化 P2.3：产出由 JS 模板改为 JSON 文档（`.json`）。
 */
import { Injectable, inject } from '@angular/core';
import * as v from 'valibot';
import { type LegadoSource, type LegadoImportItem } from './legado-types';
import { parseLegadoText, fetchAndParseLegadoUrl } from './legado-parser';
import { translateLegadoToDoc } from './legado-translator';
import { serializeSourceDoc } from '../../logic/source-doc-build';
import { BookSourceDocSchema } from '../../models/book-source-doc.model';
import { type BookSourceMeta } from '../source-meta.types';
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
      // 落盘前 schema 门（与智能添加页同一道）：导入的源来自外部订阅文件，
      // 字段值不可信。写出一份打不开的文档 = 用户下次打开报错且无从定位，
      // 而这里多花一次 parse 就能拦住（外部评审 R1 抓到：两条写入路径当时只有一条有门）。
      const checked = validateDocText(it.translatedJson);
      if (!checked.ok) {
        failed.push({ fileName: it.fileName, error: `规则非法：${checked.message}` });
        continue;
      }
      try {
        await api.booksourceSave(it.fileName, it.translatedJson);
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
        // uuid 取**文档里那个**，不再二次派生：原先这里另有一套 FNV-1a，种子是
        // `bookSourceName || fileName`，而 translator 里的是 `bookSourceName || bookSourceUrl`。
        // 书源名缺失时两者算出**不同**的 uuid → 列表页展示的 id 与文件内嵌的对不上。
        // 单一来源 = 文档。
        uuid: doc.uuid,
        source: src,
        translatedJson: serializeSourceDoc(doc),
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

/** 落盘前的 schema 门；返回 `ok:false` 时 message 是第一条 issue 的描述 */
function validateDocText(text: string): { ok: true } | { ok: false; message: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  const checked = v.safeParse(BookSourceDocSchema, parsed);
  return checked.success
    ? { ok: true }
    : { ok: false, message: checked.issues[0]?.message ?? '未知错误' };
}
