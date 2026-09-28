import { ChangeDetectionStrategy, Component } from '@angular/core';

import { RouterLink, RouterLinkActive } from '@angular/router';
import { NzMenuModule } from 'ng-zorro-antd/menu';
import { NzIconModule } from 'ng-zorro-antd/icon';

/**
 * Sidebar — 主导航
 * - 书架 / 万能搜索 / 免责声明
 * - 书源管理（分组子菜单：列表 / 搜索 / 调试 / 测试）
 * - 设置（缓存）
 *
 * 图标映射（书源管理子菜单刻意互不相似，便于扫读区分）：
 * - 列表 unordered-list（不用 appstore —— 已被 book-card「生成封面」占用）
 * - 搜索 search（跨书源聚合搜索）
 * - 调试 bug（通用调试隐喻，避开 code/console-sql 等实现细节向图标）
 * - 测试 experiment（批量跑源验证；不用 check-circle —— 那是「通过」状态而非动作）
 *
 * 顶层图标同样按轮廓差异最大化挑选，避免相邻项撞脸：
 * - 书架 read（摊开的书 = 在读；旧用 book 与书源管理撞车）
 * - 书源管理 database（圆柱 = 本地书源库，JS 文件 + 元数据 + 启停；与书本轮廓完全不同）
 *
 * ⚠️ nzType 必须是 app.component.ts provideNzIconsPatch 已注册的名称，
 * 未注册时 ng-zorro 静默不渲染图标（菜单项只剩文字，无报错）。
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-sidebar',
  imports: [RouterLink, RouterLinkActive, NzMenuModule, NzIconModule],
  template: `
    <h1 class="logo">白虎阅读</h1>
    <ul nz-menu nzTheme="light" nzMode="inline">
      <li nz-menu-item [routerLink]="['/bookshelf']" routerLinkActive="ant-menu-item-selected">
        <span nz-icon nzType="read"></span>
        <span>书架</span>
      </li>
      <li nz-submenu nzOpen nzTitle="书源管理" nzIcon="database">
        <ul>
          <li
            nz-menu-item
            [routerLink]="['/book-sources']"
            [routerLinkActiveOptions]="{ exact: true }"
            routerLinkActive="ant-menu-item-selected"
          >
            <span nz-icon nzType="unordered-list"></span>
            <span>列表</span>
          </li>
          <li
            nz-menu-item
            [routerLink]="['/book-sources/search']"
            [routerLinkActiveOptions]="{ exact: true }"
            routerLinkActive="ant-menu-item-selected"
          >
            <span nz-icon nzType="search"></span>
            <span>搜索</span>
          </li>
          <li
            nz-menu-item
            [routerLink]="['/book-sources/debug']"
            [routerLinkActiveOptions]="{ exact: true }"
            routerLinkActive="ant-menu-item-selected"
          >
            <span nz-icon nzType="bug"></span>
            <span>调试</span>
          </li>
          <li
            nz-menu-item
            [routerLink]="['/book-sources/test']"
            [routerLinkActiveOptions]="{ exact: true }"
            routerLinkActive="ant-menu-item-selected"
          >
            <span nz-icon nzType="experiment"></span>
            <span>测试</span>
          </li>
        </ul>
      </li>
      <li nz-menu-item [routerLink]="['/search']" routerLinkActive="ant-menu-item-selected">
        <span nz-icon nzType="global"></span>
        <span>万能搜索</span>
      </li>
      <li nz-menu-item [routerLink]="['/settings/cache']" routerLinkActive="ant-menu-item-selected">
        <span nz-icon nzType="setting"></span>
        <span>设置</span>
      </li>
      <li nz-menu-item [routerLink]="['/disclaimer']" routerLinkActive="ant-menu-item-selected">
        <span nz-icon nzType="file-text"></span>
        <span>免责声明</span>
      </li>
    </ul>
  `,
  styles: [
    `
      .logo {
        color: var(--pom-text-muted);
        text-align: center;
        line-height: 64px;
        margin: 0;
        font-size: 18px;
        font-weight: 600;
      }
      :host {
        display: block;
        height: 100%;
      }
    `,
  ],
})
export class SidebarComponent {}
