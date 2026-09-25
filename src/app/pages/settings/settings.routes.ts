import { Routes } from '@angular/router';

/**
 * Settings 子路由（实施计划 T-019）
 * 当前仅承载封面缓存管理；后续设置项在此追加
 */
export const SETTINGS_ROUTES: Routes = [
  // 默认 /settings → /settings/cache（与 sidebar 链接一致）
  { path: '', pathMatch: 'full', redirectTo: 'cache' },
  {
    path: 'cache',
    loadComponent: () => import('./cache-settings.component').then(m => m.CacheSettingsComponent),
  },
];