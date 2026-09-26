import { Component, computed, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { NzGridModule } from 'ng-zorro-antd/grid';
import { NzEmptyModule } from 'ng-zorro-antd/empty';
import { NzModalModule, NzModalService } from 'ng-zorro-antd/modal';
import { NzMessageService } from 'ng-zorro-antd/message';
import { BookService } from '../../core/services/book.service';
import { SettingsService } from '../../core/services/settings.service';
import { ToastService } from '../../core/services/toast.service';
import { BookCardComponent } from '../../shared/components/book-card/book-card.component';
import { Book } from '../../core/models/book.model';
import { sortBooks } from '../../core/logic/bookshelf-sort';
import { CoverGeneratorDialogComponent } from '../../shared/components/cover-generator-dialog/cover-generator-dialog.component';
import {
  EditBookInfoDialogComponent,
  EditBookInfoResult,
} from '../../shared/components/edit-book-info-dialog/edit-book-info-dialog.component';
import { ChangeBookSourceDialogComponent } from '../../shared/components/change-book-source-dialog/change-book-source-dialog.component';

@Component({
  selector: 'app-bookshelf',
  standalone: true,
  imports: [CommonModule, NzGridModule, NzEmptyModule, BookCardComponent],
  template: `
    @if (sortedBooks().length > 0) {
      <div nz-row [nzGutter]="[16, 16]">
        @for (book of sortedBooks(); track book.id) {
          <div nz-col nzXs="12" nzSm="8" nzMd="6" nzLg="4" nzXl="3">
            <app-book-card
              [book]="book"
              (remove)="onRemove(book)"
              (generateCover)="onGenerateCover(book)"
              (editInfo)="onEditInfo(book)"
              (changeSource)="onChangeSource(book)"
              (refreshChapters)="onRefreshChapters(book)"
            ></app-book-card>
          </div>
        }
      </div>
    } @else {
      <nz-empty nzNotFoundContent="书架暂无书籍"></nz-empty>
    }
  `,
})
export class BookshelfComponent implements OnInit {
  private readonly bookService = inject(BookService);
  private readonly settings = inject(SettingsService);
  private readonly modal = inject(NzModalService);
  private readonly toast = inject(ToastService);
  /** 直接使用 NzMessageService 的 loading toast（可关闭）；ToastService 仅封装了 void 方法 */
  private readonly nzMessage = inject(NzMessageService);
  readonly books = this.bookService.books;

  /** 按设置页的 bookshelfSort 规则排序后的展示列表（纯函数，响应设置/书籍双 signal） */
  readonly sortedBooks = computed(() =>
    sortBooks(this.books(), this.settings.settings().bookshelfSort),
  );

  ngOnInit(): void {
    if (this.books().length === 0) {
      this.bookService.load();
    }
  }

  /** BookCard 右键菜单删除事件 → 二次确认后调 BookService */
  onRemove(book: Book): void {
    this.modal.confirm({
      nzTitle: '从书架移除？',
      nzContent: `《${book.title}》将只从书架移除，不会删除已下载章节。`,
      nzOkText: '移除',
      nzOkDanger: true,
      nzCancelText: '取消',
      nzOnOk: () => {
        this.bookService.deleteBook(book.id);
        this.toast.success(`已移除：${book.title}`);
      },
    });
  }

  /** BookCard 右键菜单「生成封面」→ 弹 20 款 SVG 模板选择，应用后写回 coverImageUrl */
  onGenerateCover(book: Book): void {
    const ref = this.modal.create({
      nzTitle: `生成封面 — ${book.title}`,
      nzContent: CoverGeneratorDialogComponent,
      nzData: { book },
      nzWidth: 920,
      nzFooter: null, // 子组件点「应用」时自行 close(result)
      nzKeyboard: false,
    });
    ref.afterClose.subscribe((result?: { coverUrl?: string; generatorName?: string }) => {
      if (!result?.coverUrl) return;
      const updated: Book = { ...book, coverImageUrl: result.coverUrl };
      // 复用 addBook：保留原 progress、章节缓存不动（chapters=[]）
      void this.bookService
        .addBook(updated, [])
        .then(() => this.toast.success(`已应用「${result.generatorName}」封面`))
        .catch((e) => this.toast.error(`保存失败：${(e as Error).message}`));
    });
  }

  /** BookCard 右键菜单「编辑书籍信息」→ 与阅读页共用同一 EditBookInfoDialog */
  onEditInfo(book: Book): void {
    this.modal.create({
      nzTitle: '修改书籍信息',
      nzContent: EditBookInfoDialogComponent,
      nzData: { book },
      nzOnOk: async (instance: EditBookInfoDialogComponent) => {
        const patch: EditBookInfoResult | null = instance.result();
        if (!patch) return false; // 校验失败，dialog 保持打开
        const updated: Book = { ...book, ...patch };
        await this.bookService.addBook(updated, []);
        this.toast.success('书籍信息已更新');
        return true;
      },
      nzOkText: '保存',
      nzCancelText: '取消',
      nzWidth: 420,
      nzKeyboard: false,
    });
  }

  /**
   * BookCard 右键菜单「换源」→ 弹 ChangeBookSourceDialog
   * 子组件内部完成解析 + 换源；nzOnOk 校验失败返回 false（dialog 保持打开）
   */
  onChangeSource(book: Book): void {
    this.modal.create({
      nzTitle: `换源：${book.title}`,
      nzContent: ChangeBookSourceDialogComponent,
      nzData: { book },
      nzOnOk: async (instance: ChangeBookSourceDialogComponent) => {
        return await instance.confirm();
      },
      nzOkText: '确认换源',
      nzCancelText: '取消',
      nzWidth: 560,
      nzKeyboard: false,
    });
  }

  /**
   * BookCard 右键菜单「更新最新章节」→ 直接调 service，无 modal
   * 结果通过 toast 汇报（新增 N 章 / 跳过 M 章 / 失败原因）
   */
  async onRefreshChapters(book: Book): Promise<void> {
    const inflight = this.nzMessage.loading(`正在拉取 ${book.title} 最新章节...`, {
      nzDuration: 0, // 长任务完成前不自动消失
    });
    try {
      const result = await this.bookService.refreshChapters(book.id);
      if (result.added === 0) {
        this.toast.info(`已是最新：${book.title}（共 ${result.total} 章，无变化）`);
      } else {
        this.toast.success(
          `${book.title}：新增 ${result.added} 章（已有 ${result.skipped} 章跳过，共 ${result.total} 章）`,
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.toast.error(`更新失败：${msg}`);
    } finally {
      // NzMessageRef 没有 close()，需用 messageId + NzMessageService.remove 显式清除 loading
      this.nzMessage.remove(inflight.messageId);
    }
  }
}
