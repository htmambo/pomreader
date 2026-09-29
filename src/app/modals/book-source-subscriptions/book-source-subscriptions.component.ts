/**
 * 书源订阅管理（弹窗内容组件，Phase 2，设计 §6.4 / §6.1）
 *
 * 流程：
 *  1. 打开即调 pom:booksource-sub-list 拉全量订阅表渲染（名称 / URL / 上次检查 /
 *     下次检查 / 状态 / 操作列）
 *  2. 新增 / 编辑共用内联表单（名称、URL、intervalHours 默认 12、enabled）；
 *     保存 → pom:booksource-sub-save（新增 id 传空串，主进程生成）→ 重拉列表
 *  3. 删除走 NzModalService.confirm 二次确认 → pom:booksource-sub-delete
 *  4. 立即检查 → pom:booksource-sub-check → toast { changed, conflicts, error } 结果；
 *     conflicts > 0 只提示（本 Phase 不做冲突解决 UI，设计未定义该交互）
 *  5. 启用开关复用 save 通道（{ ...sub, enabled: next }），失败 toast 后重拉纠正
 *
 * 书源列表本身的刷新不在本组件做：主进程写入后广播 pom:booksource-updated，
 * BookSourceListStateService 已监听并静默刷新（设计 §6.3）。
 */
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';

import { FormsModule } from '@angular/forms';
import { NgFor } from '@angular/common';
import { NzModalRef, NzModalService } from 'ng-zorro-antd/modal';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzInputNumberModule } from 'ng-zorro-antd/input-number';
import { NzSwitchModule } from 'ng-zorro-antd/switch';
import { NzTableModule } from 'ng-zorro-antd/table';
import { NzTagModule } from 'ng-zorro-antd/tag';
import { NzSpinModule } from 'ng-zorro-antd/spin';
import { NzEmptyModule } from 'ng-zorro-antd/empty';
import { NzAlertModule } from 'ng-zorro-antd/alert';
import { ToastService } from '../../core/services/toast.service';

export const DEFAULT_INTERVAL_HOURS = 12;

function pomApi(): PomBookSourceSubscriptionApi | null {
  if (typeof window === 'undefined') return null;
  return (window.pomAPI as unknown as PomBookSourceSubscriptionApi | undefined) ?? null;
}

function errMsg(e: unknown): string {
  return (e as Error)?.message ?? String(e);
}

