import { Component, ChangeDetectionStrategy, inject, signal } from '@angular/core';

import { FormsModule } from '@angular/forms';
import { NZ_MODAL_DATA } from 'ng-zorro-antd/modal';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { NzEmptyModule } from 'ng-zorro-antd/empty';
import { type Book } from '../../../core/models/book.model';
import { BookService } from '../../../core/services/book.service';
import { BookshelfGroupService } from '../../../core/services/bookshelf-group.service';
import { ToastService } from '../../../core/services/toast.service';

interface BookGroupDialogData {
  /** 待归类的书：单本（右键菜单）或批量（书架多选栏） */
  books: Book[];
}

/**
 * 归类弹窗（modal 内容组件）
 *
 * 入口：
 * - 书卡右键菜单「分类…」（单本）
 * - 书架多选操作栏「分类」（批量）
 *
 * 语义：**替换** —— 确认后所选书籍的 groupIds 整体替换为勾选项（取消勾选即移出该分类）。
 * 批量时初值取所有选中书籍 groupIds 的交集：交集内的分类默认勾选，用户取消即批量移出。
 *
 * 支持就地新建分类：输入框 + 「新建」→ BookshelfGroupService.create 后自动勾选。
 * 分类本身由 service 的 signal 驱动，弹窗内新增后列表立即出现。
 */
@Component({
  selector: 'app-book-group-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, NzInputModule, NzButtonModule, NzIconModule, NzEmptyModule],
  template: `
    <div class="bg-dialog">
      <div class="hint">
        <span nz-icon nzType="info-circle"></span>
        {{ hint }}
      </div>

      @if (groups().length === 0) {
        <nz-empty nzNotFoundContent="还没有分类，先在下方新建一个"></nz-empty>
      } @else {
        <ul class="group-list">
          @for (g of groups(); track g.id) {
            <li>
              <label class="group-row">
                <input type="checkbox" [checked]="selected().has(g.id)" (change)="toggle(g.id)" />
                <span class="name">{{ g.name }}</span>
                <span class="count">{{ countOf(g.id) }}</span>
              </label>
            </li>
          }
        </ul>
      }

      <div class="create-row">
        <input
          nz-input
          placeholder="新分类名（≤12 字）"
          [ngModel]="newName()"
          (ngModelChange)="newName.set($event)"
          (keyup.enter)="createGroup()"
        />
        <button nz-button nzType="dashed" (click)="createGroup()">
          <span nz-icon nzType="plus"></span> 新建
        </button>
      </div>
    </div>
  `,
  styles: [
    `
      .hint {
        display: flex;
        align-items: center;
        gap: 6px;
        color: var(--pom-text-muted);
        font-size: 13px;
        margin-bottom: 12px;
      }
      .group-list {
        list-style: none;
        margin: 0 0 12px;
        padding: 0;
        max-height: 240px;
        overflow-y: auto;
      }
      .group-row {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 8px 10px;
        border-radius: 8px;
        cursor: pointer;
      }
      .group-row:hover {
        background: var(--pom-card);
      }
      .name {
        flex: 1;
        color: var(--pom-text);
      }
      .count {
        color: var(--pom-text-muted);
        font-size: 12px;
      }
      .create-row {
        display: flex;
        gap: 8px;
        padding-top: 12px;
        border-top: 1px solid var(--pom-border);
      }
    `,
  ],
})
export class BookGroupDialogComponent {
  private readonly data = inject<BookGroupDialogData>(NZ_MODAL_DATA);
  private readonly bookService = inject(BookService);
  private readonly groupService = inject(BookshelfGroupService);
  private readonly toast = inject(ToastService);

  readonly groups = this.groupService.groups;
  readonly books = this.data.books;
  readonly selected = signal<Set<string>>(new Set(this.initialSelection()));
  readonly newName = signal('');

  readonly hint: string =
    this.books.length === 1
      ? `为《${this.books[0].title}》选择分类（可多选）`
      : `为选中的 ${this.books.length} 本书设置分类（勾选项将替换原有分类）`;

  /** 单本取其归属；批量取交集 */
  private initialSelection(): string[] {
    const sets = this.books.map((b) => b.groupIds ?? []);
    if (sets.length === 0) return [];
    return sets.reduce((acc, cur) => acc.filter((id) => cur.includes(id)));
  }

  countOf(groupId: string): number {
    return this.bookService.books().filter((b) => (b.groupIds ?? []).includes(groupId)).length;
  }

  toggle(groupId: string): void {
    this.selected.update((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  }

  async createGroup(): Promise<void> {
    const name = this.newName().trim();
    if (!name) return;
    try {
      const group = await this.groupService.create(name);
      this.newName.set('');
      this.selected.update((prev) => new Set(prev).add(group.id));
      this.toast.success(`已新建分类「${group.name}」`);
    } catch (e) {
      this.toast.error((e as Error).message);
    }
  }

  /** nzOnOk 入口：逐本落库；任一本失败保持弹窗打开（返回 false） */
  async confirm(): Promise<boolean> {
    const ids = [...this.selected()];
    try {
      for (const book of this.books) {
        await this.bookService.updateBookGroups(book.id, ids);
      }
    } catch (e) {
      this.toast.error(`归类失败：${(e as Error).message}`);
      return false;
    }
    this.toast.success(
      this.books.length === 1
        ? `已更新《${this.books[0].title}》的分类`
        : `已更新 ${this.books.length} 本书的分类`,
    );
    return true;
  }
}
