import {
  Component,
  ElementRef,
  inject,
  signal,
  viewChild,
  effect,
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
import { BookSourceRegistry } from '../../core/book-source/book-source.registry';
import { AutoImportService, isImportableUrl } from '../../core/services/auto-import.service';

type EncodingMode = 'auto' | 'utf-8' | 'gbk';

/**
 * 万能搜索 — Electron webview 内嵌浏览器（对标原 vendor）
 * - webview 加载搜索引擎 / 6 书签站
 * - 地址栏同步、前进/后退/刷新/跳转
 * - 编码手动切换（auto/UTF-8/GBK）兜底
 * - 「导入在线书页」按钮预填当前 URL 打开导入 modal
 * - 自动导入监控：导航命中 .txt/.zip/.rar/.7z 时阻止跳转并自动入书架
 *   （attachment 形式的下载由主进程 will-download 拦截，不经此处）
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
          <!-- wvGen 变化即销毁重建 webview：首次加载卡死（dom-ready 未触发）时强制立即跳转 -->
          @for (gen of [wvGen()]; track gen) {
            <webview
              #webviewRef
              [attr.src]="wvSrc"
              allowpopups
              partition="persist:fetch"
              style="width: 100%; height: 100%;"
            ></webview>
          }
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
  // 注入即激活全局自动导入订阅（root 单例，离开页面后下载完成事件仍能导入）
  private readonly autoImport = inject(AutoImportService);
  private readonly registry = inject(BookSourceRegistry);

  readonly sites = GOOD_SITES;
  url = 'https://www.baidu.com/';
  /** webview 初始/重建时的 src（go 重建路径会更新它） */
  wvSrc = 'https://www.baidu.com/';
  /** webview 重建计数：@for track 它，变化即销毁旧 guest 新建 */
  readonly wvGen = signal(0);
  readonly loading = signal(false);
  readonly isElectron = signal(false);
  /** webview 是否已 dom-ready（未就绪时 canGoBack 等原生方法不可用） */
  readonly wvReady = signal(false);
  /** 后退/前进可用状态（did-stop-loading 时更新，模板绑 signal 而非每次变更检测调原生 API） */
  readonly canBack = signal(false);
  readonly canFwd = signal(false);
  encoding: EncodingMode = 'auto';
  /** go() 主动发起的目标 URL：did-stop-loading 同步地址栏时优先于 wv.getURL()，
   *  避免 stop() 中止旧加载时地址栏闪回旧 URL */
  private navTarget: string | null = null;

  private readonly webviewRef = viewChild<ElementRef<HTMLWebViewElement>>('webviewRef');

  constructor() {
    this.isElectron.set(typeof window !== 'undefined' && !!(window as any).pomAPI);

    // webview 元素出现/重建时（重新）挂事件；旧元素随 @for 销毁，监听器随之回收
    effect(() => {
      const wv = this.webviewRef()?.nativeElement;
      if (wv) this.attachWebview(wv);
    });
  }

  private attachWebview(wv: HTMLWebViewElement): void {
    wv.addEventListener('dom-ready', () => {
      this.wvReady.set(true);
      this.refreshNavState();
    });
    wv.addEventListener('will-navigate', (e: any) => {
      if (!/^https?:\/\//.test(e.url)) {
        e.preventDefault?.();
        return;
      }
      // 自动导入监控：.txt/压缩包 URL 不再跳转，转交自动导入链（抓取/解压/入书架）
      if (isImportableUrl(e.url)) {
        e.preventDefault?.();
        void this.autoImport.importFromUrl(e.url);
        return;
      }
      this.url = e.url;
    });
    wv.addEventListener('did-start-loading', () => this.loading.set(true));
    wv.addEventListener('did-stop-loading', () => {
      this.loading.set(false);
      if (this.wvReady()) {
        this.url = this.navTarget ?? wv.getURL();
        this.navTarget = null;
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
    const wv = this.webviewRef()?.nativeElement;
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
    this.webviewRef()?.nativeElement?.goBack?.();
  }
  forward(): void {
    if (!this.wvReady()) return;
    this.webviewRef()?.nativeElement?.goForward?.();
  }
  reload(): void {
    if (this.wvReady()) {
      this.webviewRef()?.nativeElement?.reload?.();
    } else {
      // 首次加载卡死：重建 webview 重新拉当前地址
      this.recreateWebview(this.url);
    }
  }

  /**
   * 跳转到目标地址（引擎切换/地址栏回车/跳转按钮）
   * 要求：立即生效 —— 已就绪时 stop() 终止当前加载再 loadURL；
   * 首次加载卡死（dom-ready 未触发，原生方法不可用）时重建 webview 强制跳转
   */
  go(target?: string): void {
    let u = (target ?? this.url).trim();
    if (!u) return;
    // 看起来不像 URL 则当搜索词走百度
    if (!/^https?:\/\//.test(u) && u.includes(' ') || (!/\./.test(u) && u.length > 0 && !/^https?:/.test(u))) {
      u = 'https://www.baidu.com/s?wd=' + encodeURIComponent(u);
    } else if (!/^https?:\/\//.test(u)) {
      u = 'http://' + u;
    }
    // 地址栏直接输入 .txt/压缩包 URL：will-navigate 不覆盖编程式 loadURL，此处主动拦截
    if (isImportableUrl(u)) {
      this.url = u;
      void this.autoImport.importFromUrl(u);
      return;
    }
    this.url = u;
    const wv = this.webviewRef()?.nativeElement;
    if (!wv) return;
    if (this.wvReady()) {
      this.navTarget = u;
      try {
        // 先终止进行中的加载（触发 did-stop-loading → 立即停转圈），再开始新导航
        // stop 不在 HTMLWebViewElement 类型声明中（与 loadURL 同为运行时方法）
        if (this.loading()) (wv as any).stop?.();
      } catch {
        // 容错：原生方法偶发不可用
      }
      // loadURL 实际返回 Promise（类型声明为 void）；ERR_ABORTED（被下一次导航中止）属正常竞争，静默
      void (wv.loadURL(u) as unknown as Promise<void>)?.catch(() => {});
    } else {
      this.recreateWebview(u);
    }
  }

  /** 销毁当前 webview 并以新 URL 重建（卡死场景的强制立即生效手段，代价是丢失 guest 内历史） */
  private recreateWebview(u: string): void {
    this.wvReady.set(false);
    this.loading.set(false);
    this.canBack.set(false);
    this.canFwd.set(false);
    this.wvSrc = u;
    this.wvGen.update((n) => n + 1);
  }

  setEncoding(mode: EncodingMode): void {
    this.encoding = mode;
    if (!this.wvReady()) return;
    const wv = this.webviewRef()?.nativeElement as any;
    if (wv?.getWebContentsId) {
      const id = String(wv.getWebContentsId());
      (window as any).pomAPI?.setWebviewEncoding?.(id, mode);
    }
    this.reload();
  }

  openImport(): void {
    // 域名匹配：若用户 webview 里访问的 URL 命中某个已启用书源（JsSourceAdapter.hostPattern），
    // 则注入 source 到 nzData → ImportOnlineComponent 自动预选该书源 → importByUrl 走该书源
    // 的 JsSourceAdapter.fetchCatalog → Book.bookSourceUuid 锚定到 meta.uuid（而不是 'universal'）
    const matchedSourceName = this.findMatchingBookSource(this.url);
    this.modal.create({
      nzTitle: '导入在线书页',
      nzContent: ImportOnlineComponent,
      nzData: {
        url: this.url,
        ...(matchedSourceName ? { source: matchedSourceName } : {}),
      },
      nzOkText: '确认导入',
      nzCancelText: '取消',
      nzWidth: 640,
      nzOnOk: (instance: ImportOnlineComponent) => instance.confirm(),
    });
  }

  /**
   * 在 registry 里查找首个 match(url) 的 JsSourceAdapter 名（universal-search 用）。
   * 找不到时返回 undefined → modal 不注入 source，ImportOnlineComponent 走 registry 自动 resolve
   */
  private findMatchingBookSource(url: string): string | undefined {
    return this.registry.findJsSourceAdapterByUrl(url)?.name;
  }
}