@Component({
  selector: 'app-book-source-subscriptions',
  changeDetection: ChangeDetectionStrategy.OnPush,
  preserveWhitespaces: true,
  imports: [
    FormsModule,
    NgFor,
    NzButtonModule,
    NzIconModule,
    NzInputModule,
    NzInputNumberModule,
    NzSwitchModule,
    NzTableModule,
    NzTagModule,
    NzSpinModule,
    NzEmptyModule,
    NzAlertModule,
  ],
  templateUrl: './book-source-subscriptions.component.html',
  styles: [
    `
      .book-source-subscriptions {
        display: flex;
        flex-direction: column;
        gap: 12px;
        min-width: 640px;
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
      .count-hint {
        margin-left: auto;
        color: var(--pom-text-muted);
        font-size: 12px;
      }
      .sub-form {
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 8px 12px;
        border: 1px solid var(--pom-border-soft);
        border-radius: 4px;
      }
      .form-row {
        display: flex;
        gap: 8px;
        align-items: center;
      }
      .name-input {
        width: 180px;
      }
      .url-input {
        flex: 1;
      }
      .form-label {
        color: var(--pom-text-muted);
        font-size: 12px;
      }
      .form-actions {
        margin-left: auto;
        display: flex;
        gap: 8px;
      }
      .state-block {
        display: flex;
        justify-content: center;
        padding: 24px 0;
      }
      .cell-name {
        font-weight: 500;
        white-space: nowrap;
      }
      .cell-url {
        max-width: 220px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--pom-text-muted);
      }
      .cell-time {
        white-space: nowrap;
      }
      .last-error {
        color: var(--pom-error, #ff4d4f);
        font-size: 12px;
        max-width: 200px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .cell-actions {
        white-space: nowrap;
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
export class BookSourceSubscriptionsComponent {
  private readonly modalRef = inject(NzModalRef, { optional: true });
  private readonly modal = inject(NzModalService);
  private readonly toast = inject(ToastService);

  protected readonly loading = signal(true);
  /** 列表整体拉取失败原因（IPC 不可用等），非空时渲染 alert */
  protected readonly loadError = signal<string | null>(null);
  protected readonly items = signal<BookSourceSubscription[]>([]);
  /** 新增 / 编辑表单模型；null = 表单收起。新增时 id 为空串（主进程生成） */
  protected readonly editing = signal<BookSourceSubscription | null>(null);
  protected readonly saving = signal(false);
  /** 正在「立即检查」的订阅 id（行内 loading） */
  protected readonly checkingId = signal<string | null>(null);

  constructor() {
    void this.load();
  }

  /** 拉全量订阅表 */
  protected async load(): Promise<void> {
    const api = pomApi();
    if (!api?.booksourceSubList) {
      this.loadError.set('IPC 不可用');
      this.loading.set(false);
      return;
    }
    try {
      const list = await api.booksourceSubList();
      this.items.set(Array.isArray(list) ? list : []);
      this.loadError.set(null);
    } catch (e) {
      this.loadError.set(errMsg(e));
    } finally {
      this.loading.set(false);
    }
  }

  /** 打开新增表单（intervalHours 默认 12，enabled 默认 true） */
  protected startAdd(): void {
    this.editing.set({
      id: '',
      name: '',
      url: '',
      enabled: true,
      intervalHours: DEFAULT_INTERVAL_HOURS,
      lastCheckedAt: null,
      lastError: null,
    });
  }

  /** 打开编辑表单（拷贝一份，避免直接改列表项） */
  protected startEdit(sub: BookSourceSubscription): void {
    this.editing.set({ ...sub });
  }

  protected cancelEdit(): void {
    this.editing.set(null);
  }

  /** 表单可提交：名称与 URL 均非空（普通方法而非 computed —— ngModel 直接改对象字段，不走 signal） */
  protected canSave(): boolean {
    const f = this.editing();
    return !!f && f.name.trim().length > 0 && f.url.trim().length > 0;
  }

  /** 保存（新增 / 编辑同一通道）：trim + intervalHours 兜底 → sub-save → 重拉列表 */
  protected async save(): Promise<void> {
    const api = pomApi();
    if (!api?.booksourceSubSave) {
      this.toast.error('IPC 不可用');
      return;
    }
    const f = this.editing();
    if (!f || !this.canSave()) return;
    const isNew = f.id === '';
    const item: BookSourceSubscription = {
      ...f,
      name: f.name.trim(),
      url: f.url.trim(),
      intervalHours: Math.max(1, Math.floor(f.intervalHours) || DEFAULT_INTERVAL_HOURS),
    };
    this.saving.set(true);
    try {
      await api.booksourceSubSave(item);
      this.toast.success(`${isNew ? '已新增' : '已保存'}订阅：${item.name}`);
      this.editing.set(null);
      await this.load();
    } catch (e) {
      this.toast.error(`保存失败：${errMsg(e)}`);
    } finally {
      this.saving.set(false);
    }
  }

  /** 删除：二次确认 → sub-delete → 重拉列表 */
  protected confirmDelete(sub: BookSourceSubscription): void {
    this.modal.confirm({
      nzTitle: `删除订阅：${sub.name}？`,
      nzContent: '仅删除订阅本身，已通过该订阅导入的书源不受影响。',
      nzOkText: '删除',
      nzOkDanger: true,
      nzCancelText: '取消',
      nzOnOk: async () => {
        const api = pomApi();
        if (!api?.booksourceSubDelete) {
          this.toast.error('IPC 不可用');
          return;
        }
        try {
          await api.booksourceSubDelete(sub.id);
          this.toast.success(`已删除订阅：${sub.name}`);
          await this.load();
        } catch (e) {
          this.toast.error(`删除失败：${errMsg(e)}`);
        }
      },
    });
  }

  /** 立即检查：toast 本次 { changed, conflicts, error }；conflicts 只提示不做解决 UI */
  protected async checkNow(sub: BookSourceSubscription): Promise<void> {
    const api = pomApi();
    if (!api?.booksourceSubCheck) {
      this.toast.error('IPC 不可用');
      return;
    }
    this.checkingId.set(sub.id);
    try {
      const r = await api.booksourceSubCheck(sub.id);
      if (r.error !== null) {
        this.toast.error(`订阅《${sub.name}》检查失败：${r.error}`);
      } else if (r.conflicts > 0) {
        this.toast.warn(
          `订阅《${sub.name}》更新 ${r.changed} 条，${r.conflicts} 条与本地修改冲突，已跳过自动写入`,
        );
      } else if (r.changed > 0) {
        this.toast.success(`订阅《${sub.name}》已更新 ${r.changed} 个书源`);
      } else {
        this.toast.info(`订阅《${sub.name}》已是最新`);
      }
      // 重拉刷新 lastCheckedAt / lastError 列
      await this.load();
    } catch (e) {
      this.toast.error(`订阅《${sub.name}》检查失败：${errMsg(e)}`);
    } finally {
      this.checkingId.set(null);
    }
  }

  /** 启用开关：复用 save 通道；失败 toast 后重拉纠正开关回弹 */
  protected async setEnabled(sub: BookSourceSubscription, next: boolean): Promise<void> {
    const api = pomApi();
    if (!api?.booksourceSubSave) {
      this.toast.error('IPC 不可用');
      return;
    }
    try {
      await api.booksourceSubSave({ ...sub, enabled: next });
      this.items.update((arr) => arr.map((s) => (s.id === sub.id ? { ...s, enabled: next } : s)));
    } catch (e) {
      this.toast.error(`操作失败：${errMsg(e)}`);
      await this.load();
    }
  }

  /** 上次检查列：null → 从未 */
  protected formatTs(ts: number | null): string {
    return ts === null ? '从未' : new Date(ts).toLocaleString();
  }

  /** 下次检查列：停用 → —；从未成功 → 下一跳（启动后 60s / 30 分钟一跳，设计 §6.3） */
  protected nextCheckText(sub: BookSourceSubscription): string {
    if (!sub.enabled) return '—';
    if (sub.lastCheckedAt === null) return '下一调度跳';
    return new Date(sub.lastCheckedAt + sub.intervalHours * 3600_000).toLocaleString();
  }

  protected close(): void {
    this.modalRef?.close();
  }
}
