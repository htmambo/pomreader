import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink, RouterLinkActive } from '@angular/router';

interface TabItem {
  path: string;
  label: string;
  /** routerLinkActive 精确匹配（列表页 '' 需要，避免所有子路由都高亮） */
  exact: boolean;
}

/**
 * 书源管理区 Tab 导航（对齐原项目单页多 Tab：已安装/智能添加/调试/测试/集市）
 * 嵌入各子页面 PageHeader 下方
 */
@Component({
  selector: 'app-book-source-tabs',
  standalone: true,
  imports: [CommonModule, RouterLink, RouterLinkActive],
  template: `
    <nav class="bs-tabs">
      @for (t of tabs; track t.path) {
        <a
          class="bs-tab"
          [routerLink]="t.path"
          routerLinkActive="bs-tab--active"
          [routerLinkActiveOptions]="{ exact: t.exact }"
        >
          {{ t.label }}
        </a>
      }
    </nav>
  `,
  styles: [
    `
      .bs-tabs {
        display: flex;
        gap: 4px;
        border-bottom: 1px solid var(--pom-border);
        margin-bottom: 16px;
      }
      .bs-tab {
        padding: 8px 16px;
        font-size: 14px;
        color: var(--pom-text-muted);
        text-decoration: none;
        border-bottom: 2px solid transparent;
        margin-bottom: -1px;
        transition: color 0.15s;
      }
      .bs-tab:hover {
        color: var(--pom-accent-hover);
      }
      .bs-tab--active {
        color: var(--pom-accent);
        border-bottom-color: var(--pom-accent);
        font-weight: 600;
      }
    `,
  ],
})
export class BookSourceTabsComponent {
  readonly tabs: TabItem[] = [
    { path: '/book-sources', label: '书源列表', exact: true },
    { path: '/book-sources/search', label: '书源搜索', exact: true },
    { path: '/book-sources/debug', label: '调试书源', exact: true },
    { path: '/book-sources/test', label: '书源测试', exact: true },
  ];
}
