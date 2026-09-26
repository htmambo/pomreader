import { Routes } from '@angular/router';

/**
 * 书源管理页路由（实施计划 T-005）
 * 父路由 /book-sources 已在 app.routes.ts 上声明 title='书源列表';
 * 子路由只覆盖需要不同标题/副标题的项;未覆盖时沿用父级 title。
 */
export const BOOK_SOURCE_ROUTES: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./book-source-list.component').then((m) => m.BookSourceListComponent),
  },
  {
    // 注意:search/smart-add/debug/test 必须放在 'edit/:fileName' 之前,否则会被 :fileName 捕获
    path: 'search',
    data: { title: '书源搜索', subtitle: '跨书源聚合搜索' },
    loadComponent: () =>
      import('./source-search.component').then((m) => m.SourceSearchComponent),
  },
  {
    path: 'smart-add',
    data: { title: '智能添加', subtitle: '输入网址 → 调整规则 → 生成书源' },
    loadComponent: () =>
      import('./source-smart-add.component').then((m) => m.SourceSmartAddComponent),
  },
  {
    path: 'debug',
    data: { title: '调试书源', subtitle: '逐函数调用书源,预览结果与原始 JSON' },
    loadComponent: () =>
      import('./source-debug.component').then((m) => m.SourceDebugComponent),
  },
  {
    path: 'test',
    data: { title: '书源测试', subtitle: '批量检测书源可用性(搜索 → 详情 → 目录 → 正文)' },
    loadComponent: () =>
      import('./source-test.component').then((m) => m.SourceTestComponent),
  },
  {
    // 副标题为当前编辑的文件名 —— 路由加载后由组件在 loadExisting() 里写入 service
    path: 'edit/:fileName',
    data: { title: '编辑书源' },
    loadComponent: () =>
      import('./book-source-editor.component').then((m) => m.BookSourceEditorComponent),
  },
];
