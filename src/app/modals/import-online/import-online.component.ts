import { Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { NZ_MODAL_DATA } from 'ng-zorro-antd/modal';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzListModule } from 'ng-zorro-antd/list';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { BookSourceRegistry } from '../../core/book-source/book-source.registry';
import { FetchError, FETCH_ERROR_MESSAGES } from '../../core/book-source/fetch-error';
import { ResolvedBook } from '../../core/book-source/book-source.adapter';
import { ToastService } from '../../core/services/toast.service';
import { BookService } from '../../core/services/book.service';
import { Book } from '../../core/models/book.model';

/**
 * 导入在线书页（modal 内容组件）
 * 真实抓取：URL → BookSourceRegistry.fetchCatalog → 目录预览 → 导入入库 + 预加载前 3 章
 */
@Component({
  selector: 'app-import-online',
  standalone: true,
  imports: [CommonModule, FormsModule, NzInputModule, NzButtonModule, NzListModule, NzIconModule],
  template: `
    <div class="import-online">
      <p class="hint">输入书页完整 URL（支持笔趣阁等 5 站 + 通用启发式解析任意书源）：</p>
      <div class="url-row">
        <input
          nz-input
          placeholder="https://www.xbiquge.cc/book/9231/"
          [(ngModel)]="url"
          [disabled]="loading() || importing()"
          (keyup.enter)="parse()"
          style="flex: 1;"
        />
        <button nz-button nzType="primary" (click)="parse()" [disabled]="!url.trim() || loading()">
          {{ loading() ? '解析中...' : '解析' }}
        </button>
      </div>

      @if (loading()) {
        <p class="hint">解析中...</p>
      } @else if (errorMsg()) {
        <p class="hint error">
          <span nz-icon nzType="warning"></span>
          {{ errorMsg() }}
        </p>
      } @else if (resolved()) {
        <h4>{{ resolved()!.title }} <small>({{ resolved()!.author }})</small></h4>
        <p class="hint">共 {{ resolved()!.chapters.length }} 章，点击下方"确认导入"加入书架</p>
        <nz-list [nzDataSource]="resolved()!.chapters" [nzRenderItem]="chapterTpl" nzSize="small" nzBordered>
          <ng-template #chapterTpl let-item let-index>
            <nz-list-item>{{ index + 1 }}. {{ item.title }}</nz-list-item>
          </ng-template>
        </nz-list>
      }

      @if (importing()) {
        <p class="hint">正在加入书架并预加载前 3 章...</p>
      }
    </div>
  `,
  styles: [
    `
      .import-online {
        min-height: 200px;
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
    `,
  ],
})
export class ImportOnlineComponent {
  url = '';
  readonly loading = signal(false);
  readonly importing = signal(false);
  readonly resolved = signal<ResolvedBook | null>(null);
  readonly errorMsg = signal('');

  readonly supported = inject(BookSourceRegistry).supportedSources().join(' / ');

  private readonly registry = inject(BookSourceRegistry);
  private readonly toast = inject(ToastService);
  private readonly books = inject(BookService);
  readonly modalData = inject(NZ_MODAL_DATA, { optional: true });

  ngOnInit(): void {
    if (this.modalData && typeof this.modalData === 'object') {
      const prefill = (this.modalData as Record<string, unknown>)['url'];
      if (typeof prefill === 'string') {
        this.url = prefill;
        this.parse();
      }
    }
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
      const r = await this.registry.fetchCatalog(this.url);
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
      const book: Book = {
        id,
        title: r.title || this.url,
        author: r.author || '未知',
        coverColor: '#177ddc',
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
