import { Component, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { NZ_MODAL_DATA } from 'ng-zorro-antd/modal';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzListModule } from 'ng-zorro-antd/list';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { NzSelectModule } from 'ng-zorro-antd/select';
import { NzSpinModule } from 'ng-zorro-antd/spin';
import { NzAlertModule } from 'ng-zorro-antd/alert';
import { Book } from '../../../core/models/book.model';
import { BookSourceRegistry } from '../../../core/book-source/book-source.registry';
import {
  ImportViaSourceService,
  SourceSearchHit,
} from '../../../core/book-source/import-via-source.service';
import { FetchError, FETCH_ERROR_MESSAGES } from '../../../core/book-source/fetch-error';
import { ResolvedBook } from '../../../core/book-source/book-source.adapter';
import { BookService } from '../../../core/services/book.service';
import { ToastService } from '../../../core/services/toast.service';
import { UNIVERSAL_BOOK_SOURCE_UUID } from '../../../core/book-source/book-source.constants';

interface ChangeBookSourceData {
  book: Book;
}

type ChangeMode = 'url' | 'keyword';

/**
 * 换源弹窗（modal 内容组件）
 *
 * 入口：书卡右键菜单「换源」（仅 online 来源）→ bookshelf 通过 NzModalService.create 弹出
 *
 * UI 流程（参考 ImportOnlineComponent）：
 * - 顶部展示当前源信息 + 阅读进度，让用户预知影响
 * - 关键词模式：选书源 + 输入关键词（默认填旧书名）→ 搜索 → 点击命中项跳 URL 模式
 * - URL 模式：填 URL → 解析
 * - 解析成功后展示预览（标题 / 作者 / 章节数）+ 警告提示
 * - nzOnOk 回调调 bookService.changeBookSource；成功返回 true（modal 关闭）
 */
