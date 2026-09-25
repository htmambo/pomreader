import { Component, inject, effect } from '@angular/core';
import { RouterOutlet, Router, NavigationEnd } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { filter, map, startWith } from 'rxjs/operators';
import { NzLayoutModule } from 'ng-zorro-antd/layout';
import { NzMenuModule } from 'ng-zorro-antd/menu';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzIconModule, NZ_ICONS, provideNzIconsPatch } from 'ng-zorro-antd/icon';
import {
  BookOutline, SearchOutline, FileTextOutline,
  ArrowLeftOutline, ArrowRightOutline, MenuOutline, SettingOutline, CloseOutline,
  PlusOutline, LinkOutline, WarningOutline,
  CheckOutline, MinusOutline, ArrowUpOutline,
  ReloadOutline, DownloadOutline, TranslationOutline, LoadingOutline,
  AppstoreOutline, CloudDownloadOutline, CopyOutline, DeleteOutline,
  DragOutline, EditOutline, GlobalOutline,
  InfoOutline, InfoCircleOutline, RobotOutline, SwapOutline,
} from '@ant-design/icons-angular/icons';
import { PageHeaderComponent } from './shared/components/page-header/page-header.component';
import { SidebarComponent } from './shared/components/sidebar/sidebar.component';
import { SettingsService } from './core/services/settings.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    RouterOutlet,
    NzLayoutModule,
    NzMenuModule,
    NzButtonModule,
    NzIconModule,
    PageHeaderComponent,
    SidebarComponent,
  ],
  providers: [
    provideNzIconsPatch([
      BookOutline, SearchOutline, FileTextOutline,
      ArrowLeftOutline, ArrowRightOutline, MenuOutline, SettingOutline, CloseOutline,
      PlusOutline, LinkOutline, WarningOutline,
      CheckOutline, MinusOutline, ArrowUpOutline,
      ReloadOutline, DownloadOutline, TranslationOutline, LoadingOutline,
      AppstoreOutline, CloudDownloadOutline, CopyOutline, DeleteOutline,
      DragOutline, EditOutline, GlobalOutline,
      InfoOutline, InfoCircleOutline, RobotOutline, SwapOutline,
    ]),
  ],
  template: `
    <nz-layout class="app-layout">
      @if (!isReader()) {
        <nz-sider nzWidth="200px">
          <app-sidebar></app-sidebar>
        </nz-sider>
      }
      <nz-layout [class.fullscreen]="isReader()">
        @if (!isReader()) {
          <nz-header>
            <app-page-header></app-page-header>
          </nz-header>
        }
        <nz-content [class.no-padding]="isReader()">
          <router-outlet></router-outlet>
        </nz-content>
      </nz-layout>
    </nz-layout>
  `,
  styles: [
    `
      :host {
        display: block;
        height: 100vh;
      }
      .app-layout {
        height: 100vh;
      }
      nz-sider {
        background: var(--pom-fg);
      }
      nz-header {
        padding: 0 16px;
        line-height: 64px;
      }
      nz-content {
        padding: 16px;
        overflow: auto;
      }
      nz-content.no-padding {
        padding: 0;
      }
      nz-layout.fullscreen {
        height: 100vh;
      }
    `,
  ],
})
export class AppComponent {
  private readonly router = inject(Router);
  private readonly settings = inject(SettingsService);

  /** 当前路由是否在 reader 页面（用于全屏） */
  readonly isReader = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map((e) => e.urlAfterRedirects.startsWith('/reader/')),
      startWith(this.router.url.startsWith('/reader/'))
    ),
    { initialValue: this.router.url.startsWith('/reader/') }
  );

  constructor() {
    // 主题切换：把 settings.theme 同步到 <html data-pom-theme>，全站 modal 配色据此切换
    effect(() => {
      const theme = this.settings.settings().theme;
      document.documentElement.dataset['pomTheme'] = String(theme);
    });
  }
}