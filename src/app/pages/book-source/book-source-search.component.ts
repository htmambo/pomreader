import { ChangeDetectionStrategy, Component, inject } from '@angular/core';

import { FormsModule } from '@angular/forms';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzListModule } from 'ng-zorro-antd/list';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { NzSpinModule } from 'ng-zorro-antd/spin';
import { NzAlertModule } from 'ng-zorro-antd/alert';
import { NzTagModule } from 'ng-zorro-antd/tag';
import { NzModalService } from 'ng-zorro-antd/modal';
import { type SearchResultItem } from '../../core/book-source/multi-source-search.service';
import { SourceSearchStateService } from '../../core/book-source/source-search-state.service';
import { ToastService } from '../../core/services/toast.service';
import { ImportOnlineComponent } from '../../modals/import-online/import-online.component';

/**
 * 书源搜索页（实施计划 T-006 + spec FR-2；v2 并入书源管理 Tab）
 *
 * - 跨书源聚合搜索（MultiSourceSearchService）
 * - 加载态 / 空态 / 部分失败容错
 * - 命中项可「导入书架」：跳 /import-online 并预填 URL + 书源（导入 modal 选书源用）
 * - 现场状态（关键词/结果/进度）由 SourceSearchStateService 会话级持有，
 *   路由切换后回来直接恢复，搜索中途切走异步搜索继续跑
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-book-source-search',
  imports: [
    FormsModule,
    NzInputModule,
    NzButtonModule,
    NzListModule,
    NzIconModule,
    NzSpinModule,
    NzAlertModule,
    NzTagModule,
  ],
  template: `
    <div class="search-bar">
      <input
        nz-input
        [ngModel]="state.keyword()"
        (ngModelChange)="state.keyword.set($event)"
        (keyup.enter)="search()"
        placeholder="输入书名或作者"
        [disabled]="state.loading()"
      />
      <button
        nz-button
        nzType="primary"
        [disabled]="state.loading() || !state.keyword().trim()"
        (click)="search()"
      >
        <span nz-icon [nzType]="state.loading() ? 'loading' : 'search'"></span>
        {{ state.loading() ? '搜索中' : '搜索' }}
      </button>
    </div>

    @if (state.loading()) {
      <div class="state-block">
        <nz-spin nzSimple></nz-spin>
        @if (state.progress().phase === 'preparing') {
          <p>
            正在准备搜索{{
              state.progress().total > 0 ? '（共 ' + state.progress().total + ' 个书源）' : ''
            }}
          </p>
        } @else if (state.progress().phase === 'searching') {
          <p>正在搜索: {{ state.progress().current }}</p>
          <p class="progress-detail">
            已完成 {{ state.progress().done }} / 共 {{ state.progress().total }}
          </p>
        } @else if (state.progress().phase === 'finalizing') {
          <p>正在合并结果...</p>
        }
      </div>
    } @else if (state.searched() && state.results().length === 0) {
      <nz-alert
        nzType="info"
        nzMessage="未找到匹配结果"
        nzDescription="请尝试更换关键词，或确认书源支持搜索功能"
        nzShowIcon
      ></nz-alert>
    } @else if (state.results().length > 0) {
      <div class="result-meta">命中 {{ state.results().length }} 条，去重后展示</div>
      <ul nz-list nzBordered>
        @for (r of state.results(); track r.url + r.source) {
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
      :host-context([data-pom-theme='6']) .book-name {
        color: #f0f0f0;
      }
      :host-context([data-pom-theme='6']) .intro {
        color: #9a9a9a;
      }
      :host-context([data-pom-theme='6']) .url {
        color: #6a8fb5;
      }
      :host-context([data-pom-theme='6']) .url:hover {
        color: #8fb5d9;
      }
      :host-context([data-pom-theme='6']) .latency {
        color: #6a6a6a;
      }
      :host-context([data-pom-theme='6']) .result-meta {
        color: #888;
      }
    `,
  ],
})
export class BookSourceSearchComponent {
  /** 会话级搜索现场（root service，路由切换不丢） */
  readonly state = inject(SourceSearchStateService);
  private readonly modal = inject(NzModalService);
  private readonly toast = inject(ToastService);

  /** 触发搜索：编排在 state service，搜索中途切走仍继续跑 */
  search(): void {
    void this.state.search();
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
