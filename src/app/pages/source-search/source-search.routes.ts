import { Routes } from '@angular/router';

/**
 * 书源搜索路由（T-006 / spec FR-2）
 * - 独立 lazy route，与 /search（universal-search webview 浏览器）并存，语义不冲突
 */
export const SOURCE_SEARCH_ROUTES: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./source-search.component').then((m) => m.SourceSearchComponent),
  },
];
