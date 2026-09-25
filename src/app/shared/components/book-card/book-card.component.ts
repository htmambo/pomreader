import { Component, Input, inject, output, ViewChild, TemplateRef, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { NzDropdownMenuComponent } from 'ng-zorro-antd/dropdown';
import { NzContextMenuService } from 'ng-zorro-antd/dropdown';
import { NzMenuModule } from 'ng-zorro-antd/menu';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { Book } from '../../../core/models/book.model';
import { ToastService } from '../../../core/services/toast.service';
import { CoverService } from '../../../core/cover/cover.service';

/**
 * BookCard — 书架单本书
 * - 左键点击：进入阅读器
 * - 右键菜单：NzContextMenuService.create()（ng-zorro 标准右键方案，避开 nz-dropdown 指令绑定）
 */
@Component({
  selector: 'app-book-card',
  standalone: true,
  imports: [CommonModule, RouterLink, NzDropdownMenuComponent, NzMenuModule, NzIconModule],
  template: `
    <a
      class="book-card"
      [routerLink]="['/reader', book.id, 0]"
      [style.--cover-color]="book.coverColor"
      [attr.aria-label]="book.title + ' — ' + book.author"
      (contextmenu)="onContextMenu($event)"
    >
      @if (book.coverImageUrl) {
        <!-- 模式 1: 用户提供的封面图片 -->
        <img class="cover cover-img" [src]="book.coverImageUrl" [alt]="book.title" loading="lazy" />
      } @else {
        <!-- 模式 2: 默认 SVG 装饰封面 -->
        <svg class="cover" viewBox="0 0 100 140" preserveAspectRatio="none">
          <rect width="100" height="140" fill="var(--cover-color)" />
          <rect width="100" height="8" fill="rgba(255,255,255,.18)" />
          <g stroke="rgba(255,255,255,.08)" stroke-width="0.6">
            <line x1="-10" y1="135" x2="20" y2="105" />
            <line x1="10" y1="135" x2="40" y2="105" />
            <line x1="30" y1="135" x2="60" y2="105" />
            <line x1="50" y1="135" x2="80" y2="105" />
            <line x1="70" y1="135" x2="100" y2="105" />
            <line x1="90" y1="135" x2="120" y2="105" />
          </g>
          <text x="50" y="60" text-anchor="middle" fill="rgba(255,255,255,.92)" font-size="10" font-weight="600">
            {{ book.title }}
          </text>
          <text x="50" y="78" text-anchor="middle" fill="rgba(255,255,255,.72)" font-size="7">
            {{ book.author }}
          </text>
          <text x="50" y="125" text-anchor="middle" fill="rgba(255,255,255,.55)" font-size="6">
            @if (book.progress && book.progress.chapterIndex != null) {
              {{ book.progress.chapterIndex + 1 }}/{{ book.chapterCount }}
            } @else {
              {{ book.chapterCount }} 章
            }
          </text>
        </svg>
      }
      <div class="meta">
        <div class="title">{{ book.title }}</div>
        <div class="author">{{ book.author }}</div>
      </div>
    </a>

    <!-- 右键菜单模板：通过 NzContextMenuService.create(event, menu) 渲染 -->
    <nz-dropdown-menu #cardMenu="nzDropdownMenu">
      <ul nz-menu>
        <li nz-menu-item (click)="refreshCover(); closeMenu()">
          <span nz-icon nzType="reload"></span> 刷新封面
        </li>
        <li nz-menu-item (click)="generateCover.emit(book); closeMenu()">
          <span nz-icon nzType="appstore"></span> 生成封面
        </li>
        <li nz-menu-item (click)="editInfo.emit(book); closeMenu()">
          <span nz-icon nzType="edit"></span> 编辑书籍信息
        </li>
        <li nz-menu-item [routerLink]="['/source-search']" [queryParams]="{ keyword: book.title }" (click)="closeMenu()">
          <span nz-icon nzType="search"></span> 用此书名重新搜索
        </li>
        @if (book.coverImageUrl) {
          <li nz-menu-item (click)="copyLink(book.coverImageUrl!); closeMenu()">
            <span nz-icon nzType="copy"></span> 复制封面链接
          </li>
        }
        <li nz-menu-divider></li>
        <li nz-menu-item nzDanger (click)="deleteBook(); closeMenu()">
          <span nz-icon nzType="delete"></span> 从书架移除
        </li>
      </ul>
    </nz-dropdown-menu>
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
      .cover-img {
        object-fit: cover;
        background: var(--cover-color);
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
      :host { display: block; }
    `,
  ],
})
export class BookCardComponent implements OnDestroy {
  @Input({ required: true }) book!: Book;

  @ViewChild('cardMenu', { static: true }) cardMenu!: NzDropdownMenuComponent;

  private toast = inject(ToastService);
  private cover = inject(CoverService);
  private contextMenu = inject(NzContextMenuService);

  /** 通知父组件删除该书（BookshelfComponent 接收） */
  readonly remove = output<Book>();
  /** 通知父组件打开「生成封面」对话框 */
  readonly generateCover = output<Book>();
  /** 通知父组件打开「编辑书籍信息」对话框 */
  readonly editInfo = output<Book>();

  onContextMenu(event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.contextMenu.create(event, this.cardMenu);
  }

  closeMenu(): void {
    this.contextMenu.close();
  }

  ngOnDestroy(): void {
    this.contextMenu.close();
  }

  /** 刷新封面：调用 CoverService 重新走 IPC（命中缓存直返，未命中重下） */
  async refreshCover(): Promise<void> {
    if (!this.book.coverImageUrl) {
      this.toast.warn('该书没有封面 URL');
      return;
    }
    try {
      const localRef = await this.cover.resolve(this.book.coverImageUrl);
      this.book.coverImageUrl = localRef;
      this.toast.success(`已刷新封面：${this.book.title}`);
    } catch (e) {
      this.toast.error(`刷新失败: ${(e as Error).message}`);
    }
  }

  copyLink(url: string): void {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(url).then(
        () => this.toast.success('链接已复制'),
        () => this.toast.error('复制失败'),
      );
    } else {
      this.toast.warn('当前环境不支持剪贴板 API');
    }
  }

  deleteBook(): void {
    // 二次确认由 BookshelfComponent 处理（这里只发事件）
    this.remove.emit(this.book);
  }
}
