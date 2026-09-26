import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, NavigationEnd } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { filter, map, startWith } from 'rxjs/operators';
import { NzTagModule } from 'ng-zorro-antd/tag';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { NzDropDownModule } from 'ng-zorro-antd/dropdown';
import { NzModalService } from 'ng-zorro-antd/modal';
import { ImportOnlineComponent } from '../../../modals/import-online/import-online.component';
import { ImportLocalTxtComponent } from '../../../modals/import-local-txt/import-local-txt.component';
import { PageHeaderService } from './page-header.service';

/**
 * PageHeader — 顶部标题 + 操作区(全局唯一,放在 AppComponent 的 <nz-header> 里)
 * - 标题/副标题来自 PageHeaderService:
 *   - 静态部分由路由 data.title / data.subtitle 写入(AppComponent 监听 NavigationEnd);
 *   - 动态副标题(例如书源列表的「共 N 个书源」)由具体页面在 effect / 回调里覆写。
 * - 「导入」按钮仅书架页可见 —— 其它页面该按钮与页面语义无关
 */
@Component({
  selector: 'app-page-header',
  standalone: true,
  imports: [CommonModule, NzTagModule, NzButtonModule, NzIconModule, NzDropDownModule],
  template: `
    <div class="page-header">
      @if (header.title() || header.subtitle()) {
        <div class="title-block">
          @if (header.title()) {
            <h2 class="title">{{ header.title() }}</h2>
          }
          @if (header.subtitle()) {
            <span class="subtitle">{{ header.subtitle() }}</span>
          }
        </div>
      } @else {
        <div class="tags">
          <!-- <nz-tag nzColor="default">当前版本: 1.0.6</nz-tag> -->
        </div>
      }
      <div class="actions">
        @if (isBookshelf()) {
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
        }
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
      .title-block {
        display: flex;
        align-items: baseline;
        gap: 12px;
        line-height: 32px;
      }
      .title {
        margin: 0;
        font-size: 18px;
        font-weight: 600;
        color: var(--pom-text);
      }
      .subtitle {
        color: var(--pom-text-muted);
        font-size: 13px;
      }
      .tags {
        display: flex;
        gap: 4px;
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
  protected readonly header = inject(PageHeaderService);

  private readonly modal = inject(NzModalService);
  private readonly router = inject(Router);

  /** 「导入」按钮仅书架页可见 */
  readonly isBookshelf = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map((e) => e.urlAfterRedirects.startsWith('/bookshelf')),
      startWith(this.router.url.startsWith('/bookshelf')),
    ),
    { initialValue: this.router.url.startsWith('/bookshelf') },
  );

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
