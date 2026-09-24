import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { NzTagModule } from 'ng-zorro-antd/tag';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { NzDropDownModule } from 'ng-zorro-antd/dropdown';
import { NzModalService } from 'ng-zorro-antd/modal';
import { ThemeService } from '../../../core/services/theme.service';
import { ImportOnlineComponent } from '../../../modals/import-online/import-online.component';
import { ImportLocalTxtComponent } from '../../../modals/import-local-txt/import-local-txt.component';

/**
 * PageHeader — 顶部 3 标签 + 主题切换 + 导入按钮
 * 与原 vendor 一致：当前版本 / 官方 QQ 群 / 追求极致，开心就好
 */
@Component({
  selector: 'app-page-header',
  standalone: true,
  imports: [CommonModule, NzTagModule, NzButtonModule, NzIconModule, NzDropDownModule],
  template: `
    <div class="page-header">
      <div class="tags">
        <nz-tag nzColor="default">当前版本: 1.0.6 内部测试</nz-tag>
        <nz-tag nzColor="default">官方QQ群：613536760</nz-tag>
        <nz-tag nzColor="default">追求极致，开心就好！</nz-tag>
      </div>
      <div class="actions">
        <button nz-button nzType="primary" nz-dropdown [nzDropdownMenu]="importMenu" nzTrigger="click">
          <span nz-icon nzType="plus"></span>
          导入
        </button>
        <nz-dropdown-menu #importMenu="nzDropdownMenu">
          <ul nz-menu>
            <li nz-menu-item (click)="openImportOnline()">
              <span nz-icon nzType="link"></span>
              导入在线书页
            </li>
            <li nz-menu-item (click)="openImportLocalTxt()">
              <span nz-icon nzType="file-text"></span>
              导入本地 TXT
            </li>
          </ul>
        </nz-dropdown-menu>
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
  private readonly modal = inject(NzModalService);

  openImportOnline(): void {
    this.modal.create({
      nzTitle: '导入在线书页',
      nzContent: ImportOnlineComponent,
      nzOkText: '确认导入',
      nzCancelText: '取消',
      nzWidth: 640,
      nzOnOk: (instance: ImportOnlineComponent) => instance.confirm(),
    });
  }

  openImportLocalTxt(): void {
    this.modal.create({
      nzTitle: '导入本地 TXT',
      nzContent: ImportLocalTxtComponent,
      nzOkText: '确认导入',
      nzCancelText: '取消',
      nzWidth: 640,
      nzOnOk: (instance: ImportLocalTxtComponent) => instance.confirm(),
    });
  }
}