import { Routes } from '@angular/router';

/**
 * 书源管理页路由（实施计划 T-005）
 * - ''          → 列表页
 * - 'edit'      → 新建编辑器
 * - 'edit/:fileName' → 编辑现有书源
 */
export const BOOK_SOURCE_ROUTES: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./book-source-list.component').then((m) => m.BookSourceListComponent),
  },
  {
    // 注意：market 必须放在 'edit/:fileName' 之前，否则 'market' 会被 :fileName 捕获
    path: 'market',
    loadComponent: () =>
      import('./source-market.component').then((m) => m.SourceMarketComponent),
  },
  {
    path: 'edit',
    loadComponent: () =>
      import('./book-source-editor.component').then((m) => m.BookSourceEditorComponent),
  },
  {
    path: 'edit/:fileName',
    loadComponent: () =>
      import('./book-source-editor.component').then((m) => m.BookSourceEditorComponent),
  },
];