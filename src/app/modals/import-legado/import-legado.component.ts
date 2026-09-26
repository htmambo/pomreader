/**
 * 导入 Legado 订阅源（弹窗内容组件）
 *
 * 流程：
 *  1. 选 mode（粘贴 URL / 粘贴 JSON）
 *  2. 点"解析" → 调 LegadoImportService.prepareFromUrl/Text → 拿到 LegadoImportItem[]
 *  3. 列表勾选要导入的项（默认全选；翻译失败的项强制跳过）
 *  4. 点"导入所选" → persistSelected → toast 结果 → 关闭弹窗 + 刷新父列表
 */
import {
  Component,
  inject,
  signal,
  ChangeDetectionStrategy,
  computed,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  NZ_MODAL_DATA,
  NzModalRef,
} from 'ng-zorro-antd/modal';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzCheckboxModule } from 'ng-zorro-antd/checkbox';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { NzSpinModule } from 'ng-zorro-antd/spin';
import { NzTagModule } from 'ng-zorro-antd/tag';
import { NzAlertModule } from 'ng-zorro-antd/alert';
import {
  LegadoImportService,
} from '../../core/book-source/legado/legado-import.service';
import {
  LegadoImportItem,
} from '../../core/book-source/legado/legado-types';
import { ToastService } from '../../core/services/toast.service';

type Mode = 'url' | 'json';

interface ModalData {
  /** 导入完成后父组件回调（用于刷新书源列表） */
  onImported?: () => void;
}

@Component({
  selector: 'app-import-legado',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    FormsModule,
    NzInputModule,
    NzButtonModule,
    NzCheckboxModule,
    NzIconModule,
    NzSpinModule,
    NzTagModule,
    NzAlertModule,
  ],
  template: `
    <div class="import-legado">
      <p class="hint">
        阅读(Legado) 订阅源支持两种格式：JSON 对象（单源）或 JSON 数组（订阅列表），
        也支持 base64 编码的上述任一种。pomreader 会自动嗅探并转换其中
        <strong>纯 CSS / 正则规则</strong> 的源；含 java.* / source.* 桥接的源会被跳过（提示用户走智能添加）。
      </p>

      <div class="mode-tabs">
        <button
          type="button"
          nz-button
          nzSize="small"
          [nzType]="mode() === 'url' ? 'primary' : 'default'"
          (click)="setMode('url')"
        >订阅 URL</button>
        <button
          type="button"
          nz-button
          nzSize="small"
          [nzType]="mode() === 'json' ? 'primary' : 'default'"
          (click)="setMode('json')"
        >粘贴 JSON</button>
      </div>

      <textarea
        *ngIf="mode() === 'json'"
        nz-input
        [(ngModel)]="textInput"
        rows="6"
        placeholder="粘贴 legado JSON 文本（单对象 / 数组 / base64）"
        [disabled]="loading()"
      ></textarea>
      <input
        *ngIf="mode() === 'url'"
        nz-input
        type="text"
        [(ngModel)]="urlInput"
        placeholder="https://example.com/legado-subscriptions.txt"
        [disabled]="loading()"
      />

      <div class="actions">
        <button nz-button (click)="cancel()">取消</button>
        <button
          nz-button
          nzType="primary"
          [disabled]="!canParse()"
          [nzLoading]="loading()"
          (click)="parse()"
        >解析</button>
      </div>

      <nz-spin [nzSpinning]="loading()">
        @if (items().length > 0) {
          <nz-alert
            nzType="info"
            nzShowIcon
            [nzMessage]="summaryMsg()"
            style="margin: 12px 0;"
          ></nz-alert>

          <ul class="source-list">
            @for (it of items(); track it.fileName) {
              <li class="source-item" [class.skeleton]="it.isSkeleton">
                <label class="source-row">
                  <input
                    type="checkbox"
                    nz-checkbox
                    [checked]="isSelected(it)"
                    (change)="toggle(it)"
                  />
                  <span class="source-name">{{ it.source.bookSourceName }}</span>
                  <nz-tag class="tag-group" *ngIf="it.source.bookSourceGroup">
                    {{ it.source.bookSourceGroup }}
                  </nz-tag>
                  <nz-tag class="tag-status" [nzColor]="it.isSkeleton ? 'orange' : 'green'">
                    {{ it.isSkeleton ? '⚠ 需手写（草稿）' : '✓ 可转换' }}
                  </nz-tag>
                  <nz-tag class="tag-overwrite" *ngIf="it.overwritesExisting" nzColor="orange">
                    覆盖现有
                  </nz-tag>
                </label>
                @if (it.translateError) {
                  <div class="source-error">{{ it.translateError }}</div>
                }
              </li>
            }
          </ul>

          <div class="actions">
            <span class="select-hint">已选 {{ selectedCount() }} 个</span>
            <button nz-button (click)="cancel()">取消</button>
            <button
              nz-button
              nzType="primary"
              [disabled]="selectedCount() === 0"
              [nzLoading]="writing()"
              (click)="commit()"
            >导入所选</button>
          </div>
        }
      </nz-spin>
    </div>
  `,
  styles: [
    `
      .import-legado { display: flex; flex-direction: column; gap: 12px; min-width: 520px; max-height: 70vh; }
      .hint { color: var(--pom-text-muted); font-size: 12px; margin: 0; }
      .mode-tabs { display: flex; gap: 8px; }
      textarea { font-family: ui-monospace, monospace; font-size: 12px; }
      .actions { display: flex; gap: 8px; justify-content: flex-end; align-items: center; }
      .select-hint { margin-right: auto; color: var(--pom-text-muted); font-size: 12px; }
      .source-list { list-style: none; padding: 0; margin: 0; overflow: auto; max-height: 40vh; border: 1px solid var(--pom-border-soft); border-radius: 4px; }
      .source-item { padding: 8px 12px; border-bottom: 1px solid var(--pom-border-soft); }
      .source-item:last-child { border-bottom: none; }
      .source-item.disabled { opacity: 0.6; }
      .source-row { display: flex; gap: 8px; align-items: center; }
      .source-name { font-weight: 500; flex: 1; }
      .source-error { color: #cf1322; font-size: 12px; margin-top: 4px; margin-left: 24px; }
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
    return this.mode() === 'url' ? this.urlInput.trim().length > 0 : this.textInput.trim().length > 0;
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
