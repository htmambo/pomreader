import { Routes } from '@angular/router';

/**
 * 书源管理页路由（实施计划 T-005）
 * - ''          → 列表页（已安装书源）
 * - 'search'    → 书源搜索
 * - 'smart-add' → 智能添加
 * - 'debug'     → 调试书源
 * - 'test'      → 书源测试
 * - 'edit/:fileName' → 编辑现有书源
 */
export const BOOK_SOURCE_ROUTES: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./book-source-list.component').then((m) => m.BookSourceListComponent),
  },
  {
    // 注意：search/smart-add/debug/test 必须放在 'edit/:fileName' 之前，否则会被 :fileName 捕获
    path: 'search',
    loadComponent: () =>
      import('./source-search.component').then((m) => m.SourceSearchComponent),
  },
  {
    path: 'smart-add',
    loadComponent: () =>
      import('./source-smart-add.component').then((m) => m.SourceSmartAddComponent),
  },
  {
    path: 'debug',
    loadComponent: () =>
      import('./source-debug.component').then((m) => m.SourceDebugComponent),
  },
  {
    path: 'test',
    loadComponent: () =>
      import('./source-test.component').then((m) => m.SourceTestComponent),
  },
  {
    path: 'edit/:fileName',
    loadComponent: () =>
      import('./book-source-editor.component').then((m) => m.BookSourceEditorComponent),
  },
];