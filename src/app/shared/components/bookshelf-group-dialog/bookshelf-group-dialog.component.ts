import { Component, ChangeDetectionStrategy, inject, signal } from '@angular/core';

import { FormsModule } from '@angular/forms';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { NzEmptyModule } from 'ng-zorro-antd/empty';
import { NzModalService } from 'ng-zorro-antd/modal';
import { BookService } from '../../../core/services/book.service';
import { BookshelfGroupService } from '../../../core/services/bookshelf-group.service';
import { ToastService } from '../../../core/services/toast.service';

/**
 * 管理分类弹窗（modal 内容组件）
 *
 * 入口：书架分类 chips 行右侧的齿轮按钮。
 * 功能：新建 / 重命名 / 删除分类，列表实时展示每个分类下的书本数。
 *
 * 所有操作即时落库（service → PouchDB），因此 nzOnOk 的 confirm() 只负责关闭弹窗；
 * 与「编辑书籍信息」等「确认时统一落库」的弹窗不同，这里刻意不做批量提交，
 * 避免用户在长列表里改了一堆之后一次失败全丢。
 */
@Component({
  selector: 'app-bookshelf-group-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, NzInputModule, NzButtonModule, NzIconModule, NzEmptyModule],
  template: `
    <div class="gm-dialog">
      <div class="create-row">
        <input
          nz-input
          placeholder="新分类名（≤12 字）"
          [ngModel]="newName()"
          (ngModelChange)="newName.set($event)"
          (keyup.enter)="createGroup()"
        />
        <button nz-button nzType="primary" nzGhost (click)="createGroup()">
          <span nz-icon nzType="plus"></span> 新建
        </button>
      </div>

      @if (groups().length === 0) {
        <nz-empty nzNotFoundContent="还没有分类，先在上方新建一个"></nz-empty>
      } @else {
        <ul class="gm-list">
          @for (g of groups(); track g.id) {
            <li class="gm-row">
              @if (editingId() === g.id) {
                <input
                  nz-input
                  [ngModel]="editingName()"
                  (ngModelChange)="editingName.set($event)"
                  (keyup.enter)="saveRename(g.id)"
                  (keyup.escape)="cancelRename()"
                />
                <button nz-button nzType="primary" nzSize="small" (click)="saveRename(g.id)">
                  保存
                </button>
                <button nz-button nzSize="small" (click)="cancelRename()">取消</button>
              } @else {
                <span class="name">{{ g.name }}</span>
                <span class="count">{{ countOf(g.id) }} 本</span>
                <!-- 行内图标按钮走裸 button：ng-zorro-overrides 的 .ant-btn-dangerous 强制红底，
                     图标与背景同色会"糊"成色块 -->
                <button
                  type="button"
                  class="row-btn"
                  title="重命名"
                  (click)="startRename(g.id, g.name)"
                >
                  <span nz-icon nzType="edit"></span>
                </button>
                <button
                  type="button"
                  class="row-btn row-btn--danger"
                  title="删除分类"
                  (click)="removeGroup(g.id, g.name)"
                >
                  <span nz-icon nzType="delete"></span>
                </button>
              }
            </li>
          }
        </ul>
      }

      <p class="tip">删除分类不会删除书籍，仅把书从该分类移出。</p>
    </div>
  `,
  styles: [
    `
      .create-row {
        display: flex;
        gap: 8px;
        margin-bottom: 12px;
      }
      .gm-list {
        list-style: none;
        margin: 0;
        padding: 0;
        max-height: 260px;
        overflow-y: auto;
      }
      .gm-row {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 6px 4px;
        border-bottom: 1px solid var(--pom-border);
      }
      .gm-row .name {
        flex: 1;
        color: var(--pom-text);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .gm-row .count {
        color: var(--pom-text-muted);
        font-size: 12px;
      }
      .row-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        padding: 0;
        border: none;
        border-radius: 6px;
        background: transparent;
        color: var(--pom-text-muted);
        cursor: pointer;
        font-size: 14px;
      }
      .row-btn:hover {
        background: var(--pom-bg);
        color: var(--pom-accent);
      }
      .row-btn--danger:hover {
        color: #ff4d4f;
      }
      .tip {
        margin: 12px 0 0;
        color: var(--pom-text-muted);
        font-size: 12px;
      }
    `,
  ],
})
export class BookshelfGroupDialogComponent {
  private readonly groupService = inject(BookshelfGroupService);
  private readonly bookService = inject(BookService);
  private readonly toast = inject(ToastService);
  private readonly modal = inject(NzModalService);

  readonly groups = this.groupService.groups;
  readonly newName = signal('');
  /** 正在重命名的分类 id（null = 非编辑态） */
  readonly editingId = signal<string | null>(null);
  readonly editingName = signal('');

  countOf(groupId: string): number {
    return this.bookService.books().filter((b) => (b.groupIds ?? []).includes(groupId)).length;
  }

  async createGroup(): Promise<void> {
    const name = this.newName().trim();
    if (!name) return;
    try {
      await this.groupService.create(name);
      this.newName.set('');
    } catch (e) {
      this.toast.error((e as Error).message);
    }
  }

  startRename(id: string, name: string): void {
    this.editingId.set(id);
    this.editingName.set(name);
  }

  cancelRename(): void {
    this.editingId.set(null);
    this.editingName.set('');
  }

  async saveRename(id: string): Promise<void> {
    try {
      await this.groupService.rename(id, this.editingName());
      this.cancelRename();
    } catch (e) {
      this.toast.error((e as Error).message);
    }
  }

  /** 删除分类（二次确认）：书籍保留，仅解除归属 */
  removeGroup(id: string, name: string): void {
    this.modal.confirm({
      nzTitle: `删除分类「${name}」？`,
      nzContent: `该分类下的 ${this.countOf(id)} 本书会保留在书架上，仅从分类中移出。`,
      nzOkText: '删除',
      nzOkDanger: true,
      nzCancelText: '取消',
      nzOnOk: async () => {
        try {
          const affected = await this.groupService.remove(id);
          this.toast.success(
            `已删除分类「${name}」${affected > 0 ? `，${affected} 本书已移出` : ''}`,
          );
        } catch (e) {
          this.toast.error(`删除失败：${(e as Error).message}`);
        }
      },
    });
  }

  /** nzOnOk 入口：操作已即时落库，这里只放行关闭 */
  confirm(): boolean {
    return true;
  }
}
