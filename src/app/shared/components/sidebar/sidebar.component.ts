import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
  type OnDestroy,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';

import { NavigationEnd, Router, RouterLink, RouterLinkActive } from '@angular/router';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { filter, map, startWith } from 'rxjs';

/** 导航项（顶层） */
interface NavItem {
  path: string;
  label: string;
  icon: string;
  /** 精确匹配（/book-sources 有子路由，非精确时「列表」与「搜索」会同时高亮） */
  exact?: boolean;
}

/**
 * Sidebar — 主导航（图标轨 + hover 悬浮展开）
 *
 * 交互（对齐 legado 桌面版布局）：
 * - 默认折叠为 64px 图标轨，文字标签被 overflow 裁掉；「书源管理」子菜单默认收起
 * - 鼠标移入轨道 → 面板宽度动画到 200px 并**悬浮覆盖**主内容（内容不位移），带投影
 * - 鼠标移出后延迟 180ms 收起，避免展开/收起动画期间指针落在面板外导致闪烁
 * - 「书源管理」子菜单初始收起；用户点开后展开态持久，面板宽度收缩不重置它
 *
 * 图标映射（沿用历史注释里的挑选结论：顶层轮廓最大化差异，子菜单互不相似）：
 * - 书架 read / 书源管理 database / 万能搜索 global / 设置 setting / 免责声明 file-text
 * - 书源管理子菜单：unordered-list（列表）/ search（搜索）/ bug（调试）/ experiment（测试）
 *
 * ⚠️ nzType 必须是 app.component.ts provideNzIconsPatch 已注册的名称，
 * 未注册时 ng-zorro 静默不渲染图标（菜单项只剩文字，无报错）。
 *
 * 模板拆到 .html：内联后本文件会到 ~340 行，越过 300 行阈值（见 AGENTS.md 拆分规则）。
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-sidebar',
  imports: [RouterLink, RouterLinkActive, NzIconModule],
  templateUrl: './sidebar.component.html',
  styles: [
    `
      :host {
        display: block;
        height: 100%;
        /* nz-sider 只有 64px 宽且 overflow: visible，靠 z-index 让展开态盖住 nz-content */
        position: relative;
        z-index: 30;
      }
      .rail {
        width: 64px;
        height: 100%;
        display: flex;
        flex-direction: column;
        background: var(--pom-fg);
        overflow: hidden;
        transition:
          width 180ms ease,
          box-shadow 180ms ease;
      }
      .rail.expanded {
        width: 200px;
        box-shadow: 8px 0 24px rgba(0, 0, 0, 0.28);
      }
      .brand {
        display: flex;
        align-items: center;
        gap: 12px;
        height: 56px;
        padding: 0 16px;
        flex-shrink: 0;
        color: var(--pom-text);
      }
      .brand-icon {
        width: 32px;
        height: 32px;
        flex-shrink: 0;
        border-radius: 8px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 22px;
        color: var(--pom-accent);
      }
      .brand-name {
        font-size: 16px;
        font-weight: 600;
        white-space: nowrap;
        opacity: 0;
        transform: translateX(-8px);
        transition:
          opacity 110ms ease,
          transform 160ms ease;
      }
      .rail.expanded .brand-name {
        opacity: 1;
        transform: none;
        transition-delay: 70ms;
      }
      .list {
        list-style: none;
        margin: 0;
        padding: 4px 0;
        flex: 1;
        overflow-y: auto;
        overflow-x: hidden;
      }
      /* 子菜单 ul：继承外层 ul 的去项目符号（否则嵌套 ul 会冒出 disc） */
      .list ul {
        list-style: none;
        margin: 0;
        padding: 0;
      }
      /* 图标列位置在两种状态下完全一致：
         item 左边缘 x=8（margin 2px 8px）+ padding 12 + 图标宽 24 → 图标中心 x=32，
         正好落在 64px 轨道的中心。因此展开/收起时图标"钉"在原地，
         变化的只有面板宽度与右侧文字 —— 视觉上是面板从右向左收回。 */
      .item {
        position: relative;
        display: flex;
        align-items: center;
        gap: 12px;
        width: calc(100% - 16px);
        height: 42px;
        margin: 2px 8px;
        padding: 0 12px;
        border: none;
        border-radius: 10px;
        background: transparent;
        color: var(--pom-text-muted);
        font-family: inherit;
        font-size: 14px;
        text-align: left;
        text-decoration: none;
        white-space: nowrap;
        cursor: pointer;
      }
      .item:hover {
        background: var(--pom-card);
        color: var(--pom-text);
      }
      .item.active {
        background: var(--pom-card);
        color: var(--pom-accent);
        font-weight: 600;
      }
      .item.active::before {
        content: '';
        position: absolute;
        left: 0;
        top: 22%;
        bottom: 22%;
        width: 3px;
        border-radius: 0 3px 3px 0;
        background: var(--pom-accent);
      }
      .icon {
        flex-shrink: 0;
        width: 24px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 22px;
      }
      .label {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        /* 折叠态不是 display:none —— 那样收起会"啪"地消失、看不到从右向左收的面板。
           改为保持占位 + 透明：图标列位置全程不变，只有面板宽度与文字透明度在动 */
        opacity: 0;
        transform: translateX(-8px);
        transition:
          opacity 110ms ease,
          transform 160ms ease;
      }
      .caret {
        flex-shrink: 0;
        font-size: 12px;
        opacity: 0;
        transition:
          opacity 110ms ease,
          transform 180ms ease;
      }
      .caret.open {
        transform: rotate(90deg);
      }
      /* 展开态：文字 / 箭头淡入（比宽度动画略晚，读起来像面板"抽出"） */
      .rail.expanded .label {
        opacity: 1;
        transform: none;
        transition-delay: 70ms;
      }
      .rail.expanded .caret {
        opacity: 1;
        transition-delay: 70ms;
      }
      .subitem {
        padding-left: 20px;
        font-size: 13px;
      }
      /* 折叠态不再改写任何布局（不居中、不改 padding）：图标必须原地不动，
         文字靠 opacity:0 + rail 的 overflow 裁剪消失 —— 半截文字因此不会露出来 */
    `,
  ],
})
export class SidebarComponent implements OnDestroy {
  /** 悬浮展开态（由 mouseenter/leave 驱动） */
  readonly expanded = signal(false);
  /** 书源管理子菜单展开态：默认隐藏 */
  readonly sourcesOpen = signal(false);

  private readonly router = inject(Router);
  private readonly currentUrl = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map((e) => e.urlAfterRedirects),
      startWith(this.router.url),
    ),
    { initialValue: this.router.url },
  );

  /** 任一书源子路由激活时主菜单保持高亮（点子项会收起子菜单，active 不能只绑展开态） */
  readonly sourcesRouteActive = computed(() => this.currentUrl().startsWith('/book-sources'));

  /** 收起延迟：展开动画 180ms，指针在动画中途移出会落在面板外，留缓冲避免抖动 */
  private collapseTimer: ReturnType<typeof setTimeout> | null = null;

  readonly primaryItems: NavItem[] = [{ path: '/bookshelf', label: '书架', icon: 'read' }];

  readonly bookSourceItems: NavItem[] = [
    { path: '/book-sources', label: '列表', icon: 'unordered-list', exact: true },
    { path: '/book-sources/search', label: '搜索', icon: 'search', exact: true },
    { path: '/book-sources/debug', label: '调试', icon: 'bug', exact: true },
    { path: '/book-sources/test', label: '测试', icon: 'experiment', exact: true },
  ];

  readonly secondaryItems: NavItem[] = [
    { path: '/search', label: '万能搜索', icon: 'global' },
    { path: '/settings/cache', label: '设置', icon: 'setting' },
    { path: '/disclaimer', label: '免责声明', icon: 'file-text' },
  ];

  onMouseEnter(): void {
    this.clearCollapseTimer();
    this.expanded.set(true);
  }

  onMouseLeave(): void {
    this.clearCollapseTimer();
    this.collapseTimer = setTimeout(() => {
      this.expanded.set(false);
      /* 不重置 sourcesOpen：子菜单展开态由用户显式 toggle 控制，
         面板宽度收缩不应丢失它，否则下次悬停要重新点开 */
    }, 180);
  }

  /** 点击「书源管理」：折叠态先展开再展开子菜单，避免点完看不到反馈 */
  toggleSources(): void {
    if (!this.expanded()) {
      this.expanded.set(true);
    }
    this.sourcesOpen.update((open) => !open);
  }

  /** 顶部导航点击后收起悬浮面板（内容区已在指针右侧，避免指针悬停导致面板常驻）。
      keepSources：点击书源子项时传 true —— 子菜单保持展开，激活子项才能继续可见 */
  closePanel(keepSources = false): void {
    this.expanded.set(false);
    if (!keepSources) {
      this.sourcesOpen.set(false);
    }
  }

  private clearCollapseTimer(): void {
    if (this.collapseTimer !== null) {
      clearTimeout(this.collapseTimer);
      this.collapseTimer = null;
    }
  }

  ngOnDestroy(): void {
    this.clearCollapseTimer();
  }
}
