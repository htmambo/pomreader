import { ChangeDetectionStrategy, Component, computed, effect, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzSwitchModule } from 'ng-zorro-antd/switch';
import { NzTagModule } from 'ng-zorro-antd/tag';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzModalModule, NzModalService } from 'ng-zorro-antd/modal';
import { NzEmptyModule } from 'ng-zorro-antd/empty';
import { NzSpinModule } from 'ng-zorro-antd/spin';
import { PageHeaderService } from '../../core/services/page-header.service';
import { ToastService } from '../../core/services/toast.service';
import { type BookSourceMeta } from '../../core/book-source/js-source/source-meta.types';
import { BookSourceListStateService } from '../../core/book-source/book-source-list-state.service';
import { ImportLegadoComponent } from '../../modals/import-legado/import-legado.component';

/**
 * 书源管理列表页（实施计划 T-005）
 * - 拉取全部书源元数据，本地过滤
 * - 启停 / 编辑 / 删除（删除二次确认）
 * - 启停调 pomAPI.booksourceToggle，失败回滚 UI（DM-3）
 *
 * 会话级现场由 BookSourceListStateService 持有（root）：过滤词/列表，
 * 路由切走再回来直接展示；后台再走一次 IPC 同步磁盘真实状态
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-book-source-list',
  imports: [
    CommonModule,
    FormsModule,
    NzButtonModule,
    NzSwitchModule,
    NzTagModule,
    NzInputModule,
    NzModalModule,
    NzEmptyModule,
    NzSpinModule,
  ],
  templateUrl: './book-source-list.component.html',
  styleUrl: './book-source-list.component.scss',
})
export class BookSourceListComponent {
  readonly state = inject(BookSourceListStateService);
  private readonly toast = inject(ToastService);
  private readonly modal = inject(NzModalService);
  private readonly router = inject(Router);
  private readonly pageHeader = inject(PageHeaderService);

  /** 是否还在首次加载（首次成功前显示 spinner，已加载过则走后台刷新不阻塞） */
  readonly firstLoading = computed(() => !this.state.loaded());

  readonly filtered = computed<BookSourceMeta[]>(() => {
    const q = this.state.filter().trim().toLowerCase();
    const all = this.state.sources();
    if (!q) return all;
    return all.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        (s.author ?? '').toLowerCase().includes(q) ||
        s.tags.some((t) => t.toLowerCase().includes(q)),
    );
  });

  constructor() {
    // stale-while-revalidate：已加载过则后台静默刷新，未加载过则首次带 loading 拉取
    if (this.state.loaded()) {
      void this.refresh(false);
    } else {
      void this.refresh(true);
    }
    // 副标题随 sources 数量变化 —— 「共 N 个书源」由本组件单独维护
    // allowSignalWrites:这是 effect 写 signal 的明确逃生口 —— 两个 signal 不同源,不会形成循环
    effect(
      () => {
        this.pageHeader.subtitle.set(`共 ${this.state.sources().length} 个书源`);
      },
      { allowSignalWrites: true },
    );
  }

  /** 拉取全量书源元数据（showLoading=false 时走后台静默刷新，不阻塞 UI） */
  async refresh(showLoading: boolean): Promise<void> {
    try {
      await this.state.refresh(showLoading);
    } catch (e) {
      this.toast.error(`加载失败：${(e as Error).message}`);
    }
  }

  /** 启停切换：失败由 state 服务回滚 UI */
  async toggle(src: BookSourceMeta, next: boolean): Promise<void> {
    try {
      await this.state.toggle(src, next);
      this.toast.success(`${next ? '启用' : '禁用'}：${src.name}`);
    } catch (e) {
      this.toast.error(`操作失败：${(e as Error).message}`);
    }
  }

  /** 二次确认后删除；本地列表同步移除（state.remove 内部完成） */
  confirmDelete(src: BookSourceMeta): void {
    this.modal.confirm({
      nzTitle: `删除书源：${src.name}？`,
      nzContent: '删除后无法恢复，需重新导入。',
      nzOkText: '删除',
      nzOkDanger: true,
      nzCancelText: '取消',
      nzOnOk: async () => {
        try {
          await this.state.remove(src);
          this.toast.success(`已删除：${src.name}`);
        } catch (e) {
          this.toast.error(`删除失败：${(e as Error).message}`);
        }
      },
    });
  }

  /** 跳转编辑器（编辑现有书源） */
  openEditor(src: BookSourceMeta): void {
    void this.router.navigateByUrl(`/book-sources/edit/${encodeURIComponent(src.fileName)}`);
  }

  /** 跳转智能添加页（输入 URL → 启发式探测 → 规则面板 → 生成书源） */
  openSmartAdd(): void {
    void this.router.navigateByUrl('/book-sources/smart-add');
  }

  /** 跳转调试书源页（?source=fileName 预选 —— 调试页 load 时读 queryParam 预填选中项） */
  openDebug(src: BookSourceMeta): void {
    void this.router.navigate(['/book-sources/debug'], { queryParams: { source: src.fileName } });
  }

  /** 打开 Legado 订阅源导入弹窗；导入完成后刷新列表 */
  openLegadoImport(): void {
    this.modal.create({
      nzTitle: '导入 Legado 订阅源',
      nzContent: ImportLegadoComponent,
      nzData: { onImported: () => void this.refresh(false) },
      nzFooter: null,
      nzWidth: 640,
      nzMaskClosable: false,
    });
  }
}
