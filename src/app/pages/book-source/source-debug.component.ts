import { Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzRadioModule } from 'ng-zorro-antd/radio';
import { NzSelectModule } from 'ng-zorro-antd/select';
import { NzSpinModule } from 'ng-zorro-antd/spin';
import { NzTagModule } from 'ng-zorro-antd/tag';
import { PageHeaderComponent } from '../../shared/components/page-header/page-header.component';
import { BookSourceTabsComponent } from '../../shared/components/book-source-tabs/book-source-tabs.component';
import { ToastService } from '../../core/services/toast.service';
import { SandboxService, SandboxFn } from '../../core/book-source/js-source/sandbox.service';
import { BookSourceMeta } from '../../core/book-source/js-source/source-meta.types';
import { pickBookUrl, pickChapterUrl } from '../../core/book-source/source-test/source-test.service';

type PomAdmin = {
  booksourceList?: () => Promise<BookSourceMeta[]>;
  booksourceRead?: (fileName: string, sourceDir?: string | null) => Promise<string>;
};

type DebugMode = 'idle' | 'text' | 'search' | 'bookInfo' | 'chapterList' | 'chapterContent' | 'explore';

interface RawItem {
  name?: string;
  title?: string;
  author?: string;
  url?: string;
  bookUrl?: string;
  intro?: string;
  description?: string;
  coverUrl?: string;
}

/**
 * 调试书源页（迁移自 legado DebugSourceTab）
 * 选定书源 → 逐函数调用（搜索/详情/目录/正文/发现）→ 预览 + 原始 JSON 对照
 * 差异：原项目的「浏览器探测」依赖 Tauri browser probe 命令，pomreader 无对应设施，未迁移；
 * 书籍详情抽屉/章节阅读弹窗用目录点击填充 + 正文预览替代
 */
