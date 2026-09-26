import { Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { NZ_MODAL_DATA } from 'ng-zorro-antd/modal';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzListModule } from 'ng-zorro-antd/list';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { NzSelectModule } from 'ng-zorro-antd/select';
import { NzSpinModule } from 'ng-zorro-antd/spin';
import { BookSourceRegistry } from '../../core/book-source/book-source.registry';
import { FetchError, FETCH_ERROR_MESSAGES } from '../../core/book-source/fetch-error';
import { ResolvedBook } from '../../core/book-source/book-source.adapter';
import {
  ImportViaSourceService,
  SourceSearchHit,
} from '../../core/book-source/import-via-source.service';
import { ToastService } from '../../core/services/toast.service';
import { BookService } from '../../core/services/book.service';
import { Book } from '../../core/models/book.model';
import { randomCoverFor } from '../../core/cover/generators/random';

type ImportMode = 'url' | 'keyword';

/**
 * 导入在线书页（modal 内容组件）
 * - URL 模式：填 URL → 解析目录 → 入库（沿用 BookService.importOnlineBook）
 * - 关键词模式：选书源 + 输入关键词 → 搜索结果列表 → 点击跳 URL 模式 + 解析
 * 实施计划 T-007：在 v1 仅 URL 模式上新增「选书源 + 关键词搜索」入口
 */
@Component({
  selector: 'app-import-online',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    NzInputModule,
    NzButtonModule,
    NzListModule,
    NzIconModule,
    NzSelectModule,
    NzSpinModule,
  ],
  template: `
    <div class="import-online">
      <p class="hint">输入书页完整 URL 或按书源搜索关键词（支持笔趣阁等 5 站 + 通用启发式 + JS 书源）：</p>

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
        >URL 导入</button>
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
            [disabled]="loading() || importing()"
            (keyup.enter)="parse()"
            style="flex: 1;"
          />
          <button
            nz-button
            nzType="primary"
            (click)="parse()"
            [disabled]="!url.trim() || loading() || importing()"
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
        <p class="hint">命中 {{ searchResults().length }} 条，点击进入 URL 导入：</p>
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
        <p class="hint">共 {{ resolved()!.chapters.length }} 章，点击下方"确认导入"加入书架</p>
        <ul nz-list nzSize="small" nzBordered class="modal-list-scrollable">
          @for (ch of resolved()!.chapters; track ch.url; let i = $index) {
            <li nz-list-item>{{ i + 1 }}. {{ ch.title }}</li>
          }
        </ul>
      }

      @if (importing()) {
        <p class="hint">正在加入书架并预加载前 3 章...</p>
      }
    </div>
  `,
  styles: [
    `
      .import-online {
        min-height: 240px;
      }
      .source-selector {
        display: flex;
        align-items: center;
        gap: 8px;
        margin: 12px 0;
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
        margin: 16px 0;
        color: var(--pom-text);
      }
      .hint.error {
        color: #cf1322;
        display: flex;
        align-items: center;
        gap: 6px;
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
    `,
  ],
})
export class ImportOnlineComponent {
  url = '';
  keyword = '';
  /** nz-select 用字符串 model（signal 包装便于模板双向绑定） */
  selectedSourceModel = '';
  readonly mode = signal<ImportMode>('url');
  readonly sources = signal<string[]>([]);
  readonly selectedSource = signal<string>('');
  readonly searchResults = signal<SourceSearchHit[]>([]);
  readonly searched = signal(false);

  readonly loading = signal(false);
  readonly importing = signal(false);
  readonly resolved = signal<ResolvedBook | null>(null);
  readonly errorMsg = signal('');

  private readonly importViaSource = inject(ImportViaSourceService);
  private readonly registry = inject(BookSourceRegistry);
  private readonly toast = inject(ToastService);
  private readonly books = inject(BookService);
  readonly modalData = inject(NZ_MODAL_DATA, { optional: true });

  ngOnInit(): void {
    this.sources.set(this.importViaSource.supportedSources());
    if (this.modalData && typeof this.modalData === 'object') {
      const data = this.modalData as Record<string, unknown>;
      if (typeof data['source'] === 'string') {
        this.selectedSourceModel = data['source'];
        this.selectedSource.set(data['source']);
      }
      if (typeof data['url'] === 'string') {
        this.url = data['url'];
        this.mode.set('url');
        void this.parse();
      }
    }
  }

  /** nz-select 变更：更新 signal + 清空搜索/解析态 */
  onSourceChange(name: string): void {
    this.selectedSource.set(name || '');
    this.searchResults.set([]);
    this.searched.set(false);
    this.resolved.set(null);
    this.errorMsg.set('');
  }

  setMode(m: ImportMode): void {
    this.mode.set(m);
    this.resolved.set(null);
    this.searchResults.set([]);
    this.searched.set(false);
    this.errorMsg.set('');
  }

  /** 关键词模式：调书源 search() → 渲染结果列表 */
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

  /** 命中项 → 切 URL 模式 + 解析 */
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
      const r = await this.importViaSource.importByUrl(this.url, src);
      this.resolved.set(r);
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

  async confirm(): Promise<boolean> {
    const r = this.resolved();
    if (!r || r.chapters.length === 0) {
      this.toast.warn('请先解析一个有效的 URL');
      return false;
    }
    this.importing.set(true);
    try {
      const id = `online-${Date.now()}`;
      const bookTitle = r.title || this.url;
      const bookAuthor = r.author || '未知';
      const book: Book = {
        id,
        title: bookTitle,
        author: bookAuthor,
        ...(r.kind ? { kind: r.kind } : {}),
        coverColor: '#177ddc',
        // 解析器目前不返回源站封面 URL —— 随机选一款内置 SVG 模板作为兜底
        coverImageUrl: randomCoverFor({ title: bookTitle, author: bookAuthor, kind: r.kind }),
        chapterCount: r.chapters.length,
        totalChars: r.chapters.length * 2000,
        importedAt: new Date().toISOString(),
        source: 'online',
        sourceUrl: this.url,
      };
      await this.books.importOnlineBook(book, r.chapters);
      this.toast.success(`已导入：${book.title}`);
      this.importing.set(false);
      return true;
    } catch (e) {
      this.toast.error(`导入失败：${(e as Error).message}`);
      this.importing.set(false);
      return false;
    }
  }
}