import {
  Component,
  inject,
  OnInit,
  AfterViewInit,
  OnDestroy,
  HostListener,
  signal,
  computed,
  effect,
  untracked,
  viewChild,
  ElementRef,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { NzModalService } from 'ng-zorro-antd/modal';
import { NzMessageService } from 'ng-zorro-antd/message';
import { BookService } from '../../core/services/book.service';
import { ReaderService } from '../../core/services/reader.service';
import { SettingsService } from '../../core/services/settings.service';
import { JumpChapterDialogComponent } from './jump-chapter-dialog.component';
import { EditBookInfoDialogComponent } from './edit-book-info-dialog.component';
import {
  PAGE_WIDTHS,
  MIN_FONT_SIZE,
  MAX_FONT_SIZE,
  ReadMode,
} from '../../core/models/settings.model';
import { Chapter } from '../../core/models/chapter.model';
import { Book } from '../../core/models/book.model';
import { normalizeParagraphIndent } from '../../core/logic/text-format';

interface ReaderViewSettings {
  theme: number;
  fontSize: number;
  fontFamily: number;
  pageWidth: number;
  readMode: ReadMode;
}

@Component({
  selector: 'app-reader',
  standalone: true,
  imports: [CommonModule, NzIconModule],
  template: `
    <div
      class="reader-page theme-{{ view().theme }} w{{ view().pageWidth }}"
      [class.paged]="paged()"
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
                  @if (paged()) {
                    <i>第 {{ pageIndex() + 1 }} / {{ totalPages() }} 页</i>
                  }
                </div>
              </div>
              @if (chapterLoading()) {
                <p class="chapter-loading">章节加载中...</p>
              } @else if (chapterError()) {
                <p class="chapter-loading">该章节加载失败。<a (click)="retryLoad()">重试</a></p>
              } @else if (paged()) {
                <div class="paged-viewport" #pagedViewport>
                  <pre
                    class="read-content paged-content"
                    #pagedContent
                    [class.ready]="pageReady()"
                    [style.column-width.px]="pageW()"
                    [style.transform]="'translateX(' + (-pageIndex() * pageW() + entryOffset()) + 'px)'"
                    >{{ displayContent() }}</pre
                  >
                </div>
              } @else {
                <pre class="read-content">{{ displayContent() }}</pre>
              }
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
            <dd (click)="openJumpDialog()">
              <a
                ><i><span nz-icon nzType="swap"></span><span class="lbl">进度</span></i></a
              >
            </dd>
            <dd (click)="openEditBookInfoDialog()">
              <a
                ><i><span nz-icon nzType="edit"></span><span class="lbl">编辑</span></i></a
              >
            </dd>
            <dd (click)="refreshContent()">
              <a
                ><i><span nz-icon nzType="reload"></span><span class="lbl">刷新</span></i></a
              >
            </dd>
            <dd (click)="back()">
              <a
                ><i><span nz-icon nzType="book"></span><span class="lbl">书架</span></i></a
              >
            </dd>
            <dd class="danger" (click)="confirmDelete()">
              <a
                ><i><span nz-icon nzType="delete"></span><span class="lbl">删除</span></i></a
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
                      >{{ ch.title }}@if (ch.sourceUrl && !ch.loaded) {
                        <span nz-icon nzType="download" class="not-loaded" title="未下载"></span>
                      }</a
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
                  <li class="read-mode">
                    <i>阅读模式</i>
                    @for (m of readModes; track m.id) {
                      <span
                        class="ff-btn"
                        [class.act]="draft().readMode === m.id"
                        (click)="setReadMode(m.id)"
                        >{{ m.name }}</span
                      >
                    }
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

        @if (showGoTop() && !paged()) {
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
  private readonly modal = inject(NzModalService);
  private readonly msg = inject(NzMessageService);

  protected readonly catalogOpen = signal(false);
  protected readonly settingsOpen = signal(false);
  protected readonly showGoTop = signal(false);
  protected readonly chapterIndex = signal(0);
  protected readonly chapters = signal<Chapter[]>([]);
  /** 在线书按需加载状态 */
  protected readonly chapterLoading = signal(false);
  protected readonly chapterError = signal(false);

  /** 翻页模式：当前页码 / 总页数 / 每页宽度（视口实测 px） */
  protected readonly pageIndex = signal(0);
  protected readonly totalPages = signal(1);
  protected readonly pageW = signal(0);
  /** 测量定位完成前隐藏正文，避免切章/重排闪烁 */
  protected readonly pageReady = signal(false);
  /** 是否翻页模式（设置面板草稿预览实时生效） */
  protected readonly paged = computed(() => this.view().readMode === 'paged');

  protected readonly readModes: { id: ReadMode; name: string }[] = [
    { id: 'scroll', name: '滚动' },
    { id: 'paged', name: '翻页' },
  ];

  private readonly viewportRef = viewChild<ElementRef<HTMLElement>>('pagedViewport');
  private readonly contentRef = viewChild<ElementRef<HTMLElement>>('pagedContent');
  /** 跨章入场偏移（px）：+w 内容从右侧滑入（向后），-w 从左侧滑入（向前）；0 = 仅淡入 */
  protected readonly entryOffset = signal(0);
  /** 首次测量时应用的恢复页码（-1 = 最后一页）；null = 无待恢复 */
  private restoredPage: number | null = null;
  private lastMeasuredChapter = -1;
  private measureRaf = 0;
  private revealRaf = 0;
  private resizeObserver: ResizeObserver | null = null;
  /** 跨章切换的入场方向（下次测量消费后清空） */
  private entryDir: 'next' | 'prev' | null = null;

  /** 设置面板草稿：打开面板期间页面实时预览草稿值，保存才落盘 */
  protected readonly draft = signal<ReaderViewSettings>({
    theme: 0,
    fontSize: 18,
    fontFamily: 1,
    pageWidth: 800,
    readMode: 'paged',
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

  /** 按需加载：当前章未加载时触发抓取；渲染后预加载下一章（spec §5.3） */
  private readonly loadEffect = effect(() => {
    const idx = this.chapterIndex();
    const chs = this.chapters();
    // 依赖版本号使在线章节更新后刷新
    this.books.chaptersVersion();
    // 触发逻辑需写 signal，移出 effect 响应式上下文（Angular 18 NG0600）
    untracked(() => this.ensureChapterLoaded(idx, chs));
  });

  /** 翻页模式测量：内容/视图设置/视口宽度/章节变化后，下一帧重新测量分页 */
  private readonly measureEffect = effect(() => {
    if (!this.paged()) return;
    // 依赖收集：渲染正文、视图设置（字号/字体/宽度/主题）、视口宽度、章节序号
    this.displayContent();
    this.view();
    this.pageW();
    this.chapterIndex();
    untracked(() => {
      // 仅跨章切换时隐藏待定位；同章重排（设置/缩放）保持可见、平滑滑到新页码
      const hide = this.lastMeasuredChapter !== this.chapterIndex();
      this.scheduleMeasure(hide);
    });
  });

  /** 视口宽度监听：窗口缩放使实际宽度偏离档位值时触发重排 */
  private readonly resizeEffect = effect(() => {
    const vp = this.viewportRef()?.nativeElement;
    untracked(() => {
      this.resizeObserver?.disconnect();
      this.resizeObserver = null;
      if (!vp) return;
      this.resizeObserver = new ResizeObserver(() => {
        const w = vp.clientWidth;
        if (w > 0 && w !== this.pageW()) this.pageW.set(w);
      });
      this.resizeObserver.observe(vp);
    });
  });

  private scheduleMeasure(hide: boolean): void {
    if (hide) this.pageReady.set(false);
    cancelAnimationFrame(this.measureRaf);
    this.measureRaf = requestAnimationFrame(() => this.measure(0));
  }

  /**
   * 渲染后测量分页（CSS 多列：每列一页）。
   * 两阶段：先同步 pageW（驱动模板 column-width 绑定），宽度稳定后再读 scrollWidth 算总页数。
   */
  private measure(retry: number): void {
    const vp = this.viewportRef()?.nativeElement;
    const content = this.contentRef()?.nativeElement;
    if (!vp || !content || vp.clientWidth <= 0) {
      // @if 分支尚未渲染完成，下一帧重试
      if (retry < 5) this.measureRaf = requestAnimationFrame(() => this.measure(retry + 1));
      return;
    }
    const w = vp.clientWidth;
    if (w !== this.pageW()) {
      // column-width 绑定待更新，先同步宽度，下一轮 effect 再测量
      this.pageW.set(w);
      return;
    }

    const total = Math.max(1, Math.round(content.scrollWidth / w));
    const chapterChanged = this.lastMeasuredChapter !== this.chapterIndex();
    const oldTotal = this.totalPages();
    const oldIdx = this.pageIndex();

    let idx: number;
    if (this.restoredPage !== null) {
      // 进度恢复：-1 = 最后一页
      idx = this.restoredPage === -1 ? total - 1 : Math.min(this.restoredPage, total - 1);
      this.restoredPage = null;
    } else if (this.reader.pageOffset() === -1) {
      // 向前越过章首：进入上一章末页（prevChapter 写入的哨兵）
      idx = total - 1;
    } else if (chapterChanged) {
      idx = 0;
    } else if (oldTotal !== total && oldTotal > 1) {
      // 同章重排（设置变更/窗口缩放）：按页码比例近似保持阅读位置
      idx = Math.round((oldIdx / (oldTotal - 1)) * (total - 1));
    } else {
      idx = Math.min(oldIdx, total - 1);
    }

    this.totalPages.set(total);
    this.pageIndex.set(idx);
    this.lastMeasuredChapter = this.chapterIndex();
    // 入场方向偏移：向后（下一章首页）内容从右侧滑入；向前（上一章末页）从左侧滑入
    if (chapterChanged && this.entryDir) {
      this.entryOffset.set(this.entryDir === 'next' ? w : -w);
    }
    this.entryDir = null;
    // 同步真实页码并落盘（解析 -1 哨兵 / 应用恢复页码）
    this.reader.setPageOffset(idx);

    // 两帧显示：本帧渲染隐藏态（含入场偏移），下一帧淡入并滑到目标位置
    cancelAnimationFrame(this.revealRaf);
    this.revealRaf = requestAnimationFrame(() => {
      this.pageReady.set(true);
      if (this.entryOffset() !== 0) this.entryOffset.set(0);
    });

    if (chapterChanged) {
      // 异步字体（AppKai woff2）加载完成后文字宽度可能变化，兜底重测一次
      document.fonts?.ready.then(() => {
        if (this.lastMeasuredChapter === this.chapterIndex()) this.scheduleMeasure(false);
      });
    }
  }

  /** 当前章未加载时抓取正文，并预加载下一章（失败静默） */
  private ensureChapterLoaded(idx: number, chs: Chapter[]): void {
    const ch = chs[idx];
    if (!ch) return;
    const id = this.reader.currentBookId() ?? '';
    if (ch.sourceUrl && !ch.loaded) {
      this.chapterLoading.set(true);
      this.chapterError.set(false);
      this.books.loadChapterContent(id, idx).then(
        () => {
          this.chapterLoading.set(false);
          const updated = this.books.getChaptersSync(id);
          if (updated) this.chapters.set(updated);
          const stillMissing = updated?.[idx] && !updated[idx].loaded;
          if (stillMissing) this.chapterError.set(true);
        },
        () => {
          this.chapterLoading.set(false);
          this.chapterError.set(true);
        }
      );
    }
    // 预加载下一章（失败静默）
    const next = chs[idx + 1];
    if (next?.sourceUrl && !next.loaded) {
      this.books.loadChapterContent(id, idx + 1);
    }
  }

  readonly currentChapter = computed<Chapter | undefined>(
    () => this.chapters()[this.chapterIndex()]
  );

  /** 渲染用正文：段首缩进规范化兜底（旧库数据中首段缩进被 trim 剥掉的也能正确显示） */
  readonly displayContent = computed(() =>
    normalizeParagraphIndent(this.currentChapter()?.content ?? '')
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

    // 恢复阅读进度：
    // - 书架 / book-card 默认跳 /reader/{bookId}/0（chapterId=0）
    // - 当 chapterId=0 时优先用 PouchDB 持久化的 progress.chapterIndex
    // - 当 chapterId>0 时视为深链接（如 /reader/{bookId}/5）尊重 URL
    const fromDefaultEntry = chapterId === 0;
    const startChapter =
      fromDefaultEntry && book.progress?.chapterIndex
        ? book.progress.chapterIndex
        : chapterId;

    // 翻页模式的章内页码恢复（scrollOffset 字段复用为页码；-1 = 最后一页）
    if (fromDefaultEntry && book.progress?.scrollOffset !== undefined) {
      this.restoredPage = book.progress.scrollOffset;
    }

    this.reader.openBook(bookId, startChapter);
    this.chapterIndex.set(startChapter);

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
    this.resizeObserver?.disconnect();
    cancelAnimationFrame(this.measureRaf);
    cancelAnimationFrame(this.revealRaf);
  }

  back(): void {
    this.router.navigate(['/bookshelf']);
  }
  next(): void {
    if (this.chapterIndex() >= this.chapters().length - 1) return;
    if (this.paged()) this.entryDir = 'next';
    this.chapterIndex.update((i) => i + 1);
    this.reader.nextChapter();
    this.scrollToTop();
  }
  prev(): void {
    if (this.chapterIndex() === 0) return;
    if (this.paged()) this.entryDir = 'prev';
    this.chapterIndex.update((i) => i - 1);
    this.reader.prevChapter();
    this.scrollToTop();
  }
  goTo(i: number): void {
    if (this.paged()) this.entryDir = i >= this.chapterIndex() ? 'next' : 'prev';
    this.chapterIndex.set(i);
    this.reader.goToChapter(i);
    this.catalogOpen.set(false);
    this.scrollToTop();
  }

  /** 翻页模式：向后翻一页；已到本章末页则切下一章（首页） */
  flipNext(): void {
    if (!this.pageReady()) return;
    if (this.pageIndex() < this.totalPages() - 1) {
      const p = this.pageIndex() + 1;
      this.pageIndex.set(p);
      this.reader.setPageOffset(p);
    } else {
      this.next();
    }
  }

  /** 翻页模式：向前翻一页；已在本章首页则切上一章（末页，-1 哨兵由测量解析） */
  flipPrev(): void {
    if (!this.pageReady()) return;
    if (this.pageIndex() > 0) {
      const p = this.pageIndex() - 1;
      this.pageIndex.set(p);
      this.reader.setPageOffset(p);
    } else {
      this.prev();
    }
  }

  setReadMode(readMode: ReadMode): void {
    this.draft.update((d) => ({ ...d, readMode }));
  }

  /** 重试加载当前失败章节 */
  retryLoad(): void {
    const idx = this.chapterIndex();
    const id = this.reader.currentBookId() ?? '';
    this.chapterLoading.set(true);
    this.chapterError.set(false);
    this.books.loadChapterContent(id, idx).then(() => {
      this.chapterLoading.set(false);
      const updated = this.books.getChaptersSync(id);
      if (updated) this.chapters.set(updated);
      if (updated?.[idx] && !updated[idx].loaded) this.chapterError.set(true);
    });
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
    this.settings.update('readMode', d.readMode);
    this.settingsOpen.set(false);
  }

  cancelSettings(): void {
    this.settingsOpen.set(false);
  }

  /** 键盘左右方向键翻章；Esc 栈式退出（弹窗 → panel → 返回书架） */
  @HostListener('document:keydown', ['$event'])
  onKeydown(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    // 输入态过滤：input/textarea/contenteditable/select 及其子节点都视为可编辑
    const inEditable = !!target?.closest(
      'input, textarea, [contenteditable=true], select'
    );

    if (event.key === 'Escape') {
      // Modal 打开时 Esc 优先关闭顶层 Modal（无视输入态，用户期望在 input 中按 Esc 也能取消）
      if (this.modal.openModals.length > 0) {
        event.preventDefault();
        this.closeTopLayer();
        return;
      }
      // 无 Modal 时，输入态 Esc 不响应（避免丢输入）
      if (inEditable) return;
      event.preventDefault();
      this.closeTopLayer();
      return;
    }

    // 翻页/翻章键：modal 期间 + 输入态 + 章节加载中 全部 return
    if (this.modal.openModals.length > 0 || inEditable) return;
    if (this.chapterLoading()) return;

    switch (event.key) {
      case 'ArrowLeft':
        if (this.paged()) this.flipPrev();
        else this.prev();
        event.preventDefault();
        break;
      case 'ArrowRight':
        if (this.paged()) this.flipNext();
        else this.next();
        event.preventDefault();
        break;
    }
  }

  /**
   * 关闭栈顶层：NzModal 顶层 → settings panel → catalog panel → 返回书架。
   * 栈管理仅覆盖 NzModal 与本组件内的 2 个 signal panel（catalog/settings）；
   * 未来引入 nz-drawer / nz-tooltip 等其他 CDK Overlay 浮层时，需在此处扩展。
   */
  private closeTopLayer(): void {
    const topModal = this.modal.openModals[this.modal.openModals.length - 1];
    if (topModal) {
      // 走 ng-zorro 标准 cancel 流程，触发 nzOnCancel 钩子并清理浮层
      topModal.triggerCancel();
      return;
    }
    if (this.settingsOpen()) {
      this.settingsOpen.set(false);
      return;
    }
    if (this.catalogOpen()) {
      this.catalogOpen.set(false);
      return;
    }
    this.router.navigate(['/bookshelf']);
  }

  /** 左侧"进度"按钮：弹 NzModal 输入章节号跳转 */
  openJumpDialog(): void {
    const total = this.chapters().length;
    if (total === 0) {
      this.msg.warning('章节列表尚未加载');
      return;
    }
    const current = this.chapterIndex() + 1;
    this.modal.create({
      nzTitle: '跳转到指定章节',
      nzContent: JumpChapterDialogComponent,
      nzData: { current, total },
      nzOnOk: (instance: JumpChapterDialogComponent) => {
        const target = instance.target();
        if (target === null) return false; // 用户没输入或输入无效
        this.goTo(target - 1);
        return true;
      },
      nzOkText: '跳转',
      nzCancelText: '取消',
      nzWidth: 360,
      nzKeyboard: false,
    });
  }

  /** 左侧"删除"按钮：弹确认 modal，确认后调 BookService.deleteBook + 回书架 */
  confirmDelete(): void {
    const b = this.book();
    if (!b) {
      this.msg.warning('当前书籍信息尚未加载');
      return;
    }
    this.modal.confirm({
      nzTitle: '确认删除',
      nzContent: `确定删除《${b.title}》及其全部 ${b.chapterCount} 章？此操作不可撤销。`,
      nzOkText: '删除',
      nzOkDanger: true,
      nzCancelText: '取消',
      nzOnOk: async () => {
        try {
          await this.books.deleteBook(b.id);
          this.msg.success(`已删除：${b.title}`);
          this.router.navigate(['/bookshelf']);
          return true;
        } catch (e) {
          // bookDelete 现在严格 throw（含 409）—— 给用户可见反馈，modal 保持打开（P3）
          this.msg.error(`删除失败：${(e as Error).message ?? e}`);
          return false;
        }
      },
      nzKeyboard: false,
    });
  }

  /** 左侧"编辑"按钮：弹 modal 修改当前书籍的书名 / 作者 / 源地址 */
  openEditBookInfoDialog(): void {
    const b = this.book();
    if (!b) {
      this.msg.warning('当前书籍信息尚未加载');
      return;
    }
    this.modal.create({
      nzTitle: '修改书籍信息',
      nzContent: EditBookInfoDialogComponent,
      nzData: { book: b },
      nzOnOk: async (instance: EditBookInfoDialogComponent) => {
        const patch = instance.result();
        if (!patch) return false; // 输入校验失败
        const updated = { ...b, ...patch };
        // 复用 addBook：会保留原有 progress、写入 PouchDB、刷新内存 signal
        await this.books.addBook(updated, []);
        this.msg.success('书籍信息已更新');
        return true;
      },
      nzOkText: '保存',
      nzCancelText: '取消',
      nzWidth: 420,
      nzKeyboard: false,
    });
  }

  /** 左侧"刷新"按钮：章节内容异常时重新抓取（本章 / 全书清空重抓） */
  refreshContent(): void {
    const ch = this.chapters()[this.chapterIndex()];
    if (!ch?.sourceUrl) {
      this.msg.info('本地书籍无需刷新');
      return;
    }
    const ref = this.modal.create({
      nzTitle: '刷新章节内容',
      nzContent:
        '当前章节内容异常时可重新抓取本章；若全书章节内容都有问题，可清空全部章节缓存，之后阅读时按需重新抓取。',
      nzFooter: [
        {
          label: '取消',
          onClick: () => ref.destroy(),
        },
        {
          label: '清空全书重抓',
          type: 'primary',
          danger: true,
          onClick: async () => {
            await this.doRefreshAll();
            ref.destroy();
          },
        },
        {
          label: '刷新本章',
          type: 'primary',
          onClick: async () => {
            await this.doRefreshChapter();
            ref.destroy();
          },
        },
      ],
      nzWidth: 420,
      nzKeyboard: false,
    });
  }

  /** 强制重抓当前章（忽略已缓存内容） */
  private async doRefreshChapter(): Promise<void> {
    const idx = this.chapterIndex();
    const id = this.reader.currentBookId() ?? '';
    this.chapterLoading.set(true);
    this.chapterError.set(false);
    const ok = await this.books.refreshChapter(id, idx);
    this.chapterLoading.set(false);
    const updated = this.books.getChaptersSync(id);
    if (updated) this.chapters.set(updated);
    if (ok) {
      this.msg.success('本章内容已刷新');
    } else {
      this.chapterError.set(true);
      this.msg.error('刷新失败，请稍后重试');
    }
  }

  /** 清空全书章节缓存；当前章由 loadEffect 自动重新抓取 */
  private async doRefreshAll(): Promise<void> {
    const id = this.reader.currentBookId() ?? '';
    await this.books.clearChapterContents(id);
    const updated = this.books.getChaptersSync(id);
    if (updated) this.chapters.set(updated);
    this.msg.success('已清空全书章节缓存，将在阅读时重新抓取');
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
      readMode: s.readMode,
    };
  }
}
