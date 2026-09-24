import {
  Component,
  inject,
  OnInit,
  AfterViewInit,
  OnDestroy,
  signal,
  computed,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { BookService } from '../../core/services/book.service';
import { ReaderService } from '../../core/services/reader.service';
import { SettingsService } from '../../core/services/settings.service';
import {
  PAGE_WIDTHS,
  MIN_FONT_SIZE,
  MAX_FONT_SIZE,
} from '../../core/models/settings.model';
import { Chapter } from '../../core/models/chapter.model';
import { Book } from '../../core/models/book.model';

interface ReaderViewSettings {
  theme: number;
  fontSize: number;
  fontFamily: number;
  pageWidth: number;
}

@Component({
  selector: 'app-reader',
  standalone: true,
  imports: [CommonModule, NzIconModule],
  template: `
    <div
      class="reader-page theme-{{ view().theme }} w{{ view().pageWidth }}"
      [style.font-size.px]="view().fontSize"
    >
      @if (book(); as b) {
        <header class="read-header">
          <div class="wrap-center">
            <a class="back-link" (click)="back()">
              <span nz-icon nzType="arrow-left"></span> 返回书架
            </a>
            <span class="book-title">{{ b.title }}</span>
          </div>
        </header>

        <div class="read-main-wrap ff-{{ view().fontFamily }}">
          <div class="text-wrap">
            <div class="main-text-wrap">
              <div class="text-head">
                <h3>{{ currentChapter()?.title }}</h3>
                <div class="text-info">
                  <i><span nz-icon nzType="book"></span>{{ b.title }}</i>
                  <i><span nz-icon nzType="file-text"></span>{{ b.author }}</i>
                  <i>{{ wordCount() }}字</i>
                  <i>第 {{ chapterIndex() + 1 }} / {{ chapters().length }} 章</i>
                </div>
              </div>
              <pre class="read-content">{{ currentChapter()?.content }}</pre>
            </div>
          </div>

          <div class="chapter-control">
            <a [class.disabled]="chapterIndex() === 0" (click)="prev()">上一章</a>
            <span class="divider"></span>
            <a
              [class.disabled]="chapterIndex() >= chapters().length - 1"
              (click)="next()"
              >下一章</a
            >
          </div>
        </div>

        <div class="left-bar-list">
          <dl>
            <dd [class.act]="catalogOpen()" (click)="toggleCatalog()">
              <a
                ><i><span nz-icon nzType="menu"></span><span class="lbl">目录</span></i></a
              >
            </dd>
            <dd [class.act]="settingsOpen()" (click)="toggleSettings()">
              <a
                ><i><span nz-icon nzType="setting"></span><span class="lbl">设置</span></i></a
              >
            </dd>
            <dd (click)="back()">
              <a
                ><i><span nz-icon nzType="book"></span><span class="lbl">书架</span></i></a
              >
            </dd>
          </dl>

          @if (catalogOpen()) {
            <div class="panel-wrap catalog">
              <a class="close-panel" (click)="catalogOpen.set(false)">
                <span nz-icon nzType="close"></span>
              </a>
              <div class="panel-box">
                <div class="catalog-tab"><span>目录</span></div>
                <div class="catalog-list">
                  @for (ch of chapters(); track ch.index; let i = $index) {
                    <a
                      class="catalog-item"
                      [class.on]="i === chapterIndex()"
                      (click)="goTo(i)"
                      >{{ ch.title }}</a
                    >
                  }
                </div>
              </div>
            </div>
          }

          @if (settingsOpen()) {
            <div class="panel-wrap setting">
              <a class="close-panel" (click)="cancelSettings()">
                <span nz-icon nzType="close"></span>
              </a>
              <div class="panel-box">
                <h4>设置</h4>
                <ul>
                  <li class="theme-list">
                    <i>阅读主题</i>
                    @for (t of themes; track t.id) {
                      <span
                        class="swatch theme-{{ t.id }}"
                        [class.act]="draft().theme === t.id"
                        [title]="t.name"
                        (click)="setTheme(t.id)"
                      >
                        @if (draft().theme === t.id) {
                          <span nz-icon nzType="check"></span>
                        }
                      </span>
                    }
                  </li>
                  <li class="font-family">
                    <i>正文字体</i>
                    @for (f of fontFamilies; track f.id) {
                      <span
                        class="ff-btn ff-{{ f.id }}"
                        [class.act]="draft().fontFamily === f.id"
                        (click)="setFontFamily(f.id)"
                        >{{ f.name }}</span
                      >
                    }
                  </li>
                  <li class="font-size">
                    <i>字体大小</i>
                    <cite>
                      <span class="step" (click)="stepFontSize(-1)">
                        <span nz-icon nzType="minus"></span>
                      </span>
                      <b></b>
                      <span class="value">{{ draft().fontSize }}</span>
                      <b></b>
                      <span class="step" (click)="stepFontSize(1)">
                        <span nz-icon nzType="plus"></span>
                      </span>
                    </cite>
                  </li>
                  <li class="page-width">
                    <i>页面宽度</i>
                    <cite>
                      <span class="step" (click)="stepPageWidth(-1)">
                        <span nz-icon nzType="minus"></span>
                      </span>
                      <b></b>
                      <span class="value">{{ draft().pageWidth }}</span>
                      <b></b>
                      <span class="step" (click)="stepPageWidth(1)">
                        <span nz-icon nzType="plus"></span>
                      </span>
                    </cite>
                  </li>
                </ul>
                <div class="btn-wrap">
                  <a class="red-btn" (click)="saveSettings()">保存</a>
                  <a class="grey-btn" (click)="cancelSettings()">取消</a>
                </div>
              </div>
            </div>
          }
        </div>

        @if (showGoTop()) {
          <div class="right-bar-list">
            <dl>
              <dd class="go-top" title="返回顶部" (click)="scrollToTop()">
                <a><i><span nz-icon nzType="arrow-up"></span></i></a>
              </dd>
            </dl>
          </div>
        }
      } @else {
        <p class="reader-loading">书籍加载中...</p>
      }
    </div>
  `,
})
export class ReaderComponent implements OnInit, AfterViewInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly books = inject(BookService);
  protected readonly reader = inject(ReaderService);
  protected readonly settings = inject(SettingsService);

  protected readonly catalogOpen = signal(false);
  protected readonly settingsOpen = signal(false);
  protected readonly showGoTop = signal(false);
  protected readonly chapterIndex = signal(0);
  protected readonly chapters = signal<Chapter[]>([]);

  /** 设置面板草稿：打开面板期间页面实时预览草稿值，保存才落盘 */
  protected readonly draft = signal<ReaderViewSettings>({
    theme: 0,
    fontSize: 18,
    fontFamily: 1,
    pageWidth: 800,
  });

  protected readonly themes = [
    { id: 0, name: '默认' },
    { id: 1, name: '牛皮纸' },
    { id: 2, name: '淡绿色' },
    { id: 3, name: '淡蓝色' },
    { id: 4, name: '淡粉色' },
    { id: 5, name: '灰色' },
    { id: 6, name: '黑色' },
  ];
  protected readonly fontFamilies = [
    { id: 1, name: '雅黑' },
    { id: 2, name: '宋体' },
    { id: 3, name: '楷书' },
  ];

  readonly book = computed<Book | undefined>(() =>
    this.books.getById(this.reader.currentBookId() ?? '')
  );

  readonly currentChapter = computed<Chapter | undefined>(
    () => this.chapters()[this.chapterIndex()]
  );

  /** 当前生效的视图设置：面板打开时用草稿（预览），否则用已保存值 */
  readonly view = computed<ReaderViewSettings>(() => {
    if (this.settingsOpen()) return this.draft();
    return this.pickSaved();
  });

  readonly wordCount = computed(() =>
    (this.currentChapter()?.content ?? '').replace(/\s+/g, '').length
  );

  private scrollEl: Element | null = null;
  private readonly onScroll = () => {
    this.showGoTop.set((this.scrollEl?.scrollTop ?? 0) > 300);
  };

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
  }

  ngAfterViewInit(): void {
    // 阅读页全屏时滚动容器是 nz-content（app 壳层），不是 window
    this.scrollEl = document.querySelector('nz-content.no-padding');
    this.scrollEl?.addEventListener('scroll', this.onScroll, { passive: true });
  }

  ngOnDestroy(): void {
    this.scrollEl?.removeEventListener('scroll', this.onScroll);
  }

  back(): void {
    this.router.navigate(['/bookshelf']);
  }
  next(): void {
    if (this.chapterIndex() >= this.chapters().length - 1) return;
    this.chapterIndex.update((i) => i + 1);
    this.reader.nextChapter();
    this.scrollToTop();
  }
  prev(): void {
    if (this.chapterIndex() === 0) return;
    this.chapterIndex.update((i) => i - 1);
    this.reader.prevChapter();
    this.scrollToTop();
  }
  goTo(i: number): void {
    this.chapterIndex.set(i);
    this.reader.goToChapter(i);
    this.catalogOpen.set(false);
    this.scrollToTop();
  }

  toggleCatalog(): void {
    this.catalogOpen.update((v) => !v);
    if (this.catalogOpen()) this.settingsOpen.set(false);
  }

  toggleSettings(): void {
    if (this.settingsOpen()) {
      this.cancelSettings();
      return;
    }
    this.draft.set(this.pickSaved());
    this.catalogOpen.set(false);
    this.settingsOpen.set(true);
  }

  setTheme(theme: number): void {
    this.draft.update((d) => ({ ...d, theme }));
  }
  setFontFamily(fontFamily: number): void {
    this.draft.update((d) => ({ ...d, fontFamily }));
  }
  stepFontSize(delta: number): void {
    this.draft.update((d) => ({
      ...d,
      fontSize: Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, d.fontSize + delta)),
    }));
  }
  stepPageWidth(delta: number): void {
    this.draft.update((d) => {
      const i = PAGE_WIDTHS.indexOf(d.pageWidth);
      const next = Math.min(PAGE_WIDTHS.length - 1, Math.max(0, i + delta));
      return { ...d, pageWidth: PAGE_WIDTHS[next] };
    });
  }

  saveSettings(): void {
    const d = this.draft();
    this.settings.update('theme', d.theme);
    this.settings.update('fontSize', d.fontSize);
    this.settings.update('fontFamily', d.fontFamily);
    this.settings.update('pageWidth', d.pageWidth);
    this.settingsOpen.set(false);
  }

  cancelSettings(): void {
    this.settingsOpen.set(false);
  }

  /** 切换章节后把滚动条跳回顶部（用户阅读习惯） */
  scrollToTop(): void {
    // 用 queueMicrotask 等 Angular 渲染完新章节内容
    queueMicrotask(() => {
      const el = this.scrollEl ?? document.querySelector('nz-content.no-padding');
      el?.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }

  private pickSaved(): ReaderViewSettings {
    const s = this.settings.settings();
    return {
      theme: s.theme,
      fontSize: s.fontSize,
      fontFamily: s.fontFamily,
      pageWidth: s.pageWidth,
    };
  }
}
