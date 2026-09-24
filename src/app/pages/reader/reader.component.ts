import { Component, inject, OnInit, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzDrawerModule } from 'ng-zorro-antd/drawer';
import { NzListModule } from 'ng-zorro-antd/list';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { NzModalModule } from 'ng-zorro-antd/modal';
import { NzSliderModule } from 'ng-zorro-antd/slider';
import { NzInputNumberModule } from 'ng-zorro-antd/input-number';
import { NzCheckboxModule } from 'ng-zorro-antd/checkbox';
import { BookService } from '../../core/services/book.service';
import { ReaderService } from '../../core/services/reader.service';
import { SettingsService } from '../../core/services/settings.service';
import { ThemeService } from '../../core/services/theme.service';
import { resolveSchemeColors } from '../../core/logic/theme-resolver';
import { Chapter } from '../../core/models/chapter.model';
import { Book } from '../../core/models/book.model';

@Component({
  selector: 'app-reader',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    NzButtonModule,
    NzDrawerModule,
    NzListModule,
    NzIconModule,
    NzModalModule,
    NzSliderModule,
    NzInputNumberModule,
    NzCheckboxModule,
  ],
  template: `
    @if (book(); as b) {
      <div class="reader" [style.font-size.px]="fontSize()">
        <header class="toolbar">
          <button nz-button nzType="text" (click)="back()">
            <span nz-icon nzType="arrow-left"></span> 返回
          </button>
          <span class="title">{{ b.title }}</span>
          <button nz-button nzType="text" (click)="drawerOpen.set(true)">
            <span nz-icon nzType="menu"></span> 目录
          </button>
          <button nz-button nzType="text" (click)="settingsOpen.set(true)">
            <span nz-icon nzType="setting"></span> 设置
          </button>
          <button nz-button nzType="text" (click)="toggleTheme()">
            <span nz-icon [nzType]="theme.mode() === 'dark' ? 'sun' : 'moon'"></span>
          </button>
        </header>

        <article
          class="content read-region"
          [style.background]="bgImage()"
          [style.color]="settings.settings().fontColor"
        >
          <h2 class="chapter-title">{{ currentChapter()?.title }}</h2>
          <pre class="chapter-body">{{ currentChapter()?.content }}</pre>

          <nav class="chapter-nav">
            <button nz-button (click)="prev()" [disabled]="chapterIndex() === 0">
              上一章
            </button>
            <span class="position">
              第 {{ chapterIndex() + 1 }} / {{ chapters().length }} 章
            </span>
            <button
              nz-button
              (click)="next()"
              [disabled]="chapterIndex() >= chapters().length - 1"
            >
              下一章
            </button>
          </nav>
        </article>

        <nz-drawer
          [nzVisible]="drawerOpen()"
          nzPlacement="left"
          nzTitle="目录"
          (nzOnClose)="drawerOpen.set(false)"
        >
          <ng-container *nzDrawerContent>
            <nz-list [nzDataSource]="chapters()" nzBordered>
              <ng-template let-item let-index>
                <nz-list-item
                  [class.current-chapter-menu-item]="index === chapterIndex()"
                  (click)="goTo(index)"
                  style="cursor: pointer;"
                >
                  {{ item.title }}
                </nz-list-item>
              </ng-template>
            </nz-list>
          </ng-container>
        </nz-drawer>

        <nz-modal
          [nzVisible]="settingsOpen()"
          nzTitle="阅读效果配置"
          (nzOnCancel)="closeSettings()"
          (nzOnOk)="settingsOpen.set(false)"
          [nzOkText]="'保存'"
          [nzCancelText]="'取消'"
        >
          <ng-container *nzModalContent>
            <div class="setting-row">
              <label>字号：</label>
              <nz-input-number
                [(ngModel)]="fontSizeLocal"
                [nzMin]="14"
                [nzMax]="28"
                [nzStep]="1"
                (ngModelChange)="onFontSizeChange($event)"
              ></nz-input-number>
            </div>
            <div class="setting-row">
              <label>字体颜色：</label>
              <input
                type="color"
                [(ngModel)]="fontColorLocal"
                (ngModelChange)="onFontColorChange($event)"
              />
            </div>
            <div class="setting-row">
              <label>界面背景：</label>
              <input
                type="color"
                [(ngModel)]="bgLocal"
                (ngModelChange)="onBgChange($event)"
              />
            </div>
            <div class="setting-row">
              <label>
                <input
                  type="checkbox"
                  [(ngModel)]="defaultThemeLocal"
                  (ngModelChange)="settings.update('defaultTheme', $event)"
                />
                使用默认配置
              </label>
            </div>
          </ng-container>
        </nz-modal>
      </div>
    } @else {
      <p>书籍加载中...</p>
    }
  `,
  styles: [
    `
      .reader {
        padding: 0 16px;
      }
      .toolbar {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 16px;
      }
      .toolbar .title {
        flex: 1;
        text-align: center;
        font-weight: 600;
        color: var(--pom-text-muted);
      }
      .read-region {
        padding: 24px;
        border-radius: 8px;
        min-height: 60vh;
      }
      .chapter-title {
        text-align: center;
        margin-bottom: 24px;
        color: inherit;
      }
      .chapter-body {
        white-space: pre-wrap;
        line-height: 1.8;
        font-family: var(--pom-font-family);
      }
      .chapter-nav {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 16px;
        margin-top: 32px;
      }
      .position {
        color: var(--pom-text);
      }
      .setting-row {
        margin: 16px 0;
        display: flex;
        align-items: center;
        gap: 8px;
      }
    `,
  ],
})
export class ReaderComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly books = inject(BookService);
  protected readonly reader = inject(ReaderService);
  protected readonly settings = inject(SettingsService);
  protected readonly theme = inject(ThemeService);

  protected readonly drawerOpen = signal(false);
  protected readonly settingsOpen = signal(false);
  protected readonly chapterIndex = signal(0);
  protected readonly chapters = signal<Chapter[]>([]);

  protected fontSizeLocal = 16;
  protected fontColorLocal = '#262626';
  protected bgLocal = '#CDC0A4';
  protected defaultThemeLocal = true;

  readonly book = computed<Book | undefined>(() =>
    this.books.getById(this.reader.currentBookId() ?? '')
  );

  readonly currentChapter = computed<Chapter | undefined>(
    () => this.chapters()[this.chapterIndex()]
  );

  readonly fontSize = computed(() => this.fontSizeLocal);
  readonly bgImage = computed(() => {
    const colors = resolveSchemeColors(this.theme.mode(), undefined, this.bgLocal);
    return colors.bg;
  });

  async ngOnInit(): Promise<void> {
    const params = this.route.snapshot.params;
    const bookId = params['bookId'] as string;
    let chapterId = parseInt(params['chapterId'] as string, 10);
    if (isNaN(chapterId) || chapterId < 0) chapterId = 0;

    const book = this.books.getById(bookId);
    if (!book) {
      this.router.navigate(['/bookshelf']);
      return;
    }
    if (chapterId >= book.chapterCount) chapterId = 0;

    this.reader.openBook(bookId, chapterId);
    this.chapterIndex.set(chapterId);

    const chs = await this.books.getChapters(bookId);
    this.chapters.set(chs);

    this.fontSizeLocal = this.settings.readerFontSize();
    this.fontColorLocal = this.settings.settings().fontColor;
    this.bgLocal = this.settings.settings().screenBg;
    this.defaultThemeLocal = this.settings.settings().defaultTheme;
  }

  back(): void {
    this.router.navigate(['/bookshelf']);
  }
  next(): void {
    this.chapterIndex.update((i) => i + 1);
    this.reader.nextChapter();
  }
  prev(): void {
    this.chapterIndex.update((i) => Math.max(0, i - 1));
    this.reader.prevChapter();
  }
  goTo(i: number): void {
    this.chapterIndex.set(i);
    this.reader.goToChapter(i);
    this.drawerOpen.set(false);
  }
  toggleTheme(): void {
    this.theme.toggleMode();
  }
  onFontSizeChange(size: number | string): void {
    const n = typeof size === 'number' ? size : parseInt(String(size), 10);
    if (!isNaN(n)) {
      this.settings.updateReaderFontSize(n);
    }
  }
  onFontColorChange(c: string): void {
    this.settings.update('fontColor', c);
  }
  onBgChange(c: string): void {
    this.settings.update('screenBg', c);
  }

  closeSettings(): void {
    this.settingsOpen.set(false);
  }
}