@Component({
  selector: 'app-source-debug',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    NzButtonModule,
    NzIconModule,
    NzInputModule,
    NzRadioModule,
    NzSelectModule,
    NzSpinModule,
    NzTagModule,
    PageHeaderComponent,
    BookSourceTabsComponent,
  ],
  template: `
    <app-page-header title="调试书源" subtitle="逐函数调用书源，预览结果与原始 JSON"></app-page-header>
    <app-book-source-tabs />

    <!-- 书源选择 -->
    <div class="row">
      <span class="row-label">书源：</span>
      <nz-select
        [(ngModel)]="selectedFileName"
        (ngModelChange)="onSourceChange()"
        nzPlaceHolder="选择要调试的书源"
        style="min-width: 260px;"
        nzShowSearch
        nzAllowClear
      >
        @for (s of sources(); track s.fileName) {
          <nz-option [nzValue]="s.fileName" [nzLabel]="s.name + (s.enabled ? '' : '（已禁用）')"></nz-option>
        }
      </nz-select>
      @if (selectedMeta; as m) {
        <nz-tag>{{ m.sourceType || 'novel' }}</nz-tag>
        <span class="muted">{{ m.url }}</span>
      }
    </div>

    <!-- 搜索 -->
    <div class="row">
      <input nz-input [(ngModel)]="testKeyword" placeholder="搜索关键词" class="grow" (keyup.enter)="runSearch()" />
      <button nz-button nzType="primary" (click)="runSearch()" [disabled]="!canRun() || !testKeyword.trim()">
        <span nz-icon nzType="search"></span> 搜索
      </button>
    </div>

    <!-- 书籍 URL → 详情 / 目录 -->
    <div class="row">
      <input nz-input [(ngModel)]="bookUrl" placeholder="书籍 URL（搜索结果点击可填充）" class="grow" />
      <button nz-button (click)="runBookInfo()" [disabled]="!canRun() || !bookUrl.trim()">书籍详情</button>
      <button nz-button (click)="runChapterList()" [disabled]="!canRun() || !bookUrl.trim()">目录</button>
    </div>

    <!-- 章节 URL → 正文 -->
    <div class="row">
      <input nz-input [(ngModel)]="chapterUrl" placeholder="章节 URL（目录项点击可填充）" class="grow" />
      <button nz-button (click)="runChapterContent()" [disabled]="!canRun() || !chapterUrl.trim()">正文</button>
    </div>

    <!-- 状态行 + 视图切换 -->
    @if (loading()) {
      <div class="status"><nz-spin nzSimple></nz-spin> 执行中...</div>
    } @else if (statusText()) {
      <div class="status" [class.status--ok]="statusOk()" [class.status--err]="!statusOk()">{{ statusText() }}</div>
    }

    <!-- 沙箱进度日志(显示执行到哪一步,卡哪一步) -->
    @if (sandboxProgress().length > 0) {
      <details class="sandbox-progress" open>
        <summary>沙箱进度（最近 {{ sandboxProgress().length }} 条）</summary>
        <pre class="progress-log">{{ sandboxProgressText() }}</pre>
      </details>
    }

    @if (mode() !== 'idle') {
      <div class="view-toggle">
        <nz-radio-group [(ngModel)]="viewMode" nzSize="small">
          <label nz-radio-button nzValue="preview">预览</label>
          <label nz-radio-button nzValue="raw">原始 JSON</label>
        </nz-radio-group>
        @if (exploreCategories().length > 0) {
          <div class="cat-row">
            @for (c of exploreCategories(); track c) {
              <button
                nz-button
                nzSize="small"
                [nzType]="c === activeCategory() ? 'primary' : 'default'"
                (click)="runExploreCategory(c)"
              >{{ c || '(默认)' }}</button>
            }
          </div>
        }
      </div>

      @if (viewMode === 'raw') {
        <pre class="raw-json">{{ rawJson() }}</pre>
      } @else {
        <!-- 预览渲染 -->
        @if (mode() === 'search' || mode() === 'explore') {
          <div class="preview-list">
            @for (it of items(); track $index) {
              <div class="preview-item" (click)="fillBookUrl(it)">
                <div class="preview-item__name">{{ it.name || it.title || '（无书名）' }}</div>
                @if (it.author) { <div class="preview-item__meta">{{ it.author }}</div> }
                <div class="preview-item__url">{{ it.bookUrl || it.url }}</div>
              </div>
            }
            @if (items().length === 0) { <div class="muted">无结果</div> }
          </div>
        }
        @if (mode() === 'bookInfo') {
          <div class="book-info">
            <h3>{{ bookInfo()['title'] || bookInfo()['name'] }}</h3>
            <p class="muted">{{ bookInfo()['author'] }}</p>
            <p>{{ bookInfo()['intro'] || bookInfo()['description'] }}</p>
          </div>
        }
        @if (mode() === 'chapterList') {
          <div class="preview-list">
            @for (ch of chapters(); track $index) {
              <div class="preview-item" (click)="fillChapterUrl(ch)">
                <div class="preview-item__name">{{ ch.name || ch.title }}</div>
                <div class="preview-item__url">{{ ch.url }}</div>
              </div>
            }
          </div>
        }
        @if (mode() === 'chapterContent' || mode() === 'text') {
          <pre class="content-text">{{ contentText() }}</pre>
        }
      }
    }
  `,
  styles: [
    `
      .row { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; flex-wrap: wrap; }
      .row-label { color: var(--pom-text-muted); font-size: 13px; }
      .grow { flex: 1; min-width: 220px; }
      .muted { color: var(--pom-text-muted); font-size: 12px; }
      .status { margin: 8px 0; font-size: 13px; color: var(--pom-text-muted); display: flex; align-items: center; gap: 8px; }
      .status--ok { color: #52c41a; }
      .status--err { color: #ff4d4f; white-space: pre-wrap; }
      .view-toggle { display: flex; align-items: center; gap: 12px; margin: 8px 0 12px; flex-wrap: wrap; }
      .cat-row { display: flex; gap: 6px; flex-wrap: wrap; }
      .raw-json, .content-text {
        max-height: 56vh; overflow: auto; padding: 12px;
        background: var(--pom-card); border: 1px solid var(--pom-border); border-radius: 4px;
        font-family: 'Cascadia Code', Consolas, monospace; font-size: 12px; line-height: 1.6;
        color: var(--pom-text); white-space: pre-wrap; word-break: break-all;
      }
      /* 沙箱进度日志面板(暗色适配: 用半透明背景 + 浅色文本 + 行间色标) */
      .sandbox-progress { margin: 8px 0; font-size: 12px; }
      .sandbox-progress summary {
        cursor: pointer; color: var(--pom-text-muted); padding: 4px 0;
      }
      .progress-log {
        max-height: 200px; overflow: auto; padding: 8px 12px; margin: 4px 0 0;
        background: var(--pom-card); border: 1px solid var(--pom-border); border-radius: 4px;
        font-family: 'Cascadia Code', Consolas, monospace; font-size: 11px; line-height: 1.5;
        color: var(--pom-text); white-space: pre-wrap; word-break: break-all;
      }
      /* 浅色主题 fallback: 防止 CSS 变量缺失时黑字黑背景 */
      :host ::ng-deep .progress-log { color: var(--pom-text, #333); background: var(--pom-card, #fafafa); }
      :host-context(.dark) ::ng-deep .progress-log { color: #d6d6d6; background: #1f1f1f; border-color: #444; }
      :host-context(.dark) ::ng-deep .sandbox-progress summary { color: #aaa; }
      .preview-list { max-height: 56vh; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; }
      .preview-item { padding: 8px 10px; border: 1px solid var(--pom-border); border-radius: 4px; background: var(--pom-card); cursor: pointer; }
      .preview-item:hover { border-color: var(--pom-accent); }
      .preview-item__name { font-size: 13px; font-weight: 500; color: var(--pom-text); }
      .preview-item__meta { font-size: 12px; color: var(--pom-text-muted); }
      .preview-item__url { font-size: 11px; color: var(--pom-text-muted); word-break: break-all; }
      .book-info h3 { margin: 0 0 4px; color: var(--pom-text); }
      .book-info p { color: var(--pom-text); margin: 4px 0; }
    `,
  ],
})
export class SourceDebugComponent {
  readonly sources = signal<BookSourceMeta[]>([]);
  readonly loading = signal(false);
  readonly statusText = signal('');
  readonly statusOk = signal(false);
  readonly mode = signal<DebugMode>('idle');
  readonly rawJson = signal('');
  readonly items = signal<RawItem[]>([]);
  readonly chapters = signal<RawItem[]>([]);
  readonly bookInfo = signal<Record<string, unknown>>({});
  readonly contentText = signal('');
  readonly exploreCategories = signal<string[]>([]);
  readonly activeCategory = signal('');

