import { Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzListModule } from 'ng-zorro-antd/list';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { NzSpinModule } from 'ng-zorro-antd/spin';
import { NzAlertModule } from 'ng-zorro-antd/alert';
import { NzTagModule } from 'ng-zorro-antd/tag';
import { NzModalService } from 'ng-zorro-antd/modal';
import { MultiSourceSearchService, SearchResultItem, SearchProgress } from '../../core/book-source/multi-source-search.service';
import { ToastService } from '../../core/services/toast.service';
import { BookSourceTabsComponent } from '../../shared/components/book-source-tabs/book-source-tabs.component';
import { ImportOnlineComponent } from '../../modals/import-online/import-online.component';

/**
 * 书源搜索页（实施计划 T-006 + spec FR-2；v2 并入书源管理 Tab）
 *
 * - 跨书源聚合搜索（MultiSourceSearchService）
 * - 加载态 / 空态 / 部分失败容错
 * - 命中项可「导入书架」：跳 /import-online 并预填 URL + 书源（导入 modal 选书源用）
 */
@Component({
  selector: 'app-source-search',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    NzInputModule,
    NzButtonModule,
    NzListModule,
    NzIconModule,
    NzSpinModule,
    NzAlertModule,
    NzTagModule,
    BookSourceTabsComponent,
  ],
  template: `
    <app-book-source-tabs />

    <div class="search-bar">
      <input
        nz-input
        [(ngModel)]="keyword"
        (keyup.enter)="search()"
        placeholder="输入书名或作者"
        [disabled]="loading()"
      />
      <button
        nz-button
        nzType="primary"
        [disabled]="loading() || !keyword.trim()"
        (click)="search()"
      >
        <span nz-icon [nzType]="loading() ? 'loading' : 'search'"></span>
        {{ loading() ? '搜索中' : '搜索' }}
      </button>
    </div>

    @if (loading()) {
      <div class="state-block">
        <nz-spin nzSimple></nz-spin>
        @if (progress().phase === 'preparing') {
          <p>正在准备搜索{{ progress().total > 0 ? '（共 ' + progress().total + ' 个书源）' : '' }}</p>
        } @else if (progress().phase === 'searching') {
          <p>正在搜索: {{ progress().current }}</p>
          <p class="progress-detail">已完成 {{ progress().done }} / 共 {{ progress().total }}</p>
        } @else if (progress().phase === 'finalizing') {
          <p>正在合并结果...</p>
        }
      </div>
    } @else if (searched() && results().length === 0) {
      <nz-alert
        nzType="info"
        nzMessage="未找到匹配结果"
        nzDescription="请尝试更换关键词，或确认书源支持搜索功能"
        nzShowIcon
      ></nz-alert>
    } @else if (results().length > 0) {
      <div class="result-meta">
        命中 {{ results().length }} 条，去重后展示
      </div>
      <ul nz-list nzBordered>
        @for (r of results(); track r.url + r.source) {
          <li nz-list-item class="result-item">
            <div class="result-main">
              <div class="result-line-1">
                <span class="book-name">{{ r.name || '（无书名）' }}</span>
                <nz-tag nzColor="blue">{{ r.author || '未知作者' }}</nz-tag>
                @if (r.kind) {
                  <nz-tag nzColor="cyan">{{ r.kind }}</nz-tag>
                }
                <nz-tag>{{ r.sourceName }}</nz-tag>
                <span class="latency">{{ r.latencyMs }}ms</span>
              </div>
              @if (r.intro) {
                <p class="intro">{{ r.intro }}</p>
              }
              <div class="result-line-2">
                <a [href]="r.url" target="_blank" rel="noopener" class="url">{{ r.url }}</a>
                <button nz-button nzSize="small" nzType="primary" (click)="importBook(r)">
                  <span nz-icon nzType="download"></span>
                  导入书架
                </button>
              </div>
            </div>
          </li>
        }
      </ul>
    } @else {
      <nz-alert
        nzType="info"
        nzMessage="提示"
        nzDescription="请输入关键词并点击搜索"
        nzShowIcon
      ></nz-alert>
    }
  `,
  styles: [
    `
      .search-bar {
        display: flex;
        gap: 8px;
        margin: 0 0 16px;
      }
      .search-bar input[nz-input] {
        flex: 1;
      }
      .state-block {
        text-align: center;
        padding: 48px 0;
        color: var(--pom-text-muted, #888);
      }
      .state-block p {
        margin-top: 12px;
      }
      .progress-detail {
        font-size: 12px;
        color: var(--pom-text-muted, #aaa);
      }
      .result-meta {
        font-size: 12px;
        color: var(--pom-text-muted, #888);
        margin: 8px 0;
      }
      .result-item {
        padding: 12px 16px;
      }
      .result-main {
        width: 100%;
      }
      .result-line-1 {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }
      .book-name {
        font-size: 15px;
        font-weight: 600;
        color: var(--pom-text, #333);
      }
      .latency {
        font-size: 11px;
        color: var(--pom-text-muted, #888);
        margin-left: auto;
      }
      .intro {
        margin: 8px 0;
        font-size: 13px;
        color: var(--pom-text-muted, #888);
        line-height: 1.5;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      .result-line-2 {
        display: flex;
        align-items: center;
        gap: 12px;
        margin-top: 6px;
      }
      .url {
        flex: 1;
        font-size: 11px;
        color: var(--pom-text-muted, #888);
        text-decoration: none;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .url:hover {
        text-decoration: underline;
      }
      /* 暗色主题适配：提升文字对比度、保留 muted 弱化但不刺眼 */
      :host-context([data-pom-theme='6']) .book-name { color: #f0f0f0; }
      :host-context([data-pom-theme='6']) .intro { color: #9a9a9a; }
      :host-context([data-pom-theme='6']) .url { color: #6a8fb5; }
      :host-context([data-pom-theme='6']) .url:hover { color: #8fb5d9; }
      :host-context([data-pom-theme='6']) .latency { color: #6a6a6a; }
      :host-context([data-pom-theme='6']) .result-meta { color: #888; }
    `,
  ],
})
export class SourceSearchComponent {
  private readonly searchSvc = inject(MultiSourceSearchService);
  private readonly modal = inject(NzModalService);
  private readonly toast = inject(ToastService);

