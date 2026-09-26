import { Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzModalModule, NzModalService } from 'ng-zorro-antd/modal';
import { NzRadioModule } from 'ng-zorro-antd/radio';
import { NzSpinModule } from 'ng-zorro-antd/spin';
import { CoverService } from '../../core/cover/cover.service';
import { SettingsService } from '../../core/services/settings.service';
import { BookshelfSort } from '../../core/models/settings.model';
import { ToastService } from '../../core/services/toast.service';
import { PageHeaderComponent } from '../../shared/components/page-header/page-header.component';

/**
 * CacheSettingsComponent — 设置页（书架排序 + 封面缓存管理）
 * 排序规则改动即时生效：SettingsService signal → bookshelf sortedBooks computed
 */
@Component({
  selector: 'app-cache-settings',
  standalone: true,
  imports: [CommonModule, FormsModule, NzButtonModule, NzIconModule, NzInputModule, NzModalModule, NzRadioModule, NzSpinModule, PageHeaderComponent],
  templateUrl: './cache-settings.component.html',
  styleUrls: ['./cache-settings.component.scss'],
})
export class CacheSettingsComponent {
  private cover = inject(CoverService);
  private modal = inject(NzModalService);
  private toast = inject(ToastService);
  private settingsService = inject(SettingsService);

  loading = signal(false);
  size = signal(0);

  /** 抓取 UA 输入框值（'' = 平台默认；placeholder 显示当前生效的默认 UA） */
  fetchUa = '';
  defaultUa = '';

  ngOnInit() {
    void this.refresh();
    // 从主进程读当前生效 UA 与默认值（渲染端 localStorage 只存自定义值）
    void window.pomAPI?.getFetchUA?.().then((r) => {
      this.defaultUa = r.defaultUa;
      this.fetchUa = this.settingsService.settings().fetchUa;
    });
  }

  /** 保存自定义 UA：持久化到设置 + 推送主进程立即全应用生效 */
  async saveFetchUa(): Promise<void> {
    const v = this.fetchUa.trim();
    try {
      const r = await window.pomAPI?.setFetchUA?.(v || null);
      this.settingsService.update('fetchUa', v);
      this.toast.success(`抓取 UA 已更新：${r?.ua ?? v}`);
    } catch (e) {
      this.toast.error(`UA 保存失败：${(e as Error).message}`);
    }
  }

  /** 恢复平台默认 UA */
  async resetFetchUa(): Promise<void> {
    this.fetchUa = '';
    await this.saveFetchUa();
  }

  /** 书架排序当前值（模板双向绑定用 getter/setter 直通 SettingsService） */
  get bookshelfSort(): BookshelfSort {
    return this.settingsService.settings().bookshelfSort;
  }
  set bookshelfSort(v: BookshelfSort) {
    this.settingsService.update('bookshelfSort', v);
    this.toast.success('书架排序已更新');
  }

  /** 重新读取缓存大小 */
  async refresh(): Promise<void> {
    this.loading.set(true);
    try {
      this.size.set(await this.cover.size());
    } catch (e) {
      this.toast.error(`读取缓存大小失败: ${(e as Error).message}`);
    } finally {
      this.loading.set(false);
    }
  }

  /** 字节 → 人类可读（B / KB / MB / GB） */
  formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }

  /** 二次确认 + 清理 */
  clearCache(): void {
    this.modal.confirm({
      nzTitle: '确认清理封面缓存？',
      nzContent: `当前缓存大小：${this.formatSize(this.size())}。清理后已下载封面需重新下载。`,
      nzOkText: '清理',
      nzOkDanger: true,
      nzCancelText: '取消',
      nzOnOk: async () => {
        this.loading.set(true);
        try {
          const freed = await this.cover.clear();
          this.size.set(0);
          this.toast.success(`已清理 ${this.formatSize(freed)}`);
        } catch (e) {
          this.toast.error(`清理失败: ${(e as Error).message}`);
        } finally {
          this.loading.set(false);
        }
      },
    });
  }
}