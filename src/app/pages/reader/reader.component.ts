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
              @if (chapterLoading()) {
                <p class="chapter-loading">章节加载中...</p>
              } @else if (chapterError()) {
                <p class="chapter-loading">该章节加载失败。<a (click)="retryLoad()">重试</a></p>
              } @else {
                <pre class="read-content">{{ currentChapter()?.content }}</pre>
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

  /** 按需加载：当前章未加载时触发抓取；渲染后预加载下一章（spec §5.3） */
  private readonly loadEffect = effect(() => {
    const idx = this.chapterIndex();
    const chs = this.chapters();
    // 依赖版本号使在线章节更新后刷新
    this.books.chaptersVersion();
    const ch = chs[idx];
    if (!ch) return;
    if (ch.sourceUrl && !ch.loaded) {
      this.chapterLoading.set(true);
      this.chapterError.set(false);
      this.books.loadChapterContent(this.reader.currentBookId() ?? '', idx).then(
        () => {
          this.chapterLoading.set(false);
          const updated = this.books.getChaptersSync(this.reader.currentBookId() ?? '');
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
      this.books.loadChapterContent(this.reader.currentBookId() ?? '', idx + 1);
    }
  });

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

    // 恢复阅读进度：
    // - 书架 / book-card 默认跳 /reader/{bookId}/0（chapterId=0）
    // - 当 chapterId=0 时优先用 PouchDB 持久化的 progress.chapterIndex
    // - 当 chapterId>0 时视为深链接（如 /reader/{bookId}/5）尊重 URL
    const fromDefaultEntry = chapterId === 0;
    const startChapter =
      fromDefaultEntry && book.progress?.chapterIndex
        ? book.progress.chapterIndex
        : chapterId;

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
    this.settingsOpen.set(false);
  }

  cancelSettings(): void {
    this.settingsOpen.set(false);
  }

  /** 键盘左右方向键翻章（在输入框内不响应，避免误触） */
  @HostListener('document:keydown', ['$event'])
  onKeydown(event: KeyboardEvent): void {
    // 跳过正在输入的状态（input/textarea/contenteditable）
    const target = event.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable)
    ) {
      return;
    }
    // 章节加载中不响应（避免重复触发）
    if (this.chapterLoading()) return;

    switch (event.key) {
      case 'ArrowLeft':
        this.prev();
        event.preventDefault();
        break;
      case 'ArrowRight':
        this.next();
        event.preventDefault();
        break;
    }
  }

  /** 左侧"进度"按钮：弹 NzModal 输入章节号跳转 */
  openJumpDialog(): void {
    const total = this.chapters().length;
    if (total === 0) {
      this.msg.warning('章节列表尚未加载');
      return;
    }
    const current = this.chapterIndex() + 1;
    const ref = this.modal.create({
      nzTitle: '跳转到指定章节',
      nzContent: JumpChapterDialogComponent,
      nzData: { current, total },
      nzOnOk: (instance: JumpChapterDialogComponent) => {
        const target = instance.target();
        if (target === null) return false; // 用户没输入或输入无效
        if (target < 1 || target > total) {
          this.msg.error(`章节号需在 1-${total} 之间`);
          return false;
        }
        this.goTo(target - 1);
        return true;
      },
      nzOkText: '跳转',
      nzCancelText: '取消',
      nzWidth: 360,
    });
    // modal 引用释放（避免类型未使用警告）
    void ref;
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
        await this.books.deleteBook(b.id);
        this.msg.success(`已删除：${b.title}`);
        this.router.navigate(['/bookshelf']);
        return true;
      },
    });
  }

  /** 左侧"编辑"按钮：弹 modal 修改当前书籍的书名 / 作者 / 源地址 */
  openEditBookInfoDialog(): void {
    const b = this.book();
    if (!b) {
      this.msg.warning('当前书籍信息尚未加载');
      return;
    }
    const ref = this.modal.create({
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
    });
    void ref;
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
