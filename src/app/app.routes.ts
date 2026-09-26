import { Routes } from '@angular/router';

export const routes: Routes = [
  // 根路径重定向到书架
  { path: '', pathMatch: 'full', redirectTo: 'bookshelf' },
  // 书架首页（lazy load）
  {
    path: 'bookshelf',
    data: { title: '书架' },
    loadComponent: () =>
      import('./pages/bookshelf/bookshelf.component').then((m) => m.BookshelfComponent),
  },
  // 全网搜索（legacy webview 浏览器路由；书源搜索已并入 /book-sources/search）
  {
    path: 'search',
    data: { title: '万能搜索' },
    loadComponent: () =>
      import('./pages/universal-search/universal-search.component').then(
        (m) => m.UniversalSearchComponent
      ),
  },
  // 书源管理（T-005，lazy 子路由：列表/搜索/智能添加/调试/测试/编辑）
  {
    path: 'book-sources',
    data: { title: '书源列表' },
    loadChildren: () =>
      import('./pages/book-source/book-source.routes').then(
        (m) => m.BOOK_SOURCE_ROUTES,
      ),
  },
  // 设置页（T-019 / spec FR-3.5 缓存管理 UI 承载；当前含 cache 子路由）
  {
    path: 'settings',
    data: { title: '设置' },
    loadChildren: () =>
      import('./pages/settings/settings.routes').then((m) => m.SETTINGS_ROUTES),
  },
  // 免责声明
  {
    path: 'disclaimer',
    data: { title: '免责声明' },
    loadComponent: () =>
      import('./pages/disclaimer/disclaimer.component').then(
        (m) => m.DisclaimerComponent
      ),
  },
  // 阅读器：/reader/:bookId/:chapterId（不进 header,全屏）
  {
    path: 'reader/:bookId/:chapterId',
    loadComponent: () =>
      import('./pages/reader/reader.component').then((m) => m.ReaderComponent),
  },
  // 兜底：未匹配路由全部回到书架
  { path: '**', redirectTo: 'bookshelf' },
];