@Component({
  selector: 'app-change-book-source-dialog',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    FormsModule,
    NzInputModule,
    NzButtonModule,
    NzListModule,
    NzIconModule,
    NzSelectModule,
    NzSpinModule,
    NzAlertModule,
  ],
  template: `
    <div class="change-source">
      <div class="book-times">
        <span>当前源：{{ currentSourceLabel() }}</span>
        <span>共 {{ data.book.chapterCount }} 章</span>
        @if (data.book.progress) {
          <span>已读至第 {{ data.book.progress.chapterIndex + 1 }} 章</span>
        }
      </div>

      <nz-alert
        nzType="warning"
        nzShowIcon
        nzMessage="将替换章节列表与正文缓存；阅读进度保留"
        nzDescription="原章节 URL 与缓存正文将失效，新章节按需重新抓取。已读位置自动夹取到新章节范围。"
        style="margin: 8px 0 12px;"
      ></nz-alert>

      <div class="source-selector">
        <label class="source-label">书源：</label>
        <nz-select
          [(ngModel)]="selectedSourceModel"
          (ngModelChange)="onSourceChange($event)"
          style="min-width: 180px;"
          nzPlaceHolder="选择书源"
        >
          <nz-option
            *ngFor="let s of sources()"
            [nzValue]="s"
            [nzLabel]="s"
          ></nz-option>
        </nz-select>
      </div>

      <div class="mode-tabs">
        <button
          type="button"
          nz-button
          nzSize="small"
          [nzType]="mode() === 'url' ? 'primary' : 'default'"
          (click)="setMode('url')"
        >URL 换源</button>
        <button
          type="button"
          nz-button
          nzSize="small"
          [nzType]="mode() === 'keyword' ? 'primary' : 'default'"
          (click)="setMode('keyword')"
          [disabled]="!selectedSource()"
        >关键词搜索</button>
      </div>

      @if (mode() === 'url') {
        <div class="url-row">
          <input
            nz-input
            placeholder="https://example.com/book/123/"
            [(ngModel)]="url"
            [disabled]="loading() || changing()"
            (keyup.enter)="parse()"
            style="flex: 1;"
          />
          <button
            nz-button
            nzType="primary"
            (click)="parse()"
            [disabled]="!url.trim() || loading() || changing()"
          >
            {{ loading() ? '解析中...' : '解析' }}
          </button>
        </div>
      } @else {
        <div class="url-row">
          <input
            nz-input
            placeholder="输入书名或作者"
            [(ngModel)]="keyword"
            [disabled]="loading() || !selectedSource()"
            (keyup.enter)="searchKeyword()"
            style="flex: 1;"
          />
          <button
            nz-button
            nzType="primary"
            (click)="searchKeyword()"
            [disabled]="!keyword.trim() || !selectedSource() || loading()"
          >
            {{ loading() ? '搜索中...' : '搜索' }}
          </button>
        </div>
      }

      @if (loading()) {
        <div class="state-block">
          <nz-spin nzSimple></nz-spin>
          <p class="hint">{{ mode() === 'keyword' ? '搜索中...' : '解析中...' }}</p>
        </div>
      } @else if (errorMsg()) {
        <p class="hint error">
          <span nz-icon nzType="warning"></span>
          {{ errorMsg() }}
        </p>
      } @else if (mode() === 'keyword' && searched() && searchResults().length > 0) {
        <p class="hint">命中 {{ searchResults().length }} 条，点击进入 URL 解析：</p>
        <ul nz-list nzSize="small" nzBordered class="modal-list-scrollable">
          @for (r of searchResults(); track r.url) {
            <li
              nz-list-item
              class="search-hit"
              (click)="selectSearchResult(r)"
            >
              <span class="hit-name">{{ r.name || '（无书名）' }}</span>
              @if (r.author) {
                <span class="hit-author">— {{ r.author }}</span>
              }
              <span class="hit-url">{{ r.url }}</span>
            </li>
          }
        </ul>
      } @else if (resolved()) {
        <h4>{{ resolved()!.title }} <small>({{ resolved()!.author }})</small></h4>
        <p class="hint">
          共 {{ resolved()!.chapters.length }} 章
          @if (chapterDiff() !== 0) {
            <span class="diff">(原 {{ data.book.chapterCount }} 章，{{ chapterDiffLabel() }})</span>
          }
          ，点击「确认换源」保存
        </p>
        <ul nz-list nzSize="small" nzBordered class="modal-list-scrollable preview-list">
          @for (ch of resolved()!.chapters; track ch.url; let i = $index) {
            <li nz-list-item>{{ i + 1 }}. {{ ch.title }}</li>
          }
          @if (resolved()!.chapters.length > 20) {
            <li nz-list-item class="more">... 仅展示前 20 章</li>
          }
        </ul>
      }

      @if (changing()) {
        <p class="hint">正在换源（替换章节列表 + 预加载前 3 章）...</p>
      }
    </div>
  `,
  styles: [
    `
      .change-source {
        min-height: 280px;
      }
      .book-times {
        display: flex;
        gap: 16px;
        flex-wrap: wrap;
        margin: 0 0 8px;
        padding: 6px 10px;
        border-radius: 4px;
        background: var(--pom-bg);
        font-size: 12px;
        color: var(--pom-text-muted);
      }
      .source-selector {
        display: flex;
        align-items: center;
        gap: 8px;
        margin: 8px 0;
      }
      .source-label {
        color: var(--pom-text-muted, #888);
        font-size: 13px;
      }
      .mode-tabs {
        display: flex;
        gap: 8px;
        margin: 8px 0 12px;
      }
      .url-row {
        display: flex;
        gap: 8px;
        align-items: center;
      }
      .hint {
        margin: 12px 0;
        color: var(--pom-text);
      }
      .hint.error {
        color: #cf1322;
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .diff {
        color: var(--pom-text-muted);
        font-size: 12px;
      }
      h4 {
        margin: 16px 0 8px;
        color: var(--pom-text-muted);
      }
      small {
        color: var(--pom-text);
        font-weight: normal;
      }
      .state-block {
        text-align: center;
        padding: 16px 0;
        color: var(--pom-text-muted, #888);
      }
      .state-block p {
        margin-top: 8px;
      }
      .search-hit {
        cursor: pointer;
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .search-hit:hover {
        background: var(--pom-hover, rgba(0, 0, 0, 0.04));
      }
      .hit-name {
        font-weight: 600;
      }
      .hit-author {
        color: var(--pom-text-muted, #888);
        font-size: 12px;
      }
      .hit-url {
        color: var(--pom-text-muted, #888);
        font-size: 11px;
        word-break: break-all;
      }
      .preview-list {
        max-height: 200px;
        overflow-y: auto;
      }
      .more {
        color: var(--pom-text-muted);
        font-style: italic;
        text-align: center;
      }
    `,
  ],
})
export class ChangeBookSourceDialogComponent {
  protected readonly data = inject<ChangeBookSourceData>(NZ_MODAL_DATA);
  private readonly importViaSource = inject(ImportViaSourceService);
  private readonly registry = inject(BookSourceRegistry);
  private readonly books = inject(BookService);
  private readonly toast = inject(ToastService);

  url = '';
  keyword = '';
  /** nz-select 用字符串 model */
  selectedSourceModel = '';
  readonly mode = signal<ChangeMode>('keyword');
  readonly sources = signal<string[]>([]);
  readonly selectedSource = signal<string>('');
  readonly searchResults = signal<SourceSearchHit[]>([]);
  readonly searched = signal(false);

