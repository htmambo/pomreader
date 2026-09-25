import { Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { NzSwitchModule } from 'ng-zorro-antd/switch';
import { NzTagModule } from 'ng-zorro-antd/tag';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { NzEmptyModule } from 'ng-zorro-antd/empty';
import { NzSpinModule } from 'ng-zorro-antd/spin';
import { PageHeaderComponent } from '../../shared/components/page-header/page-header.component';
import { ToastService } from '../../core/services/toast.service';
import { ExtensionService } from '../../core/extension/extension.service';
import { ExtensionMeta } from '../../core/extension/extension.types';

/**
 * 扩展管理列表页（实施计划 T-010 + spec FR-4）
 *
 * - 列出 `<userData>/extensions/` 下全部 UserScript
 * - 启停开关：v1 仅 UI 状态切换（后端持久化走 T-003 IPC handler；本任务保持 UI 一致即可）
 * - 点击卡片查看匹配模式 / 权限 / 运行时机等元数据
 */
@Component({
  selector: 'app-extension-list',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    NzSwitchModule,
    NzTagModule,
    NzIconModule,
    NzEmptyModule,
    NzSpinModule,
    PageHeaderComponent,
  ],
  templateUrl: './extension-list.component.html',
  styleUrl: './extension-list.component.scss',
})
export class ExtensionListComponent {
  readonly extensions = signal<ExtensionMeta[]>([]);
  readonly loading = signal(true);

  private readonly extService = inject(ExtensionService);
  private readonly toast = inject(ToastService);

  constructor() {
    void this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    try {
      this.extensions.set(await this.extService.list());
    } catch (e) {
      this.toast.error(`加载失败: ${(e as Error).message}`);
      this.extensions.set([]);
    } finally {
      this.loading.set(false);
    }
  }

  /** v1 仅 UI 状态切换；后端启停由 IPC handler 处理 */
  onToggle(ext: ExtensionMeta, enabled: boolean): void {
    ext.enabled = enabled;
    this.toast.success(`${enabled ? '启用' : '禁用'}：${ext.name}`);
  }
}