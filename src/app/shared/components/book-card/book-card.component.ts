import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { Book } from '../../../core/models/book.model';

/**
 * BookCard — 书架单本书（SVG 封面 + 标题 + 作者 + 进度）
 * 与原 vendor 一致：CSS variable 上色
 */
@Component({
  selector: 'app-book-card',
  standalone: true,
  imports: [CommonModule, RouterLink],
  template: `
    <a
      class="book-card"
      [routerLink]="['/reader', book.id, 0]"
      [style.--cover-color]="book.coverColor"
      [attr.aria-label]="book.title + ' — ' + book.author"
    >
      <svg class="cover" viewBox="0 0 100 140" preserveAspectRatio="none">
        <rect width="100" height="140" fill="var(--cover-color)" />
        <text
          x="50"
          y="60"
          text-anchor="middle"
          fill="rgba(255,255,255,.92)"
          font-size="10"
          font-weight="600"
        >
          {{ book.title }}
        </text>
        <text x="50" y="78" text-anchor="middle" fill="rgba(255,255,255,.72)" font-size="7">
          {{ book.author }}
        </text>
        <text x="50" y="125" text-anchor="middle" fill="rgba(255,255,255,.55)" font-size="6">
          {{ book.chapterCount }} 章 · {{ formatChars(book.totalChars) }}
        </text>
      </svg>
      <div class="meta">
        <div class="title">{{ book.title }}</div>
        <div class="author">{{ book.author }}</div>
      </div>
    </a>
  `,
  styles: [
    `
      .book-card {
        display: block;
        text-decoration: none;
        color: inherit;
        cursor: pointer;
        transition: transform 0.2s;
      }
      .book-card:hover {
        transform: translateY(-2px);
      }
      .cover {
        width: 100%;
        aspect-ratio: 5 / 7;
        border-radius: 4px;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
        display: block;
      }
      .meta {
        margin-top: 8px;
        text-align: center;
      }
      .title {
        font-size: 14px;
        font-weight: 600;
        color: var(--pom-text-muted);
      }
      .author {
        font-size: 12px;
        color: var(--pom-text);
        margin-top: 2px;
      }
    `,
  ],
})
export class BookCardComponent {
  @Input({ required: true }) book!: Book;

  formatChars(n: number): string {
    if (n >= 10000) return `${(n / 10000).toFixed(1)}万字`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}千字`;
    return `${n}字`;
  }
}