import {
  Component,
  ChangeDetectionStrategy,
  computed,
  inject,
  type OnInit,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { NzGridModule } from 'ng-zorro-antd/grid';
import { NzEmptyModule } from 'ng-zorro-antd/empty';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { NzModalService } from 'ng-zorro-antd/modal';
import { NzMessageService } from 'ng-zorro-antd/message';
import { BookService } from '../../core/services/book.service';
import { SettingsService } from '../../core/services/settings.service';
import { ToastService } from '../../core/services/toast.service';
import { CoverService } from '../../core/cover/cover.service';
import { BookCardComponent } from '../../shared/components/book-card/book-card.component';
import { type Book } from '../../core/models/book.model';
import { sortBooks } from '../../core/logic/bookshelf-sort';
import { CoverGeneratorDialogComponent } from '../../shared/components/cover-generator-dialog/cover-generator-dialog.component';
import {
  EditBookInfoDialogComponent,
  type EditBookInfoResult,
} from '../../shared/components/edit-book-info-dialog/edit-book-info-dialog.component';
import { ChangeBookSourceDialogComponent } from '../../shared/components/change-book-source-dialog/change-book-source-dialog.component';

@Component({
  selector: 'app-bookshelf',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    NzGridModule,
    NzEmptyModule,
    NzButtonModule,
    NzIconModule,
    BookCardComponent,
  ],
  templateUrl: './bookshelf.component.html',
  preserveWhitespaces: true,
  styles: [
    `
      .batch-bar {
        position: fixed;
        bottom: 24px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 1000;
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 10px 16px;
        border-radius: 8px;
        background: var(--pom-card);
        border: 1px solid var(--pom-border);
        box-shadow: 0 6px 24px rgba(0, 0, 0, 0.25);
        white-space: nowrap;
      }
      .batch-count {
        font-size: 13px;
        color: var(--pom-text-muted);
        margin-right: 4px;
      }
    `,
  ],
})
export class BookshelfComponent implements OnInit {
  private readonly bookService = inject(BookService);
  private readonly settings = inject(SettingsService);
  private readonly modal = inject(NzModalService);
  private readonly toast = inject(ToastService);
  private readonly cover = inject(CoverService);
  /** 直接使用 NzMessageService 的 loading toast（可关闭）；ToastService 仅封装了 void 方法 */
  private readonly nzMessage = inject(NzMessageService);
  readonly books = this.bookService.books;

  /** 按设置页的 bookshelfSort 规则排序后的展示列表（纯函数，响应设置/书籍双 signal） */
  readonly sortedBooks = computed(() =>
    sortBooks(this.books(), this.settings.settings().bookshelfSort),
  );

  /** 多选模式：长按封面进入，底部浮动操作栏随之显示 */
  readonly selectMode = signal(false);
  readonly selectedIds = signal<Set<string>>(new Set());
  readonly selectedCount = computed(() => this.selectedIds().size);
  readonly allSelected = computed(
    () => this.sortedBooks().length > 0 && this.selectedCount() === this.sortedBooks().length,
  );
  /** 批量任务进行中：禁用操作按钮，防止重复触发 */
  readonly batchRunning = signal(false);

  ngOnInit(): void {
    if (this.books().length === 0) {
      this.bookService.load();
    }
  }

  /** BookCard 长按事件 → 进入多选模式并选中该书 */
  onCardLongPress(book: Book): void {
    if (this.selectMode()) return;
    this.selectMode.set(true);
    this.selectedIds.set(new Set([book.id]));
  }

  /** 多选模式下点击封面 → 切换选中；清空后自动退出多选模式 */
  toggleSelect(book: Book): void {
    this.selectedIds.update((prev) => {
      const next = new Set(prev);
      if (next.has(book.id)) {
        next.delete(book.id);
      } else {
        next.add(book.id);
      }
      return next;
    });
    if (this.selectedCount() === 0) {
      this.exitSelectMode();
    }
  }

  /** 全选；已全选时切换为全不选 */
  selectAll(): void {
    if (this.allSelected()) {
      this.selectedIds.set(new Set());
    } else {
      this.selectedIds.set(new Set(this.sortedBooks().map((b) => b.id)));
    }
  }

  /** 反选 */
  invertSelection(): void {
    const current = this.selectedIds();
    this.selectedIds.set(
      new Set(
        this.sortedBooks()
          .filter((b) => !current.has(b.id))
          .map((b) => b.id),
      ),
    );
  }

  exitSelectMode(): void {
    this.selectedIds.set(new Set());
    this.selectMode.set(false);
  }

