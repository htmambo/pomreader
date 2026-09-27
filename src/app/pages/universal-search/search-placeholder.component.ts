import { ChangeDetectionStrategy, Component } from '@angular/core';

/**
 * /search 路由占位组件
 * 万能搜索已改为 AppComponent 外壳常驻保活（webview 元素一旦离开 DOM 即销毁 guest，
 * 路由切换会丢失 URL/历史/滚动），此路由仅承载标题 data 与占位；
 * 真正的 <app-universal-search> 由外壳在访问过 /search 后挂载并以 display:none 隐藏
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-search-placeholder',
  standalone: true,
  template: '',
})
export class SearchPlaceholderComponent {}
