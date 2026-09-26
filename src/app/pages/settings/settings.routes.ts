import { Routes } from '@angular/router';

/**
 * Settings 子路由(实施计划 T-019)
 * 当前仅承载封面缓存管理;后续设置项在此追加
 * 父路由 /settings 已在 app.routes.ts 上声明 title='设置';子路由仅在需要不同副标题时覆盖
 */
export const SETTINGS_ROUTES: Routes = [
  // 默认 /settings → /settings/cache(与 sidebar 链接一致)
  { path: '', pathMatch: 'full', redirectTo: 'cache' },
  {
    path: 'cache',
    data: { subtitle: '书架排序与封面缓存管理' },
    loadComponent: () => import('./cache-settings.component').then(m => m.CacheSettingsComponent),
  },
];
