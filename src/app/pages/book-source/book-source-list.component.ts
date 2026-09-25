import { Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { NzSwitchModule } from 'ng-zorro-antd/switch';
import { NzTagModule } from 'ng-zorro-antd/tag';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzModalModule, NzModalService } from 'ng-zorro-antd/modal';
import { NzEmptyModule } from 'ng-zorro-antd/empty';
import { PageHeaderComponent } from '../../shared/components/page-header/page-header.component';
import { ToastService } from '../../core/services/toast.service';
import { BookSourceMeta } from '../../core/book-source/js-source/source-meta.types';

/** PomAPI 子集（全局 Window.pomAPI 在 page-fetcher.service.ts 声明）。 */
type PomBooksourceAdmin = {
  booksourceList?: () => Promise<BookSourceMeta[]>;
  booksourceToggle?: (fileName: string, enabled: boolean, sourceDir?: string) => Promise<void>;
  booksourceDelete?: (fileName: string, sourceDir?: string) => Promise<void>;
};

function pomApi(): PomBooksourceAdmin | null {
  if (typeof window === 'undefined') return null;
  return (window.pomAPI as unknown as PomBooksourceAdmin | undefined) ?? null;
}

/**
 * 书源管理列表页（实施计划 T-005）
 * - 拉取全部书源元数据，本地过滤
 * - 启停 / 编辑 / 删除（删除二次确认）
 * - 启停调 pomAPI.booksourceToggle，失败回滚 UI（DM-3）
 */
@Component({
  selector: 'app-book-source-list',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    NzButtonModule,
    NzIconModule,
    NzSwitchModule,
    NzTagModule,
    NzInputModule,
    NzModalModule,
    NzEmptyModule,
    PageHeaderComponent,
  ],
  templateUrl: './book-source-list.component.html',
  styleUrl: './book-source-list.component.scss',
})
export class BookSourceListComponent {
  filter = '';
  readonly loading = signal(false);
  readonly sources = signal<BookSourceMeta[]>([]);

  readonly filtered = computed<BookSourceMeta[]>(() => {
    const q = this.filter.trim().toLowerCase();
    const all = this.sources();
    if (!q) return all;
    return all.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        (s.author ?? '').toLowerCase().includes(q) ||
        s.tags.some((t) => t.toLowerCase().includes(q)),
    );
  });

  private readonly toast = inject(ToastService);
  private readonly modal = inject(NzModalService);
  private readonly router = inject(Router);

  constructor() {
    void this.load();
  }

  /** 拉取全量书源元数据 */
  async load(): Promise<void> {
    const api = pomApi();
    if (!api?.booksourceList) {
      this.toast.error('IPC 不可用（浏览器降级或 preload 未加载）');
      return;
    }
    this.loading.set(true);
    try {
      const list = await api.booksourceList();
      this.sources.set(Array.isArray(list) ? list : []);
    } catch (e) {
      this.toast.error(`加载失败：${(e as Error).message}`);
    } finally {
      this.loading.set(false);
    }
  }

  /** 启停切换：失败回滚 UI */
  async toggle(src: BookSourceMeta, next: boolean): Promise<void> {
    const api = pomApi();
    if (!api?.booksourceToggle) {
      this.toast.error('IPC 不可用');
      return;
    }
    const prev = src.enabled;
    this.patch(src, { enabled: next });
    try {
      await api.booksourceToggle(src.fileName, next, src.sourceDir);
      this.toast.success(`${next ? '启用' : '禁用'}：${src.name}`);
    } catch (e) {
      this.patch(src, { enabled: prev });
      this.toast.error(`操作失败：${(e as Error).message}`);
    }
  }

  /** 二次确认后删除；本地列表同步移除 */
  confirmDelete(src: BookSourceMeta): void {
    this.modal.confirm({
      nzTitle: `删除书源：${src.name}？`,
      nzContent: '删除后无法恢复，需重新导入。',
      nzOkText: '删除',
      nzOkDanger: true,
      nzCancelText: '取消',
      nzOnOk: async () => {
        const api = pomApi();
        if (!api?.booksourceDelete) {
          this.toast.error('IPC 不可用');
          return;
        }
        try {
          await api.booksourceDelete(src.fileName, src.sourceDir);
          this.sources.update((arr) => arr.filter((s) => s.fileName !== src.fileName));
          this.toast.success(`已删除：${src.name}`);
        } catch (e) {
          this.toast.error(`删除失败：${(e as Error).message}`);
        }
      },
    });
  }

  /** 跳转编辑器：新建（无参）或编辑（带 fileName） */
  openEditor(src?: BookSourceMeta): void {
    const path = src
      ? `/book-sources/edit/${encodeURIComponent(src.fileName)}`
      : '/book-sources/edit';
    void this.router.navigateByUrl(path);
  }

  /** 不可变更新单个条目 */
  private patch(src: BookSourceMeta, change: Partial<BookSourceMeta>): void {
    this.sources.update((arr) =>
      arr.map((s) => (s.fileName === src.fileName ? { ...s, ...change } : s)),
    );
  }
}