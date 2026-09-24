import { Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { NZ_MODAL_DATA } from 'ng-zorro-antd/modal';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzListModule } from 'ng-zorro-antd/list';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { resolveSource, ResolvedSource } from '../../core/logic/online-source-resolver';
import { ToastService } from '../../core/services/toast.service';
import { BookService } from '../../core/services/book.service';
import { Book } from '../../core/models/book.model';
import { Chapter } from '../../core/models/chapter.model';

/**
 * 导入在线书页（modal 内容组件）
 * 由 NzModalService.create({ nzContent: ImportOnlineComponent }) 调用
 * 自身只渲染内容；确认按钮 / 取消按钮由 ModalService 模板提供
 */
@Component({
  selector: 'app-import-online',
  standalone: true,
  imports: [CommonModule, FormsModule, NzInputModule, NzButtonModule, NzListModule, NzIconModule],
  template: `
    <div class="import-online">
      <p>输入书源 URL（mock 实现，返回 5-10 章假结果）：</p>
      <div class="url-row">
        <input
          nz-input
          placeholder="https://example.com/book/123"
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
      } @else if (resolved()?.error) {
        <p class="hint error">
          <span nz-icon nzType="warning"></span>
          {{ errorMessage(resolved()!.error!) }}
        </p>
      } @else if (resolved()) {
        <h4>{{ resolved()!.title }} <small>({{ resolved()!.author }})</small></h4>
        <p class="hint">共 {{ resolved()!.chapters?.length || 0 }} 章，点击下方"确认导入"加入书架</p>
        <nz-list [nzDataSource]="resolved()!.chapters || []" [nzRenderItem]="chapterTpl" nzBordered>
          <ng-template #chapterTpl let-item let-index>
            <nz-list-item>{{ index + 1 }}. {{ item.title }}</nz-list-item>
          </ng-template>
        </nz-list>
      }

      @if (importing()) {
        <p class="hint">正在加入书架...</p>
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
  readonly resolved = signal<ResolvedSource | null>(null);

  private readonly toast = inject(ToastService);
  private readonly books = inject(BookService);
  // nzData 透传（保留扩展位）
  readonly modalData = inject(NZ_MODAL_DATA, { optional: true });

  ngOnInit(): void {
    if (this.modalData && typeof this.modalData === 'object') {
      const prefill = (this.modalData as Record<string, unknown>)['url'];
      if (typeof prefill === 'string') {
        this.url = prefill;
        // 从万能搜索带入的 URL 直接解析，点「确认导入」即可导入
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
    try {
      const r = await resolveSource(this.url);
      this.resolved.set(r);
      if (r.error) {
        this.toast.error(this.errorMessage(r.error));
      }
    } catch (e) {
      this.toast.error(`解析失败：${(e as Error).message}`);
    } finally {
      this.loading.set(false);
    }
  }

  async confirm(): Promise<boolean> {
    const r = this.resolved();
    if (!r || r.error || !r.chapters || r.chapters.length === 0) {
      this.toast.warn('请先解析一个有效的 URL');
      return false; // 阻止关闭
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
      const chapters: Chapter[] = r.chapters.map((c, i) => ({
        bookId: id,
        index: i,
        title: c.title,
        content: `（在线导入占位章节 — ${c.title}）`,
      }));
      this.books.addBook(book, chapters);
      this.toast.success(`已导入：${book.title}`);
      this.importing.set(false);
      return true; // 允许关闭
    } catch (e) {
      this.toast.error(`导入失败：${(e as Error).message}`);
      this.importing.set(false);
      return false;
    }
  }

  errorMessage(code: string): string {
    switch (code) {
      case 'source-unavailable':
        return '该书源暂时不可用，请稍后重试。';
      case 'invalid-url':
        return 'URL 格式无效。';
      default:
        return `解析失败：${code}`;
    }
  }
}