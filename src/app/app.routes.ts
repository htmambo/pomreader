import { Routes } from '@angular/router';

export const routes: Routes = [
  // 根路径重定向到书架
  { path: '', pathMatch: 'full', redirectTo: 'bookshelf' },
  // 书架首页（lazy load）
  {
    path: 'bookshelf',
    loadComponent: () =>
      import('./pages/bookshelf/bookshelf.component').then((m) => m.BookshelfComponent),
  },
  // 全网搜索（legacy webview 浏览器路由，与 /source-search 书源搜索并存）
  {
    path: 'search',
    loadComponent: () =>
      import('./pages/universal-search/universal-search.component').then(
        (m) => m.UniversalSearchComponent
      ),
  },
  // 书源搜索（T-006 / spec FR-2，lazy 子路由）
  {
    path: 'source-search',
    loadChildren: () =>
      import('./pages/source-search/source-search.routes').then(
        (m) => m.SOURCE_SEARCH_ROUTES
      ),
  },
  // 书源管理（T-005，lazy 子路由，含列表/新建/编辑）
  {
    path: 'book-sources',
    loadChildren: () =>
      import('./pages/book-source/book-source.routes').then(
        (m) => m.BOOK_SOURCE_ROUTES,
      ),
  },
  // 扩展管理列表页（T-010 / spec FR-4）
  {
    path: 'extensions',
    loadComponent: () =>
      import('./pages/extension/extension-list.component').then(
        (m) => m.ExtensionListComponent,
      ),
  },
  // 设置页（T-019 / spec FR-3.5 缓存管理 UI 承载；当前含 cache 子路由）
  {
    path: 'settings',
    loadChildren: () =>
      import('./pages/settings/settings.routes').then((m) => m.SETTINGS_ROUTES),
  },
  // 免责声明
  {
    path: 'disclaimer',
    loadComponent: () =>
      import('./pages/disclaimer/disclaimer.component').then(
        (m) => m.DisclaimerComponent
      ),
  },
  // 阅读器：/reader/:bookId/:chapterId
  {
    path: 'reader/:bookId/:chapterId',
    loadComponent: () =>
      import('./pages/reader/reader.component').then((m) => m.ReaderComponent),
  },
  // 兜底：未匹配路由全部回到书架
  { path: '**', redirectTo: 'bookshelf' },
];