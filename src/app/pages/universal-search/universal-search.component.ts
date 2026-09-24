import { Component, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzListModule } from 'ng-zorro-antd/list';

interface SearchResult {
  title: string;
  author: string;
  source: string;
}

@Component({
  selector: 'app-universal-search',
  standalone: true,
  imports: [CommonModule, FormsModule, NzInputModule, NzButtonModule, NzListModule],
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
      <button nz-button nzType="primary" (click)="search()" [disabled]="!keyword.trim()">
        搜索
      </button>
    </div>

    @if (searching()) {
      <p class="hint">搜索中...</p>
    } @else if (results().length > 0) {
      <nz-list [nzDataSource]="results()" nzBordered>
        <ng-template let-item>
          <nz-list-item>
            <span class="title">{{ item.title }}</span>
            <span class="author">{{ item.author }}</span>
            <span class="source">{{ item.source }}</span>
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
      .title {
        font-weight: 600;
        margin-right: 16px;
      }
      .author {
        color: var(--pom-text);
        margin-right: 16px;
      }
      .source {
        color: var(--pom-text-muted);
        font-size: 12px;
      }
    `,
  ],
})
export class UniversalSearchComponent {
  keyword = '';
  readonly searching = signal(false);
  readonly results = signal<SearchResult[]>([]);
  readonly searched = signal(false);

  search(): void {
    if (!this.keyword.trim()) return;
    this.searching.set(true);
    this.searched.set(true);
    // mock 搜索：500ms 后返回假结果
    setTimeout(() => {
      this.results.set([
        {
          title: `${this.keyword}（在线版）`,
          author: '未知',
          source: 'example.com',
        },
        {
          title: `${this.keyword} 全文`,
          author: '匿名',
          source: 'mock-source',
        },
      ]);
      this.searching.set(false);
    }, 500);
  }
}