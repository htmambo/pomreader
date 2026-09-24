import { Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { NzModalModule } from 'ng-zorro-antd/modal';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzListModule } from 'ng-zorro-antd/list';
import { resolveSource, ResolvedSource } from '../../core/logic/online-source-resolver';
import { ToastService } from '../../core/services/toast.service';
import { BookService } from '../../core/services/book.service';
import { Book } from '../../core/models/book.model';
import { Chapter } from '../../core/models/chapter.model';

@Component({
  selector: 'app-import-online',
  standalone: true,
  imports: [CommonModule, FormsModule, NzModalModule, NzInputModule, NzButtonModule, NzListModule],
  template: `
    <nz-modal
      [nzVisible]="true"
      nzTitle="导入在线书页"
      (nzOnCancel)="close.emit()"
      (nzOnOk)="confirm()"
      [nzOkText]="importing() ? '导入中...' : '确认导入'"
      [nzCancelText]="'取消'"
      [nzOkDisabled]="!resolved() || importing()"
      [nzWidth]="640"
    >
      <ng-container *nzModalContent>
        <p>输入书源 URL（mock 实现，返回 5-10 章假结果）：</p>
        <input
          nz-input
          placeholder="https://example.com/book/123"
          [(ngModel)]="url"
          [disabled]="importing()"
        />

        @if (loading()) {
          <p class="hint">解析中...</p>
        } @else if (resolved()?.error) {
          <p class="hint error">{{ errorMessage(resolved()!.error!) }}</p>
        } @else if (resolved()) {
          <h4>{{ resolved()!.title }} <small>({{ resolved()!.author }})</small></h4>
          <nz-list [nzDataSource]="resolved()!.chapters || []" nzBordered>
            <ng-template let-item>
              <nz-list-item>{{ item.title }}</nz-list-item>
            </ng-template>
          </nz-list>
        }

        @if (importing()) {
          <p class="hint">正在加入书架...</p>
        }
      </ng-container>
    </nz-modal>
  `,
  styles: [
    `
      .hint {
        margin: 16px 0;
        color: var(--pom-text);
      }
      .hint.error {
        color: #cf1322;
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
  // close is emitted by host (modal service) — simplified for this skeleton
  readonly close = { emit: () => undefined };

  ngOnInit(): void {
    // placeholder for ngOnInit (we removed @Output to keep skeleton simple)
  }

  async confirm(): Promise<void> {
    if (!this.url.trim()) return;
    this.loading.set(true);
    this.resolved.set(null);
    try {
      const r = await resolveSource(this.url);
      this.resolved.set(r);
      if (r.error) {
        this.toast.error(this.errorMessage(r.error));
        this.loading.set(false);
        return;
      }
      const id = `online-${Date.now()}`;
      const book: Book = {
        id,
        title: r.title || this.url,
        author: r.author || '未知',
        coverColor: '#177ddc',
        chapterCount: r.chapters?.length ?? 0,
        totalChars: (r.chapters?.length ?? 0) * 2000,
        importedAt: new Date().toISOString(),
        source: 'online',
        sourceUrl: this.url,
      };
      const chapters: Chapter[] = (r.chapters ?? []).map((c, i) => ({
        bookId: id,
        index: i,
        title: c.title,
        content: `（在线导入占位章节 — ${c.title}）`,
      }));
      this.books.addBook(book, chapters);
      this.toast.success(`已导入：${book.title}`);
      this.importing.set(false);
      this.close.emit();
    } catch (e) {
      this.toast.error(`导入失败：${(e as Error).message}`);
      this.loading.set(false);
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