  readonly loading = signal(false);
  readonly changing = signal(false);
  readonly resolved = signal<ResolvedBook | null>(null);
  readonly errorMsg = signal('');

  /** 当前源显示文案（书源 UUID → 书源 name；universal fallback 显示「万能搜索」） */
  currentSourceLabel(): string {
    const uuid = this.data.book.bookSourceUuid;
    if (!uuid || uuid === UNIVERSAL_BOOK_SOURCE_UUID) return '万能搜索 / 启发式';
    const adapter = this.registry.getByUuid(uuid);
    return adapter?.name ?? `未知（${uuid.slice(0, 8)}…）`;
  }

  /** 新旧章节数差（正数 = 新增章数；负数 = 减少章数；0 = 一致） */
  chapterDiff(): number {
    const r = this.resolved();
    return r ? r.chapters.length - this.data.book.chapterCount : 0;
  }

  chapterDiffLabel(): string {
    const d = this.chapterDiff();
    return d > 0 ? `增加 ${d} 章` : `减少 ${-d} 章`;
  }

  constructor() {
    this.sources.set(this.importViaSource.supportedSources());
    // 默认书源：若当前书的 bookSourceUuid 能解析到具体书源，优先选中
    const uuid = this.data.book.bookSourceUuid;
    if (uuid && uuid !== UNIVERSAL_BOOK_SOURCE_UUID) {
      const adapter = this.registry.getByUuid(uuid);
      if (adapter) {
        this.selectedSourceModel = adapter.name;
        this.selectedSource.set(adapter.name);
      }
    }
    // 默认关键词：旧书名
    this.keyword = this.data.book.title;
  }

  onSourceChange(name: string): void {
    this.selectedSource.set(name || '');
    this.searchResults.set([]);
    this.searched.set(false);
    this.resolved.set(null);
    this.errorMsg.set('');
  }

  setMode(m: ChangeMode): void {
    this.mode.set(m);
    this.resolved.set(null);
    this.searchResults.set([]);
    this.searched.set(false);
    this.errorMsg.set('');
  }

  async searchKeyword(): Promise<void> {
    const kw = this.keyword.trim();
    const src = this.selectedSource();
    if (!src) {
      this.toast.warn('请先选择书源');
      return;
    }
    if (!kw) {
      this.toast.warn('请输入关键词');
      return;
    }
    this.loading.set(true);
    this.errorMsg.set('');
    this.searched.set(true);
    try {
      const hits = await this.importViaSource.searchAndSelect(kw, src);
      this.searchResults.set(hits);
      if (hits.length === 0) {
        this.toast.info('该书源无搜索结果');
      }
    } catch (e) {
      const msg = e instanceof FetchError
        ? FETCH_ERROR_MESSAGES[e.code]
        : `搜索失败：${(e as Error).message}`;
      this.errorMsg.set(msg);
      this.toast.error(msg);
      this.searchResults.set([]);
    } finally {
      this.loading.set(false);
    }
  }

  async selectSearchResult(r: SourceSearchHit): Promise<void> {
    this.url = r.url;
    this.mode.set('url');
    this.searchResults.set([]);
    await this.parse();
  }

  async parse(): Promise<void> {
    if (!this.url.trim()) {
      this.toast.warn('请输入 URL');
      return;
    }
    this.loading.set(true);
    this.resolved.set(null);
    this.errorMsg.set('');
    try {
      const src = this.selectedSource() || undefined;
      const { book } = await this.importViaSource.importByUrl(this.url, src);
      this.resolved.set(book);
    } catch (e) {
      const msg = e instanceof FetchError
        ? FETCH_ERROR_MESSAGES[e.code]
        : `解析失败：${(e as Error).message}`;
      this.errorMsg.set(msg);
      this.toast.error(msg);
    } finally {
      this.loading.set(false);
    }
  }

  /**
   * nzOnOk 回调：执行换源，成功返回 true（modal 关闭）。
   * 失败抛错并返回 false（modal 保持打开，错误已在 errorMsg signal 提示）。
   */
  async confirm(): Promise<boolean> {
    const r = this.resolved();
    if (!r || r.chapters.length === 0) {
      this.toast.warn('请先解析一个有效的 URL');
      return false;
    }
    this.changing.set(true);
    try {
      await this.books.changeBookSource(
        this.data.book.id,
        this.url,
        this.selectedSource() || undefined,
      );
      this.toast.success(`换源完成：${r.title}`);
      return true;
    } catch (e) {
      const msg = e instanceof FetchError
        ? FETCH_ERROR_MESSAGES[e.code]
        : `换源失败：${(e as Error).message}`;
      this.toast.error(msg);
      this.errorMsg.set(msg);
      return false;
    } finally {
      this.changing.set(false);
    }
  }
}