import { Component, inject, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzListModule } from 'ng-zorro-antd/list';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { NzModalService } from 'ng-zorro-antd/modal';
import { NzMessageService } from 'ng-zorro-antd/message';
import { BookService } from '../../core/services/book.service';
import { Book } from '../../core/models/book.model';
import { ImportOnlineComponent } from '../../modals/import-online/import-online.component';
import { ResolvedSource } from '../../core/logic/online-source-resolver';

interface SearchResult {
  title: string;
  author: string;
  source: string;
  book?: Book;            // 来自本地库
  external?: ResolvedSource; // 来自 mock 外部源
}

@Component({
  selector: 'app-universal-search',
  standalone: true,
  imports: [CommonModule, FormsModule, NzInputModule, NzButtonModule, NzListModule, NzIconModule],
  template: `
    <h2>万能搜索</h2>
    <div class="search-bar">
      <input
        nz-input
        placeholder="输入书名 / 作者 / 关键字"
        [(ngModel)]="keyword"
        (keyup.enter)="search()"
        style="width: 320px; margin-right: 8px;"
      />
      <button nz-button nzType="primary" (click)="search()" [disabled]="!keyword.trim() || searching()">
        {{ searching() ? '搜索中...' : '搜索' }}
      </button>
    </div>

    @if (searching()) {
      <p class="hint">搜索中...</p>
    } @else if (results().length > 0) {
      <p class="hint">共 {{ results().length }} 条结果</p>
      <nz-list [nzDataSource]="results()" [nzRenderItem]="itemTpl" nzBordered>
        <ng-template #itemTpl let-item>
          <nz-list-item (click)="openResult(item)" style="cursor: pointer;">
            <div class="result-row">
              <div class="result-info">
                <span class="title">{{ item.title }}</span>
                <span class="author">{{ item.author }}</span>
              </div>
              <span class="source-tag" [class.local]="item.book" [class.external]="item.external">
                <span nz-icon [nzType]="item.book ? 'book' : 'link'"></span>
                {{ item.book ? '本地库' : '外部源' }}
              </span>
            </div>
          </nz-list-item>
        </ng-template>
      </nz-list>
    } @else if (searched()) {
      <p class="hint">未找到匹配结果</p>
    }
  `,
  styles: [
    `
      .search-bar {
        margin: 16px 0;
        display: flex;
        align-items: center;
      }
      .hint {
        color: var(--pom-text);
        margin: 16px 0;
      }
      .result-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        width: 100%;
      }
      .result-info {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .title {
        font-weight: 600;
        color: var(--pom-text-muted);
      }
      .author {
        color: var(--pom-text);
        font-size: 12px;
      }
      .source-tag {
        font-size: 12px;
        padding: 2px 8px;
        border-radius: 10px;
        display: flex;
        align-items: center;
        gap: 4px;
      }
      .source-tag.local {
        background: var(--pom-border);
        color: var(--pom-text-muted);
      }
      .source-tag.external {
        background: #177ddc;
        color: white;
      }
    `,
  ],
})
export class UniversalSearchComponent {
  keyword = '';
  readonly searching = signal(false);
  readonly results = signal<SearchResult[]>([]);
  readonly searched = signal(false);

  private readonly books = inject(BookService);
  private readonly router = inject(Router);
  private readonly modal = inject(NzModalService);
  private readonly msg = inject(NzMessageService);

  readonly localCount = computed(() => this.books.count());

  search(): void {
    if (!this.keyword.trim()) return;
    this.searching.set(true);
    this.searched.set(true);
    setTimeout(() => {
      const results: SearchResult[] = [];
      const lower = this.keyword.toLowerCase();
      // 1. 本地库匹配（title / author）
      for (const b of this.books.books()) {
        if (
          b.title.toLowerCase().includes(lower) ||
          b.author.toLowerCase().includes(lower)
        ) {
          results.push({
            title: b.title,
            author: b.author,
            source: '本地库',
            book: b,
          });
        }
      }
      // 2. mock 外部源（永远展示 1-3 条，模拟「万能」搜索）
      const extCount = 1 + Math.floor(Math.random() * 3);
      for (let i = 0; i < extCount; i++) {
        results.push({
          title: `${this.keyword}（外部源 ${i + 1}）`,
          author: `mock-source-${i + 1}.example.com`,
          source: '外部源（mock）',
          external: {
            title: `${this.keyword}（外部源 ${i + 1}）`,
            author: `mock-source-${i + 1}.example.com`,
            chapters: [
              { title: '第一章 风起云涌', url: '#' },
              { title: '第二章 山雨欲来', url: '#' },
            ],
          },
        });
      }
      this.results.set(results);
      this.searching.set(false);
    }, 300);
  }

  openResult(r: SearchResult): void {
    if (r.book) {
      // 本地库 → 直接打开阅读器
      this.router.navigate(['/reader', r.book.id, 0]);
    } else if (r.external) {
      // 外部源 → 弹出导入 modal，预填 URL
      this.modal.create({
        nzTitle: '导入在线书页',
        nzContent: ImportOnlineComponent,
        nzData: { url: `https://${r.external.author}/book/${encodeURIComponent(this.keyword)}` },
        nzOkText: '确认导入',
        nzCancelText: '取消',
        nzWidth: 640,
        nzOnOk: (instance: ImportOnlineComponent) => instance.confirm(),
      });
    }
  }
}