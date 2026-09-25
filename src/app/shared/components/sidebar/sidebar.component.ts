import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { NzMenuModule } from 'ng-zorro-antd/menu';
import { NzIconModule } from 'ng-zorro-antd/icon';

/**
 * Sidebar — 主导航
 * - 原有：书架 / 万能搜索 / 免责声明
 * - legado 迁移新增：书源管理 / 书源市场 / 书源搜索 / 扩展管理 / 设置（缓存）
 */
@Component({
  selector: 'app-sidebar',
  standalone: true,
  imports: [CommonModule, RouterLink, RouterLinkActive, NzMenuModule, NzIconModule],
  template: `
    <h1 class="logo">白虎阅读</h1>
    <ul nz-menu nzTheme="light" nzMode="inline">
      <li nz-menu-item [routerLink]="['/bookshelf']" routerLinkActive="ant-menu-item-selected">
        <span nz-icon nzType="book"></span>
        <span>书架</span>
      </li>
      <li nz-menu-item [routerLink]="['/source-search']" routerLinkActive="ant-menu-item-selected">
        <span nz-icon nzType="search"></span>
        <span>书源搜索</span>
      </li>
      <li nz-menu-item [routerLink]="['/book-sources']" routerLinkActive="ant-menu-item-selected">
        <span nz-icon nzType="book"></span>
        <span>书源管理</span>
      </li>
      <li nz-menu-item [routerLink]="['/book-sources/market']" routerLinkActive="ant-menu-item-selected">
        <span nz-icon nzType="cloud-download"></span>
        <span>书源市场</span>
      </li>
      <li nz-menu-item [routerLink]="['/extensions']" routerLinkActive="ant-menu-item-selected">
        <span nz-icon nzType="appstore"></span>
        <span>扩展管理</span>
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