  keyword = '';
  readonly loading = signal(false);
  readonly searched = signal(false);
  readonly results = signal<SearchResultItem[]>([]);
  readonly sourceCount = signal(0);
  readonly progress = signal<SearchProgress>({ phase: 'idle', done: 0, total: 0, current: '' });

  async search(): Promise<void> {
    const kw = this.keyword.trim();
    if (!kw) return;

    this.loading.set(true);
    this.searched.set(true);
    try {
      const items = await this.searchSvc.searchAll(kw);
      this.results.set(items);
      // 同步最终进度（done 阶段）；sourceCount 同步为本次参与搜索的实际源数
      this.progress.set(this.searchSvc.progress());
      this.sourceCount.set(this.searchSvc.progress().total);
      if (items.length === 0) {
        // 暴露源失败原因到 UI —— 排查"为什么搜不到"的关键线索
        const errors = this.searchSvc.lastErrors;
        if (errors.length > 0) {
          const summary = errors.slice(0, 3).join('；');
          this.toast.warn(`未找到结果，${errors.length} 个书源失败：${summary}${errors.length > 3 ? '…' : ''}`);
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

  /**
   * 弹导入 modal 并预填 URL + 书源（ImportOnlineComponent 通过 NZ_MODAL_DATA 自动 parse）
   * 之前用 router.navigate(['/import-online']) 跳到一个不存在的路由，会落到默认路由（书架），
   * 看上去像「跳到书架」，但其实没打开导入 modal；改成弹 modal 与 page-header / universal-search 一致
   */
  importBook(r: SearchResultItem): void {
    if (!r.url) {
      this.toast.warn('该条目缺少 URL，无法导入');
      return;
    }
    this.modal.create({
      nzTitle: '导入在线书页',
      nzContent: ImportOnlineComponent,
      nzData: { url: r.url, source: r.source },
      nzOkText: '确认导入',
      nzCancelText: '取消',
      nzWidth: 640,
      nzOnOk: (instance: ImportOnlineComponent) => instance.confirm(),
    });
  }
}