  selectedFileName = '';
  testKeyword = ['庆余年', '雪中悍刀行', '赘婿', '斗破苍穹', '盗墓笔记', '鬼吹灯'][
    Math.floor(Math.random() * 6)
  ];
  bookUrl = '';
  chapterUrl = '';
  viewMode: 'preview' | 'raw' = 'preview';

  // 注意：不能写成 computed(() => ... this.selectedFileName ...) ——
  // computed 只追踪 signal 依赖，普通属性的变更不会触发重算，选中后会一直返回缓存的 null
  get selectedMeta(): BookSourceMeta | null {
    return this.sources().find((s) => s.fileName === this.selectedFileName) ?? null;
  }

  private readonly sandbox = inject(SandboxService);
  /** 沙箱进度日志 signal(直接显示在 UI,不再依赖 console) */
  readonly sandboxProgress = this.sandbox.progress;
  readonly sandboxProgressText = computed(() => this.sandboxProgress().join('\n'));
  private readonly toast = inject(ToastService);
  private readonly route = inject(ActivatedRoute);

  constructor() {
    void this.load();
  }

  async load(): Promise<void> {
    const api = (window as unknown as { pomAPI?: PomAdmin }).pomAPI;
    if (!api?.booksourceList) {
      this.toast.error('IPC 不可用');
      return;
    }
    try {
      const list = await api.booksourceList();
      this.sources.set(Array.isArray(list) ? list : []);
      // 支持 ?source=xx.js 预选（智能添加保存后跳转）
      const pre = this.route.snapshot.queryParamMap.get('source');
      if (pre && this.sources().some((s) => s.fileName === pre)) {
        this.selectedFileName = pre;
        this.onSourceChange();
      }
    } catch (e) {
      this.toast.error(`加载失败：${(e as Error).message}`);
    }
  }

