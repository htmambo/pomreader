import { Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzTagModule } from 'ng-zorro-antd/tag';
import { NzListModule } from 'ng-zorro-antd/list';
import { NzCheckboxModule } from 'ng-zorro-antd/checkbox';
import { NzSpinModule } from 'ng-zorro-antd/spin';
import { NzAlertModule } from 'ng-zorro-antd/alert';
import { NzProgressModule } from 'ng-zorro-antd/progress';
import { PageHeaderComponent } from '../../shared/components/page-header/page-header.component';
import { ToastService } from '../../core/services/toast.service';
import {
  SourceMarketService,
  RepoManifest,
  RepoManifestSource,
  InstallProgress,
} from '../../core/book-source/source-market/source-market.service';

/**
 * 书源市场页（实施计划 T-011 + spec FR-2）
 *
 * 流程：拉取远端仓库清单 → 勾选条目 → 批量 3 并发安装 → 进度条 + 收尾 toast
 * v1 简化：版本徽标仅显示版本号；upgrade/downgrade 提示留 v2
 */
@Component({
  selector: 'app-source-market',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    NzButtonModule,
    NzIconModule,
    NzInputModule,
    NzTagModule,
    NzListModule,
    NzCheckboxModule,
    NzSpinModule,
    NzAlertModule,
    NzProgressModule,
    PageHeaderComponent,
  ],
  template: `
    <app-page-header title="书源市场" subtitle="从仓库一键安装书源"></app-page-header>

    <div class="repo-row">
      <input
        nz-input
        [(ngModel)]="repoUrl"
        placeholder="仓库清单 JSON 地址（https://.../repo.json）"
        [disabled]="loading()"
        (keyup.enter)="load(true)"
      />
      <button
        nz-button
        nzType="primary"
        (click)="load(true)"
        [disabled]="loading() || !repoUrl.trim()"
      >
        <span nz-icon nzType="cloud-download"></span>
        {{ loading() ? '拉取中...' : '拉取' }}
      </button>
    </div>

    @if (loading()) {
      <div class="loading-wrap"><nz-spin nzSimple></nz-spin></div>
    } @else if (manifest()) {
      <div class="market-meta">
        <span>{{ manifest()!.name }} v{{ manifest()!.version }}</span>
        <span class="dot">·</span>
        <span>更新于 {{ manifest()!.updatedAt }}</span>
      </div>

      <div class="actions">
        <button
          nz-button
          nzType="primary"
          (click)="installSelected()"
          [disabled]="selected().length === 0 || installing()"
        >
          <span nz-icon nzType="download"></span>
          一键安装（{{ selected().length }}）
        </button>
      </div>

      <ul nz-list>
        @for (src of manifest()!.sources; track src.fileName) {
          <li nz-list-item>
            <label nz-checkbox [ngModel]="selectedSet[src.fileName]" (ngModelChange)="toggle(src, $event)">
              <div class="source-row">
                <h4>
                  {{ src.name }}
                  @if (src.version) {
                    <nz-tag class="ver">{{ src.version }}</nz-tag>
                  }
                </h4>
                <p class="meta">{{ src.author || '未知作者' }} · v{{ src.version || '?' }}</p>
                @if (src.description) {
                  <p class="desc">{{ src.description }}</p>
                }
              </div>
            </label>
          </li>
        }
      </ul>

      @if (installing()) {
        <nz-progress [nzPercent]="progressPercent()" nzStatus="active"></nz-progress>
      }
    } @else if (error()) {
      <nz-alert
        nzType="error"
        [nzMessage]="error()"
        nzDescription="请检查仓库地址是否正确（内置占位地址尚不可用，需粘贴真实仓库清单 JSON 地址后点「拉取」）"
      ></nz-alert>
    } @else if (needsRepoUrl()) {
      <nz-alert
        nzType="info"
        nzMessage="尚未配置书源仓库"
        nzDescription="在上方输入框粘贴仓库清单 JSON 地址（含 sources 数组的 repo.json），点「拉取」即可浏览并一键安装书源；地址会本地保存，下次自动加载。"
        nzShowIcon
      ></nz-alert>
    }
  `,
  styles: [
    `
      .loading-wrap { padding: 24px; text-align: center; }
      .repo-row { display: flex; gap: 8px; margin-bottom: 16px; }
      .repo-row input { flex: 1; }
      .repo-row button { flex: 0 0 auto; }
      .market-meta { color: var(--pom-text-muted); font-size: 13px; margin-bottom: 12px; display: flex; gap: 6px; }
      .dot { opacity: 0.5; }
      .actions { margin-bottom: 12px; display: flex; gap: 8px; }
      .source-row h4 { margin: 0 0 4px; font-size: 14px; font-weight: 600; color: var(--pom-text); display: flex; align-items: center; gap: 8px; }
      .source-row .ver { font-size: 11px; }
      .source-row .meta { margin: 0 0 2px; font-size: 12px; color: var(--pom-text-muted); }
      .source-row .desc { margin: 0; font-size: 12px; color: var(--pom-text-muted); }
      nz-progress { margin-top: 16px; display: block; }
    `,
  ],
})
export class SourceMarketComponent {
  readonly manifest = signal<RepoManifest | null>(null);
  readonly loading = signal(false);
  readonly error = signal('');
  readonly selected = signal<RepoManifestSource[]>([]);
  readonly installing = signal(false);
  readonly progress = signal<InstallProgress | null>(null);