  /** 当前选中的书（按书架顺序） */
  private selectedBooks(): Book[] {
    const ids = this.selectedIds();
    return this.sortedBooks().filter((b) => ids.has(b.id));
  }

  /** 批量删除：一次确认框（含数量），确认后逐本删除 */
  batchDelete(): void {
    const targets = this.selectedBooks();
    if (targets.length === 0) return;
    this.modal.confirm({
      nzTitle: `从书架移除 ${targets.length} 本书？`,
      nzContent: '将只从书架移除，不会删除已下载章节。',
      nzOkText: '移除',
      nzOkDanger: true,
      nzCancelText: '取消',
      nzOnOk: async () => {
        for (const book of targets) {
          await this.bookService.deleteBook(book.id);
        }
        this.exitSelectMode();
        this.toast.success(`已移除 ${targets.length} 本书`);
      },
    });
  }

  /**
   * 批量更新最新章节：仅对 online 书执行，其余跳过并统计
   * 串行逐本拉取（避免并发打满源站），loading toast 全程展示进度
   */
  async batchRefreshChapters(): Promise<void> {
    const targets = this.selectedBooks();
    const online = targets.filter((b) => b.source === 'online');
    const skipped = targets.length - online.length;
    if (online.length === 0) {
      this.toast.warn('选中项没有可更新的在线书籍');
      return;
    }

    this.batchRunning.set(true);
    const inflight = this.nzMessage.loading(`正在更新章节（0/${online.length}）...`, {
      nzDuration: 0,
    });
    let succeeded = 0;
    let failed = 0;
    let addedTotal = 0;
    try {
      for (let i = 0; i < online.length; i++) {
        this.nzMessage.remove(inflight.messageId);
        const progress = this.nzMessage.loading(
          `正在更新章节（${i + 1}/${online.length}）：${online[i].title}`,
          { nzDuration: 0 },
        );
        try {
          const result = await this.bookService.refreshChapters(online[i].id);
          addedTotal += result.added;
          succeeded++;
        } catch {
          failed++;
        } finally {
          this.nzMessage.remove(progress.messageId);
        }
      }
    } finally {
      this.batchRunning.set(false);
    }
    this.exitSelectMode();
    this.reportBatch('章节更新完成', succeeded, skipped, failed, `，共新增 ${addedTotal} 章`);
  }

  /**
   * 批量更新作品信息：仅对 online 书执行（元数据 + 封面）
   * 元数据走 BookService.refreshBookInfo；http(s) 封面再走 CoverService 刷新缓存并写回
   */
  async batchUpdateBookInfo(): Promise<void> {
    const targets = this.selectedBooks();
    const online = targets.filter((b) => b.source === 'online');
    const skipped = targets.length - online.length;
    if (online.length === 0) {
      this.toast.warn('选中项没有可更新的在线书籍');
      return;
    }

    this.batchRunning.set(true);
    let succeeded = 0;
    let failed = 0;
    for (let i = 0; i < online.length; i++) {
      const inflight = this.nzMessage.loading(
        `正在更新作品信息（${i + 1}/${online.length}）：${online[i].title}`,
        { nzDuration: 0 },
      );
      try {
        const updated = await this.bookService.refreshBookInfo(online[i].id);
        const url = updated.coverImageUrl ?? '';
        if (url.startsWith('http://') || url.startsWith('https://')) {
          try {
            const localRef = await this.cover.resolve(url);
            if (localRef !== url) {
              await this.bookService.addBook({ ...updated, coverImageUrl: localRef }, []);
            }
          } catch {
            // 封面刷新失败不阻断元数据更新结果
          }
        }
        succeeded++;
      } catch {
        failed++;
      } finally {
        this.nzMessage.remove(inflight.messageId);
      }
    }
    this.batchRunning.set(false);
    this.exitSelectMode();
    this.reportBatch('作品信息更新完成', succeeded, skipped, failed, '');
  }

  /** 批量结果统一汇报：成功 N 本，跳过 M 本非在线书，失败 K 本 */
  private reportBatch(
    title: string,
    succeeded: number,
    skipped: number,
    failed: number,
    extra: string,
  ): void {
    const parts = [`成功 ${succeeded} 本${extra}`];
    if (skipped > 0) parts.push(`跳过 ${skipped} 本非在线书`);
    if (failed > 0) parts.push(`失败 ${failed} 本`);
    const text = `${title}：${parts.join('，')}`;
    if (failed > 0) {
      this.toast.warn(text);
    } else {
      this.toast.success(text);
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