  canRun(): boolean {
    return !!this.selectedFileName && !this.loading();
  }

  onSourceChange(): void {
    this.resetResult();
  }

  /** 每次调用前确保书源已加载进沙箱 */
  private async ensureLoaded(): Promise<void> {
    const meta = this.selectedMeta;
    if (!meta) throw new Error('请先选择书源');
    const api = (window as unknown as { pomAPI?: PomAdmin }).pomAPI;
    if (!api?.booksourceRead) throw new Error('booksourceRead IPC 不可用');
    const source = await api.booksourceRead(meta.fileName, meta.sourceDir || null);
    await this.sandbox.load(meta.fileName, source);
  }

  /** 通用执行：装载 → 调用 → 写状态/预览数据/原始 JSON */
  private async exec<T>(
    fn: SandboxFn,
    args: unknown[],
    m: DebugMode,
    okText: (v: T) => string,
    apply: (v: T) => void,
  ): Promise<void> {
    this.loading.set(true);
    this.resetResult();
    this.sandbox.clearProgress();
    this.sandboxProgress.update(() => [`▶ 开始执行 ${fn}(...)`, ...this.sandboxProgress()].slice(0, 100));
    try {
      await this.ensureLoaded();
      const raw = await this.sandbox.call<T>(this.selectedFileName, fn, args);
      apply(raw);
      this.rawJson.set(JSON.stringify(raw, null, 2));
      this.statusOk.set(true);
      this.mode.set(m);
      this.statusText.set(okText(raw));
    } catch (e) {
      this.statusOk.set(false);
      this.mode.set('text');
      this.contentText.set('');
      this.statusText.set(`✗ 执行失败\n${(e as Error).message}`);
    } finally {
      this.loading.set(false);
    }
  }

  runSearch(): void {
    void this.exec<unknown[]>('search', [this.testKeyword.trim(), 1], 'search',
      (v) => `✓ 搜索成功，找到 ${Array.isArray(v) ? v.length : 0} 条结果`,
      (v) => this.items.set(Array.isArray(v) ? (v as RawItem[]) : []));
  }

  runBookInfo(): void {
    void this.exec<Record<string, unknown>>('bookInfo', [this.bookUrl.trim()], 'bookInfo',
      () => '✓ 书籍详情获取成功',
      (v) => this.bookInfo.set(v && typeof v === 'object' ? v : {}));
  }

  runChapterList(): void {
    void this.exec<unknown[]>('chapterList', [this.bookUrl.trim()], 'chapterList',
      (v) => `✓ 目录获取成功，共 ${Array.isArray(v) ? v.length : 0} 章`,
      (v) => this.chapters.set(Array.isArray(v) ? (v as RawItem[]) : []));
  }

  runChapterContent(): void {
    void this.exec<string>('chapterContent', [this.chapterUrl.trim()], 'chapterContent',
      (v) => `✓ 正文获取成功（${typeof v === 'string' ? v.length : 0} 字符）`,
      (v) => this.contentText.set(typeof v === 'string' ? v : JSON.stringify(v, null, 2)));
  }

  runExploreCategory(category: string): void {
    this.activeCategory.set(category);
    void this.exec<unknown[]>('explore', [category, 1, true], 'explore',
      (v) => `✓ 分类「${category}」加载成功，共 ${Array.isArray(v) ? v.length : 0} 本`,
      (v) => this.items.set(Array.isArray(v) ? (v as RawItem[]) : []));
  }

  fillBookUrl(it: RawItem): void {
    const u = pickBookUrl([it]);
    if (u) {
      this.bookUrl = u;
      this.toast.success('已填充书籍 URL');
    }
  }

  fillChapterUrl(ch: RawItem): void {
    const u = pickChapterUrl([ch]);
    if (u) {
      this.chapterUrl = u;
      this.toast.success('已填充章节 URL');
    }
  }

  private resetResult(): void {
    this.mode.set('idle');
    this.statusText.set('');
    this.rawJson.set('');
    this.items.set([]);
    this.chapters.set([]);
    this.bookInfo.set({});
    this.contentText.set('');
    this.exploreCategories.set([]);
    this.activeCategory.set('');
  }
}
