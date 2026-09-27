import { Injectable, inject, signal } from '@angular/core';
import { MultiSourceSearchService, type SearchResultItem } from './multi-source-search.service';
import { ToastService } from '../services/toast.service';

/**
 * 书源聚合搜索页会话级状态（root service，路由切换不销毁）
 *
 * 设计要点：
 * - 组件销毁时状态不丢：关键词 / 结果 / 进度全部由本服务持有
 * - 搜索编排放这里：用户搜索中途切走，异步搜索继续跑，回来能看到最新进度 / 结果
 * - 重复进页直接展示上次现场，不自动重搜（用户手动再点搜索）
 */
@Injectable({ providedIn: 'root' })
export class SourceSearchStateService {
  private readonly searchSvc = inject(MultiSourceSearchService);
  private readonly toast = inject(ToastService);

  /** 搜索关键词（输入框双向绑定） */
  readonly keyword = signal('');
  /** 是否已发起过搜索（区分「未搜索」与「搜索无结果」两种空态） */
  readonly searched = signal(false);
  /** 聚合去重后的搜索结果 */
  readonly results = signal<SearchResultItem[]>([]);
  /** 本次参与搜索的实际书源数 */
  readonly sourceCount = signal(0);
  /** 搜索实时进度（直接复用 searchSvc.progress —— 同源 signal，搜索中途切走仍实时更新） */
  readonly progress = this.searchSvc.progress;
  readonly loading = signal(false);

  /** 触发一次聚合搜索；组件只调用本方法，不持有编排逻辑 */
  async search(): Promise<void> {
    const kw = this.keyword().trim();
    if (!kw) return;

    this.loading.set(true);
    this.searched.set(true);
    try {
      const items = await this.searchSvc.searchAll(kw);
      this.results.set(items);
      // sourceCount 同步为本次参与搜索的实际源数
      this.sourceCount.set(this.searchSvc.progress().total);
      if (items.length === 0) {
        // 暴露源失败原因到 UI —— 排查"为什么搜不到"的关键线索
        const errors = this.searchSvc.lastErrors;
        if (errors.length > 0) {
          const summary = errors.slice(0, 3).join('；');
          this.toast.warn(
            `未找到结果，${errors.length} 个书源失败：${summary}${errors.length > 3 ? '…' : ''}`,
          );
        } else {
          this.toast.info('未找到匹配结果');
        }
      }
    } catch (e) {
      // searchAll 内部已隔离单源失败；此处只兜底整体异常
      this.toast.error(`搜索失败：${(e as Error).message}`);
    } finally {
      this.loading.set(false);
    }
  }
}