  /** 仓库地址输入框（双向绑定）；初始值取 localStorage 覆盖值或内置占位 */
  repoUrl = '';
  /** true = 尚未保存过仓库地址（首启展示引导提示而非自动拉取） */
  readonly needsRepoUrl = signal(false);

  /** 复选框状态：fileName → bool；与 selected() signal 双向同步 */
  selectedSet: Record<string, boolean> = {};

  readonly progressPercent = computed(() => {
    const p = this.progress();
    if (!p || p.total === 0) return 0;
    return Math.round((p.done / p.total) * 100);
  });

  private readonly market = inject(SourceMarketService);
  private readonly toast = inject(ToastService);

  constructor() {
    this.repoUrl = this.market.getRepoUrl();
    // 仅当用户保存过仓库地址时才自动拉取 —— 内置占位 URL 尚不存在，避免首启必发一次必 404 的请求
    this.needsRepoUrl.set(!this.market.getSavedRepoUrl());
    if (!this.needsRepoUrl()) void this.load();
  }

  /** 拉取仓库清单；userTriggered=true 时成功则持久化 URL */
  async load(userTriggered = false): Promise<void> {
    const url = this.repoUrl.trim();
    if (!url) return;
    this.loading.set(true);
    this.error.set('');
    try {
      this.manifest.set(await this.market.fetchRepo(url));
      if (userTriggered) {
        this.market.setRepoUrl(url);
        this.needsRepoUrl.set(false);
      }
    } catch (e) {
      this.manifest.set(null);
      this.error.set(`仓库拉取失败：${(e as Error).message}`);
    } finally {
      this.loading.set(false);
    }
  }

  /** 切换勾选：根据当前 checkbox 状态增删 selected() */
  toggle(src: RepoManifestSource, checked: boolean): void {
    this.selectedSet[src.fileName] = checked;
    if (checked) {
      this.selected.update((arr) => (arr.some((s) => s.fileName === src.fileName) ? arr : [...arr, src]));
    } else {
      this.selected.update((arr) => arr.filter((s) => s.fileName !== src.fileName));
    }
  }

  /** 批量安装选中项：3 并发 + 进度回调 + 收尾 toast */
  async installSelected(): Promise<void> {
    if (this.selected().length === 0) return;
    this.installing.set(true);
    try {
      const result = await this.market.installBatch(this.selected(), (p) => this.progress.set(p));
      this.toast.success(`安装完成：${result.succeeded.length} 成功，${result.failed.length} 失败`);
      if (result.failed.length > 0) {
        // 失败明细仅打印控制台，前端不展示（v1 简化）
        console.warn('[source-market] 安装失败明细:', result.failed);
      }
    } catch (e) {
      this.toast.error(`安装失败：${(e as Error).message}`);
    } finally {
      this.installing.set(false);
      this.progress.set(null);
      this.selected.set([]);
      this.selectedSet = {};
    }
  }
}
