import { Injectable, inject } from '@angular/core';
import { ToastService } from './toast.service';
import { LocalTxtImportService } from './local-txt-import.service';
import { isImportableUrl } from '../logic/auto-import-url';

export { isImportableUrl };

interface AutoImportApi {
  onAutoImport?: (cb: (payload: { fileName: string; txtName?: string; error?: string }) => void) => () => void;
  autoImportFromUrl?: (url: string) => Promise<{ fileName: string; txtName: string }>;
  autoImportReadText?: (txtName: string) => Promise<string>;
}

function api(): AutoImportApi | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { pomAPI?: AutoImportApi }).pomAPI ?? null;
}

/**
 * 自动导入监控（万能搜索 webview）
 * - 主进程两条触发链（attachment 下载 / inline 页面抓取）完成解码解压后
 *   经 'pom:auto-import-detected' 推送 → 此处读文本 → 去重 → 入书架
 * - universal-search 的 will-navigate 命中 .txt/.zip 时调 importFromUrl 主动触发
 */
@Injectable({ providedIn: 'root' })
export class AutoImportService {
  private readonly toast = inject(ToastService);
  private readonly importer = inject(LocalTxtImportService);
  /** 进行中的 txtName 防重（下载与导航两条链可能同时命中同一文件） */
  private readonly inflight = new Set<string>();

  constructor() {
    const a = api();
    if (a?.onAutoImport) {
      a.onAutoImport((p) => void this.onDetected(p));
    }
  }

  /** webview 导航命中可导入 URL 时调用；返回是否已受理（受理后调用方应阻止导航） */
  async importFromUrl(url: string): Promise<boolean> {
    const a = api();
    if (!a?.autoImportFromUrl || !isImportableUrl(url)) return false;
    try {
      // 主进程抓取 + 处理 + notify（onDetected 走统一导入链），此处只负责触发
      await a.autoImportFromUrl(url);
    } catch (e) {
      this.toast.error(`自动导入失败：${(e as Error).message}`);
    }
    return true;
  }

  private async onDetected(p: { fileName: string; txtName?: string; error?: string }): Promise<void> {
    if (p.error || !p.txtName) {
      this.toast.error(`自动导入失败：${p.fileName} —— ${p.error ?? '未知错误'}`);
      return;
    }
    if (this.inflight.has(p.txtName)) return;
    this.inflight.add(p.txtName);
    try {
      const a = api();
      if (!a?.autoImportReadText) return;
      if (this.importer.hasBook(p.fileName)) {
        this.toast.info(`书架已存在《${this.importer.titleOf(p.fileName)}》，跳过自动导入`);
        return;
      }
      const text = await a.autoImportReadText(p.txtName);
      const { book, chapters, singleChapter } = await this.importer.importText(p.fileName, text, 'auto-import');
      this.toast.success(
        `已自动导入：${book.title}（${chapters.length} 章）${singleChapter ? '，未识别章节按单章导入' : ''}`,
      );
    } catch (e) {
      this.toast.error(`自动导入失败：${(e as Error).message}`);
    } finally {
      this.inflight.delete(p.txtName);
    }
  }
}
