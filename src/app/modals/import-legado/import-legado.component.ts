/**
 * 导入 Legado 订阅源（弹窗内容组件）
 *
 * 流程：
 *  1. 选 mode（粘贴 URL / 粘贴 JSON）
 *  2. 点"解析" → 调 LegadoImportService.prepareFromUrl/Text → 拿到 LegadoImportItem[]
 *  3. 列表勾选要导入的项（默认全选；翻译失败的项强制跳过）
 *  4. 点"导入所选" → persistSelected → toast 结果 → 关闭弹窗 + 刷新父列表
 */
import { Component, inject, signal, ChangeDetectionStrategy, computed } from '@angular/core';

import { FormsModule } from '@angular/forms';
import { NZ_MODAL_DATA, NzModalRef } from 'ng-zorro-antd/modal';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzCheckboxModule } from 'ng-zorro-antd/checkbox';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { NzSpinModule } from 'ng-zorro-antd/spin';
import { NzTagModule } from 'ng-zorro-antd/tag';
import { NzAlertModule } from 'ng-zorro-antd/alert';
import { LegadoImportService } from '../../core/book-source/legado/legado-import.service';
import { type LegadoImportItem } from '../../core/book-source/legado/legado-types';
import { ToastService } from '../../core/services/toast.service';

type Mode = 'url' | 'json';

interface ModalData {
  /** 导入完成后父组件回调（用于刷新书源列表） */
  onImported?: () => void;
}

@Component({
  selector: 'app-import-legado',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    NzInputModule,
    NzButtonModule,
    NzCheckboxModule,
    NzIconModule,
    NzSpinModule,
    NzTagModule,
    NzAlertModule,
  ],
  preserveWhitespaces: true,
  templateUrl: './import-legado.component.html',
  styles: [
    `
      .import-legado {
        display: flex;
        flex-direction: column;
        gap: 12px;
        min-width: 520px;
        max-height: 70vh;
      }
      .hint {
        color: var(--pom-text-muted);
        font-size: 12px;
        margin: 0;
      }
      .mode-tabs {
        display: flex;
        gap: 8px;
      }
      textarea {
        font-family: ui-monospace, monospace;
        font-size: 12px;
      }
      .actions {
        display: flex;
        gap: 8px;
        justify-content: flex-end;
        align-items: center;
      }
      .select-hint {
        margin-right: auto;
        color: var(--pom-text-muted);
        font-size: 12px;
      }
      .source-list {
        list-style: none;
        padding: 0;
        margin: 0;
        overflow: auto;
        max-height: 40vh;
        border: 1px solid var(--pom-border-soft);
        border-radius: 4px;
      }
      .source-item {
        padding: 8px 12px;
        border-bottom: 1px solid var(--pom-border-soft);
      }
      .source-item:last-child {
        border-bottom: none;
      }
      .source-item.disabled {
        opacity: 0.6;
      }
      .source-row {
        display: flex;
        gap: 8px;
        align-items: center;
      }
      .source-name {
        font-weight: 500;
        flex: 1;
      }
      .source-error {
        color: #cf1322;
        font-size: 12px;
        margin-top: 4px;
        margin-left: 24px;
      }
    `,
  ],
})
export class ImportLegadoComponent {
  private readonly data = inject<ModalData>(NZ_MODAL_DATA);
  private readonly modalRef = inject(NzModalRef, { optional: true });
  private readonly service = inject(LegadoImportService);
  private readonly toast = inject(ToastService);

  protected readonly mode = signal<Mode>('url');
  protected readonly urlInput = '';
  protected textInput = '';
  protected readonly loading = signal(false);
  protected readonly writing = signal(false);
  protected readonly items = signal<LegadoImportItem[]>([]);
  protected readonly selectedFileNames = signal<Set<string>>(new Set());

  protected readonly selectedCount = computed(() => this.selectedFileNames().size);

  protected readonly summaryMsg = computed(() => {
    const total = this.items().length;
    const ok = this.items().filter((i) => !i.isSkeleton).length;
    const sk = total - ok;
    if (sk === 0) return `解析到 ${total} 个源：全部可自动转换`;
    return `解析到 ${total} 个源：${ok} 个可自动转换，${sk} 个会保存为草稿（需在书源管理页编辑后再启用）`;
  });

  protected setMode(m: Mode): void {
    this.mode.set(m);
    this.items.set([]);
    this.selectedFileNames.set(new Set());
  }

  protected canParse(): boolean {
    return this.mode() === 'url'
      ? this.urlInput.trim().length > 0
      : this.textInput.trim().length > 0;
  }

  protected async parse(): Promise<void> {
    this.loading.set(true);
    try {
      const items =
        this.mode() === 'url'
          ? await this.service.prepareFromUrl(this.urlInput.trim())
          : await this.service.prepareFromText(this.textInput);
      this.items.set(items);
      // 默认勾选可自动转换的；骨架（需手写）不默认勾选，让用户主动决定是否要保留草稿
      this.selectedFileNames.set(
        new Set(items.filter((i) => !i.isSkeleton).map((i) => i.fileName)),
      );
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      this.toast.error(`解析失败：${msg}`);
      this.items.set([]);
      this.selectedFileNames.set(new Set());
    } finally {
      this.loading.set(false);
    }
  }

  protected isSelected(it: LegadoImportItem): boolean {
    return this.selectedFileNames().has(it.fileName);
  }

  protected toggle(it: LegadoImportItem): void {
    const next = new Set(this.selectedFileNames());
    if (next.has(it.fileName)) next.delete(it.fileName);
    else next.add(it.fileName);
    this.selectedFileNames.set(next);
  }

  protected async commit(): Promise<void> {
    const selected = this.items().filter((i) => this.selectedFileNames().has(i.fileName));
    if (selected.length === 0) return;
    this.writing.set(true);
    try {
      const result = await this.service.persistSelected(selected);
      const parts: string[] = [];
      const functional = result.written - result.skeletons;
      if (functional) parts.push(`${functional} 个可执行`);
      if (result.skeletons) parts.push(`${result.skeletons} 个草稿待手写`);
      if (result.failed.length) parts.push(`${result.failed.length} 个失败`);
      if (result.failed.length) {
        this.toast.error(parts.join(' / '));
      } else {
        this.toast.success(`已导入：${parts.join(' / ')}`);
      }
      this.data?.onImported?.();
      this.modalRef?.close();
    } finally {
      this.writing.set(false);
    }
  }

  protected cancel(): void {
    this.modalRef?.close();
  }
}
