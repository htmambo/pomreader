import { ChangeDetectionStrategy, Component, inject, effect, signal } from '@angular/core';
import {
  RouterOutlet,
  Router,
  NavigationEnd,
  ActivatedRouteSnapshot,
  type Data,
} from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { filter, map, startWith } from 'rxjs/operators';
import { NzLayoutModule } from 'ng-zorro-antd/layout';
import { NzMenuModule } from 'ng-zorro-antd/menu';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzIconModule, provideNzIconsPatch } from 'ng-zorro-antd/icon';
import {
  BookOutline,
  SearchOutline,
  FileTextOutline,
  ArrowLeftOutline,
  ArrowRightOutline,
  MenuOutline,
  SettingOutline,
  CloseOutline,
  PlusOutline,
  LinkOutline,
  WarningOutline,
  CheckOutline,
  MinusOutline,
  ArrowUpOutline,
  ReloadOutline,
  DownloadOutline,
  TranslationOutline,
  LoadingOutline,
  AppstoreOutline,
  CloudDownloadOutline,
  CopyOutline,
  DeleteOutline,
  DragOutline,
  EditOutline,
  GlobalOutline,
  InfoOutline,
  InfoCircleOutline,
  RobotOutline,
  SwapOutline,
  PlayCircleOutline,
  ThunderboltOutline,
  SaveOutline,
  SyncOutline,
  ImportOutline,
} from '@ant-design/icons-angular/icons';
import { PageHeaderComponent } from './shared/components/page-header/page-header.component';
import { PageHeaderService } from './core/services/page-header.service';
import { SidebarComponent } from './shared/components/sidebar/sidebar.component';
import { SettingsService } from './core/services/settings.service';
import { UniversalSearchComponent } from './pages/universal-search/universal-search.component';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-root',
  imports: [
    RouterOutlet,
    NzLayoutModule,
    NzMenuModule,
    NzButtonModule,
    NzIconModule,
    PageHeaderComponent,
    SidebarComponent,
    UniversalSearchComponent,
  ],
  providers: [
    provideNzIconsPatch([
      BookOutline,
      SearchOutline,
      FileTextOutline,
      ArrowLeftOutline,
      ArrowRightOutline,
      MenuOutline,
      SettingOutline,
      CloseOutline,
      PlusOutline,
      LinkOutline,
      WarningOutline,
      CheckOutline,
      MinusOutline,
      ArrowUpOutline,
      ReloadOutline,
      DownloadOutline,
      TranslationOutline,
      LoadingOutline,
      AppstoreOutline,
      CloudDownloadOutline,
      CopyOutline,
      DeleteOutline,
      DragOutline,
      EditOutline,
      GlobalOutline,
      InfoOutline,
      InfoCircleOutline,
      RobotOutline,
      SwapOutline,
      PlayCircleOutline,
      ThunderboltOutline,
      SaveOutline,
      SyncOutline,
      ImportOutline,
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
          <!-- 万能搜索常驻保活：webview 离开 DOM 即销毁 guest，故访问过 /search 后永久挂载，
               离开时仅 display:none 隐藏（CSS 隐藏不销毁 guest，保留 URL/历史/滚动） -->
          @if (searchVisited()) {
            <app-universal-search
              [active]="isSearch()"
              [style.display]="isSearch() ? null : 'none'"
            ></app-universal-search>
          }
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
        padding: 16px;
        padding-bottom: 0px;
      }
      nz-content {
        padding: 16px;
        padding-top: 0px;
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
  private readonly pageHeader = inject(PageHeaderService);

  /** 当前路由是否在 reader 页面（用于全屏） */
  readonly isReader = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map((e) => e.urlAfterRedirects.startsWith('/reader/')),
      startWith(this.router.url.startsWith('/reader/')),
    ),
    { initialValue: this.router.url.startsWith('/reader/') },
  );

  /** 当前路由是否在万能搜索页（控制常驻组件显示/隐藏与激活态） */
  readonly isSearch = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map((e) => e.urlAfterRedirects.startsWith('/search')),
      startWith(this.router.url.startsWith('/search')),
    ),
    { initialValue: this.router.url.startsWith('/search') },
  );

  /** 是否访问过 /search：见过一次即永久 true（触发常驻挂载），初始值覆盖 hash 深链接直接进 /search 的场景 */
  readonly searchVisited = signal(this.router.url.startsWith('/search'));

  constructor() {
    // 主题切换：把 settings.theme 同步到 <html data-pom-theme>，全站 modal 配色据此切换
    effect(() => {
      const theme = this.settings.settings().theme;
      document.documentElement.dataset['pomTheme'] = String(theme);
    });

    // 进入 /search 即标记已访问（一旦置 true 不再变回），外壳据此挂载常驻万能搜索组件。
    // 注意不能用 effect(() => isSearch() && searchVisited.set(...))：effect 内写 signal 触发 NG0600
    this.router.events
      .pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd))
      .subscribe((e) => {
        if (e.urlAfterRedirects.startsWith('/search')) this.searchVisited.set(true);
      });

    // 路由变化 → 从最深层 activated route 的 data 中读取 title/subtitle，写入全局 header
    // 子路由会覆盖父路由(parent first → child 后写,Angular 标准合并顺序)
    this.router.events
      .pipe(
        filter((e): e is NavigationEnd => e instanceof NavigationEnd),
        startWith(null),
      )
      .subscribe(() => {
        const data = this.collectRouteData();
        this.pageHeader.title.set(data['title'] ?? '');
        // subtitle 没在路由里显式声明 → 留空(具体页面如果有动态副标题,会在 effect 里覆写)
        this.pageHeader.subtitle.set(data['subtitle'] ?? '');
      });
  }

  /** 从 routerState.root 沿 firstChild 链走到叶子,合并所有层级的 data(子覆盖父) */
  private collectRouteData(): Data {
    const merged: Data = {};
    let r: ActivatedRouteSnapshot | null = this.router.routerState.snapshot.root;
    while (r) {
      if (r.data) Object.assign(merged, r.data);
      r = r.firstChild;
    }
    return merged;
  }
}
