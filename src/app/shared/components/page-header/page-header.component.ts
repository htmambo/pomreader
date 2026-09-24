import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { NzTagModule } from 'ng-zorro-antd/tag';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { ThemeService } from '../../../core/services/theme.service';

/**
 * PageHeader — 顶部 3 标签 + 主题切换
 * 与原 vendor 一致：当前版本 / 官方 QQ 群 / 追求极致，开心就好
 * + 右侧主题切换按钮
 */
@Component({
  selector: 'app-page-header',
  standalone: true,
  imports: [CommonModule, NzTagModule, NzButtonModule, NzIconModule],
  template: `
    <div class="page-header">
      <div class="tags">
        <nz-tag nzColor="default">当前版本: 1.0.6 内部测试</nz-tag>
        <nz-tag nzColor="default">官方QQ群：613536760</nz-tag>
        <nz-tag nzColor="default">追求极致，开心就好！</nz-tag>
      </div>
      <div class="actions">
        <button
          nz-button
          nzType="text"
          (click)="theme.toggleMode()"
          [attr.aria-label]="theme.mode() === 'dark' ? '切换到亮色' : '切换到暗色'"
        >
          <span nz-icon [nzType]="theme.mode() === 'dark' ? 'sun' : 'moon'"></span>
          {{ theme.mode() === 'dark' ? '亮色' : '暗色' }}
        </button>
      </div>
    </div>
  `,
  styles: [
    `
      .page-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 16px;
      }
      .tags {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }
      .actions {
        display: flex;
        gap: 8px;
      }
    `,
  ],
})
export class PageHeaderComponent {
  protected readonly theme = inject(ThemeService);
}