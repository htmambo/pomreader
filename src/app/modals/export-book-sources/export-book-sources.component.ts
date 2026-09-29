/**
 * 导出书源 bundle（弹窗内容组件，Phase 1，设计 §5.1 / §6.4）
 *
 * 流程：
 *  1. 展示书源勾选列表（数据源复用 BookSourceListStateService 已有缓存，不另开 IPC），
 *     默认全选，支持过滤 / 全选 / 反选
 *  2. 确认 → pom:booksource-bundle-export(fileNames[])
 *     → 主进程读 content + buildBundle + showSaveDialog + atomicWrite
 *  3. 结果 toast（返回 null = 用户取消保存对话框，静默关闭）
 */
import { Component, inject, signal, ChangeDetectionStrategy, computed } from '@angular/core';

import { FormsModule } from '@angular/forms';
import { NzModalRef } from 'ng-zorro-antd/modal';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzCheckboxModule } from 'ng-zorro-antd/checkbox';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { NzTagModule } from 'ng-zorro-antd/tag';
import { NzEmptyModule } from 'ng-zorro-antd/empty';
import { BookSourceListStateService } from '../../core/book-source/book-source-list-state.service';
import { type BookSourceMeta } from '../../core/book-source/source-meta.types';
import { ToastService } from '../../core/services/toast.service';

function pomApi(): PomBookSourceBundleApi | null {
  if (typeof window === 'undefined') return null;
  return (window.pomAPI as unknown as PomBookSourceBundleApi | undefined) ?? null;
}

@Component({
  selector: 'app-export-book-sources',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    NzInputModule,
    NzButtonModule,
    NzCheckboxModule,
    NzIconModule,
    NzTagModule,
    NzEmptyModule,
  ],
  template: `
    <div class="export-book-sources">
      <p class="hint">
        将所选书源导出为单个 bundle 文件（含规则与启停状态），可用于备份与迁移还原。
      </p>

      <input
        nz-input
        placeholder="过滤（名称 / 作者 / 标签）"
        [ngModel]="filter()"
        (ngModelChange)="filter.set($event)"
      />

      <div class="toolbar">
        <button nz-button nzSize="small" (click)="selectAllFiltered()">全选</button>
        <button nz-button nzSize="small" (click)="invertFiltered()">反选</button>
        <span class="select-hint"
          >已选 {{ selectedCount() }} / {{ state.sources().length }} 个</span
        >
      </div>

      @if (filtered().length === 0) {
        <nz-empty nzNotFoundContent="无匹配书源"></nz-empty>
      } @else {
        <ul class="source-list">
          @for (src of filtered(); track src.fileName) {
            <li class="source-item">
              <label class="source-row">
                <input
                  type="checkbox"
                  nz-checkbox
                  [checked]="isSelected(src)"
                  (change)="toggle(src)"
                />
                <span class="source-name">{{ src.name }}</span>
                <span class="source-meta">{{ src.author || '未知作者' }}</span>
                @for (tag of src.tags; track tag) {
                  <nz-tag class="tag-group">{{ tag }}</nz-tag>
                }
                @if (!src.enabled) {
                  <nz-tag class="tag-disabled">已禁用</nz-tag>
                }
              </label>
            </li>
          }
        </ul>
      }

      <div class="actions">
        <button nz-button (click)="cancel()">取消</button>
        <button
          nz-button
          nzType="primary"
          [disabled]="selectedCount() === 0"
          [nzLoading]="exporting()"
          (click)="confirm()"
        >
          导出所选
        </button>
      </div>
    </div>
  `,
  styles: [
    `
      .export-book-sources {
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
      .toolbar {
        display: flex;
        gap: 8px;
        align-items: center;
      }
      .select-hint {
        margin-left: auto;
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
      .source-row {
        display: flex;
        gap: 8px;
        align-items: center;
      }
      .source-name {
        font-weight: 500;
      }
      .source-meta {
        flex: 1;
        color: var(--pom-text-muted);
        font-size: 12px;
      }
      .actions {
        display: flex;
        gap: 8px;
        justify-content: flex-end;
        align-items: center;
      }
    `,
  ],
})
export class ExportBookSourcesComponent {
  protected readonly state = inject(BookSourceListStateService);
  private readonly modalRef = inject(NzModalRef, { optional: true });
  private readonly toast = inject(ToastService);

  /** 弹窗内局部过滤词（匹配规则与列表页一致：名称 / 作者 / 标签） */
  protected readonly filter = signal('');
  protected readonly exporting = signal(false);
  protected readonly selectedFileNames = signal<Set<string>>(
    new Set(this.state.sources().map((s) => s.fileName)),
  );

  protected readonly filtered = computed<BookSourceMeta[]>(() => {
    const q = this.filter().trim().toLowerCase();
    const all = this.state.sources();
    if (!q) return all;
    return all.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        (s.author ?? '').toLowerCase().includes(q) ||
        s.tags.some((t) => t.toLowerCase().includes(q)),
    );
  });

  protected readonly selectedCount = computed(() => this.selectedFileNames().size);

  protected isSelected(src: BookSourceMeta): boolean {
    return this.selectedFileNames().has(src.fileName);
  }

  protected toggle(src: BookSourceMeta): void {
    const next = new Set(this.selectedFileNames());
    if (next.has(src.fileName)) next.delete(src.fileName);
    else next.add(src.fileName);
    this.selectedFileNames.set(next);
  }

  /** 全选（当前过滤结果） */
  protected selectAllFiltered(): void {
    const next = new Set(this.selectedFileNames());
    for (const s of this.filtered()) next.add(s.fileName);
    this.selectedFileNames.set(next);
  }

  /** 反选（当前过滤结果） */
  protected invertFiltered(): void {
    const next = new Set(this.selectedFileNames());
    for (const s of this.filtered()) {
      if (next.has(s.fileName)) next.delete(s.fileName);
      else next.add(s.fileName);
    }
    this.selectedFileNames.set(next);
  }

  protected async confirm(): Promise<void> {
    const api = pomApi();
    if (!api?.booksourceBundleExport) {
      this.toast.error('IPC 不可用');
      return;
    }
    const fileNames = this.state
      .sources()
      .filter((s) => this.selectedFileNames().has(s.fileName))
      .map((s) => s.fileName);
    if (fileNames.length === 0) return;
    this.exporting.set(true);
    try {
      const result = await api.booksourceBundleExport(fileNames);
      // null = 用户在保存对话框点了取消，无需提示
      if (result) {
        this.toast.success(`已导出 ${result.count} 个书源：${result.path}`);
      }
      this.modalRef?.close();
    } catch (e) {
      this.toast.error(`导出失败：${(e as Error).message ?? String(e)}`);
    } finally {
      this.exporting.set(false);
    }
  }

  protected cancel(): void {
    this.modalRef?.close();
  }
}
