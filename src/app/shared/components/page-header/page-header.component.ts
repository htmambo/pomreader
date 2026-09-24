import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { NzTagModule } from 'ng-zorro-antd/tag';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { NzDropDownModule } from 'ng-zorro-antd/dropdown';
import { NzModalService } from 'ng-zorro-antd/modal';
import { ImportOnlineComponent } from '../../../modals/import-online/import-online.component';
import { ImportLocalTxtComponent } from '../../../modals/import-local-txt/import-local-txt.component';

/**
 * PageHeader — 导入按钮
 */
@Component({
  selector: 'app-page-header',
  standalone: true,
  imports: [CommonModule, NzTagModule, NzButtonModule, NzIconModule, NzDropDownModule],
  template: `
    <div class="page-header">
      <div class="tags">
        <!-- <nz-tag nzColor="default">当前版本: 1.0.6</nz-tag> -->
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
