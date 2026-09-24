import {
  Component,
  ElementRef,
  ViewChild,
  inject,
  signal,
  afterNextRender,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { NzDropDownModule } from 'ng-zorro-antd/dropdown';
import { NzMenuModule } from 'ng-zorro-antd/menu';
import { NO_ERRORS_SCHEMA } from '@angular/core';
import { NzModalService } from 'ng-zorro-antd/modal';
import { NzMessageService } from 'ng-zorro-antd/message';
import { GOOD_SITES } from '../../core/data/good-sites';
import { ImportOnlineComponent } from '../../modals/import-online/import-online.component';

type EncodingMode = 'auto' | 'utf-8' | 'gbk';

/**
 * 万能搜索 — Electron webview 内嵌浏览器（对标原 vendor）
 * - webview 加载搜索引擎 / 6 书签站
 * - 地址栏同步、前进/后退/刷新/跳转
 * - 编码手动切换（auto/UTF-8/GBK）兜底
 * - 「导入在线书页」按钮预填当前 URL 打开导入 modal
 *
 * 浏览器环境（ng serve）webview 不识别 → 降级提示
 */
@Component({
  selector: 'app-universal-search',
  standalone: true,
  imports: [CommonModule, FormsModule, NzInputModule, NzButtonModule, NzIconModule, NzDropDownModule, NzMenuModule],
  schemas: [NO_ERRORS_SCHEMA],
  template: `
    <div class="search-page">
      <div class="toolbar">
        <button nz-button nzType="text" (click)="back()" [disabled]="!canBack()" title="后退">
          <span nz-icon nzType="arrow-left"></span>
        </button>
        <button nz-button nzType="text" (click)="forward()" [disabled]="!canFwd()" title="前进">
          <span nz-icon nzType="arrow-right"></span>
        </button>
        <button nz-button nzType="text" (click)="reload()" title="刷新">
          <span nz-icon [nzType]="loading() ? 'loading' : 'reload'"></span>
        </button>
        <input
          nz-input
          [(ngModel)]="url"
          (keyup.enter)="go()"
          placeholder="输入网址或搜索词，回车跳转"
          style="flex: 1;"
        />
        <button nz-button nzType="primary" (click)="go()" title="跳转">跳转</button>
        <button
          nz-button
          nz-dropdown
          [nzDropdownMenu]="encMenu"
          nzTrigger="click"
          nzPlacement="bottomRight"
          title="编码"
        >
          <span nz-icon nzType="translation"></span>
          {{ encodingLabel() }}
        </button>
        <nz-dropdown-menu #encMenu="nzDropdownMenu">
          <ul nz-menu>
            <li nz-menu-item (click)="setEncoding('auto')">自动侦测</li>
            <li nz-menu-item (click)="setEncoding('utf-8')">UTF-8</li>
            <li nz-menu-item (click)="setEncoding('gbk')">GBK</li>
          </ul>
        </nz-dropdown-menu>
        <button nz-button nzType="primary" (click)="openImport()" title="导入在线书页">
          <span nz-icon nzType="download"></span>
          导入在线书页
        </button>
      </div>

      <div class="bookmarks">
        @for (site of sites; track site.url) {
          <button nz-button nzSize="small" (click)="go(site.url)">{{ site.name }}</button>
        }
      </div>

      @if (isElectron()) {
        <div class="webview-wrap" [class.loading]="loading()">
          @if (loading()) {
            <div class="loading-mask"><span nz-icon nzType="loading"></span></div>
          }
          <webview
            #webviewRef
            src="https://www.baidu.com/"
            allowpopups
            partition="persist:universal-search"
            style="width: 100%; height: 100%;"
          ></webview>
        </div>
      } @else {
        <div class="not-electron">
          <p>此功能需 Electron 环境运行。</p>
          <p>开发请运行：<code>npm run dev</code></p>
        </div>
      }
    </div>
  `,
  styles: [
    `
      .search-page {
        display: flex;
        flex-direction: column;
        height: calc(100vh - 64px);
      }
      .toolbar {
        display: flex;
        gap: 6px;
        align-items: center;
        padding: 8px 16px;
        border-bottom: 1px solid var(--pom-border);
      }
      .bookmarks {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        padding: 8px 16px;
        border-bottom: 1px solid var(--pom-border);
      }
      .webview-wrap {
        position: relative;
        flex: 1;
        overflow: hidden;
      }
      .loading-mask {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        background: rgba(255, 255, 255, 0.4);
        z-index: 10;
        font-size: 24px;
      }
      .not-electron {
        flex: 1;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        color: var(--pom-text);
        gap: 8px;
      }
      code {
        background: var(--pom-border);
        padding: 2px 6px;
        border-radius: 4px;
      }
    `,
  ],
})
export class UniversalSearchComponent {
  private readonly modal = inject(NzModalService);
  private readonly msg = inject(NzMessageService);

  readonly sites = GOOD_SITES;
  url = 'https://www.baidu.com/';
  readonly loading = signal(false);
  readonly isElectron = signal(false);
  /** webview 是否已 dom-ready（未就绪时调 canGoBack 等会抛错） */
  readonly wvReady = signal(false);
  /** 后退/前进可用状态（did-stop-loading 时更新，模板绑 signal 而非每次变更检测调原生 API） */
  readonly canBack = signal(false);
  readonly canFwd = signal(false);
  encoding: EncodingMode = 'auto';

  @ViewChild('webviewRef') webviewRef?: ElementRef<HTMLWebViewElement>;

  constructor() {
    this.isElectron.set(typeof window !== 'undefined' && !!(window as any).pomAPI);

    afterNextRender(() => {
      this.attachWebview();
    });
  }

  private attachWebview(): void {
    const wv = this.webviewRef?.nativeElement;
    if (!wv) return;

    wv.addEventListener('dom-ready', () => {
      this.wvReady.set(true);
      this.refreshNavState();
    });
    wv.addEventListener('will-navigate', (e: any) => {
      if (!/^https?:\/\//.test(e.url)) {
        e.preventDefault?.();
        return;
      }
      this.url = e.url;
    });
    wv.addEventListener('did-start-loading', () => this.loading.set(true));
    wv.addEventListener('did-stop-loading', () => {
      this.loading.set(false);
      if (this.wvReady()) {
        this.url = wv.getURL();
        this.refreshNavState();
      }
    });
    wv.addEventListener('new-window', (e: any) => {
      // 主进程 setWindowOpenHandler 已 deny + loadURL 在当前 webview 跳转
      // 这里仅同步地址栏（did-stop-loading 也会刷新，保留作即时反馈）
      if (/^https?:\/\//.test(e.url)) this.url = e.url;
    });
  }

  /** 刷新后退/前进可用状态（仅 webview 就绪后调） */
  private refreshNavState(): void {
    const wv = this.webviewRef?.nativeElement;
    if (!wv || !this.wvReady()) return;
    try {
      this.canBack.set(wv.canGoBack());
      this.canFwd.set(wv.canGoForward());
    } catch {
      // 容错：偶发未完全就绪
    }
  }

  encodingLabel(): string {
    return this.encoding === 'auto' ? '自动' : this.encoding.toUpperCase();
  }

  back(): void {
    if (!this.wvReady()) return;
    this.webviewRef?.nativeElement?.goBack?.();
  }
  forward(): void {
    if (!this.wvReady()) return;
    this.webviewRef?.nativeElement?.goForward?.();
  }
  reload(): void {
    if (!this.wvReady()) return;
    this.webviewRef?.nativeElement?.reload?.();
  }

  go(target?: string): void {
    let u = (target ?? this.url).trim();
    if (!u) return;
    // 看起来不像 URL 则当搜索词走百度
    if (!/^https?:\/\//.test(u) && u.includes(' ') || (!/\./.test(u) && u.length > 0 && !/^https?:/.test(u))) {
      u = 'https://www.baidu.com/s?wd=' + encodeURIComponent(u);
    } else if (!/^https?:\/\//.test(u)) {
      u = 'http://' + u;
    }
    this.url = u;
    if (this.wvReady()) this.webviewRef?.nativeElement?.loadURL?.(u);
  }

  setEncoding(mode: EncodingMode): void {
    this.encoding = mode;
    if (!this.wvReady()) return;
    const wv = this.webviewRef?.nativeElement as any;
    if (wv?.getWebContentsId) {
      const id = String(wv.getWebContentsId());
      (window as any).pomAPI?.setWebviewEncoding?.(id, mode);
    }
    this.reload();
  }

  openImport(): void {
    this.modal.create({
      nzTitle: '导入在线书页',
      nzContent: ImportOnlineComponent,
      nzData: { url: this.url },
      nzOkText: '确认导入',
      nzCancelText: '取消',
      nzWidth: 640,
      nzOnOk: (instance: ImportOnlineComponent) => instance.confirm(),
    });
  }
}
