import { Injectable, signal } from '@angular/core';

/**
 * 全局顶部 PageHeader 的标题/副标题共享状态。
 *
 * 走 service 而不是组件 @Input 的原因:
 * - AppComponent 的 <nz-header> 与各页面在不同 DOM 树层级,模板直接传值需要组件协作;
 * - 标题数据由路由 data 提供(static),由具体页面在加载后覆写(dynamic,例如书源列表的「共 N 个书源」);
 *   集中放 service 让 AppComponent 的路由订阅与页面的 effect 都能读写同一份状态。
 */
@Injectable({ providedIn: 'root' })
export class PageHeaderService {
  readonly title = signal<string>('');
  readonly subtitle = signal<string>('');
}
