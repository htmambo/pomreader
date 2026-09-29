import { Component, ChangeDetectionStrategy, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzRadioModule } from 'ng-zorro-antd/radio';
import { NzSelectModule } from 'ng-zorro-antd/select';
import { NzSpinModule } from 'ng-zorro-antd/spin';
import { NzTagModule } from 'ng-zorro-antd/tag';
import { ToastService } from '../../core/services/toast.service';
import { RuleEngineService } from '../../core/book-source/json-rule/rule-engine.service';
import {
  type RuleBookInfo,
  type RuleChapterItem,
  type RuleSearchItem,
  type RuleTrace,
} from '../../core/book-source/json-rule/engine';
import { type BookSourceMeta } from '../../core/book-source/source-meta.types';
import {
  pickBookUrl,
  pickChapterUrl,
} from '../../core/book-source/source-test/source-test.service';
import { randomTestKeyword } from '../../core/book-source/smart-add/smart-rules';

type PomAdmin = {
  booksourceListJson?: () => Promise<BookSourceMeta[]>;
};

type DebugMode = 'idle' | 'text' | 'search' | 'bookInfo' | 'chapterList' | 'chapterContent';

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

/** trace 日志上限（调试页展示用，超出截断保留最近） */
const TRACE_LIMIT = 200;

/**
 * 调试书源页（迁移自 legado DebugSourceTab；P3 切 JSON 规则引擎，方案 §5）
 * 选定 JSON 书源 → 逐入口调用（搜索/详情/目录/正文）→ 预览 + 原始 JSON 对照
 * - JS 沙箱 → RuleEngineService（沙箱 P4 删除；explore 入口按 D3 移除）
 * - 进度日志区渲染 RuleTrace（订阅 RuleEngineService.traces$，F11）：
 *   阶段 / 请求 URL+method / HTTP 状态 / 命中规则 / 提取条数 / 耗时
 * 差异：原项目的「浏览器探测」依赖 Tauri browser probe 命令，pomreader 无对应设施，未迁移；
 * 书籍详情抽屉/章节阅读弹窗用目录点击填充 + 正文预览替代
 */
@Component({
  selector: 'app-book-source-debug',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    NzButtonModule,
    NzIconModule,
    NzInputModule,
    NzRadioModule,
    NzSelectModule,
    NzSpinModule,
    NzTagModule,
  ],
  templateUrl: './book-source-debug.component.html',
  preserveWhitespaces: true,
  styles: [
    `
      .row {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 10px;
        flex-wrap: wrap;
      }
      .row-label {
        color: var(--pom-text-muted);
        font-size: 13px;
      }
      .grow {
        flex: 1;
        min-width: 220px;
      }
      .muted {
        color: var(--pom-text-muted);
        font-size: 12px;
      }
      .status {
        margin: 8px 0;
        font-size: 13px;
        color: var(--pom-text-muted);
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .status--ok {
        color: #52c41a;
      }
      .status--err {
        color: #ff4d4f;
        white-space: pre-wrap;
      }
      .view-toggle {
        display: flex;
        align-items: center;
        gap: 12px;
        margin: 8px 0 12px;
        flex-wrap: wrap;
      }
      .raw-json,
      .content-text {
        max-height: 56vh;
        overflow: auto;
        padding: 12px;
        background: var(--pom-card);
        border: 1px solid var(--pom-border);
        border-radius: 4px;
        font-family: 'Cascadia Code', Consolas, monospace;
        font-size: 12px;
        line-height: 1.6;
        color: var(--pom-text);
        white-space: pre-wrap;
        word-break: break-all;
      }
      /* 引擎 trace 日志面板(暗色适配: 用半透明背景 + 浅色文本 + 行间色标) */
      .trace-log {
        margin: 8px 0;
        font-size: 12px;
      }
      .trace-log summary {
        cursor: pointer;
        color: var(--pom-text-muted);
        padding: 4px 0;
      }
      .progress-log {
        max-height: 200px;
        overflow: auto;
        padding: 8px 12px;
        margin: 4px 0 0;
        background: var(--pom-card);
        border: 1px solid var(--pom-border);
        border-radius: 4px;
        font-family: 'Cascadia Code', Consolas, monospace;
        font-size: 11px;
        line-height: 1.5;
        color: var(--pom-text);
        white-space: pre-wrap;
        word-break: break-all;
      }
      /* 浅色主题 fallback: 防止 CSS 变量缺失时黑字黑背景 */
      :host ::ng-deep .progress-log {
        color: var(--pom-text, #333);
        background: var(--pom-card, #fafafa);
      }
      :host-context(.dark) ::ng-deep .progress-log {
        color: #d6d6d6;
        background: #1f1f1f;
        border-color: #444;
      }
      :host-context(.dark) ::ng-deep .trace-log summary {
        color: #aaa;
      }
      .preview-list {
        max-height: 56vh;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .preview-item {
        padding: 8px 10px;
        border: 1px solid var(--pom-border);
        border-radius: 4px;
        background: var(--pom-card);
        cursor: pointer;
      }
      .preview-item:hover {
        border-color: var(--pom-accent);
      }
      .preview-item__name {
        font-size: 13px;
        font-weight: 500;
        color: var(--pom-text);
      }
      .preview-item__meta {
        font-size: 12px;
        color: var(--pom-text-muted);
      }
      .preview-item__url {
        font-size: 11px;
        color: var(--pom-text-muted);
        word-break: break-all;
      }
      .book-info h3 {
        margin: 0 0 4px;
        color: var(--pom-text);
      }
      .book-info p {
        color: var(--pom-text);
        margin: 4px 0;
      }
    `,
  ],
})
export class BookSourceDebugComponent {
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

  selectedFileName = '';
  testKeyword = randomTestKeyword();
  bookUrl = '';
  chapterUrl = '';
  viewMode: 'preview' | 'raw' = 'preview';

  // 注意：不能写成 computed(() => ... this.selectedFileName ...) ——
  // computed 只追踪 signal 依赖，普通属性的变更不会触发重算，选中后会一直返回缓存的 null
  get selectedMeta(): BookSourceMeta | null {
    return this.sources().find((s) => s.fileName === this.selectedFileName) ?? null;
  }

  private readonly engine = inject(RuleEngineService);
  /** 引擎 trace 日志（F11）：订阅 traces$，截断保留最近 TRACE_LIMIT 条 */
  readonly traces = signal<RuleTrace[]>([]);
  readonly traceLines = computed(() => this.traces().map((t) => this.formatTrace(t)));
  readonly traceLogText = computed(() => this.traceLines().join('\n'));
  private readonly toast = inject(ToastService);
  private readonly route = inject(ActivatedRoute);

  constructor() {
    this.engine.traces$
      .pipe(takeUntilDestroyed())
      .subscribe((t) => this.traces.update((arr) => [...arr, t].slice(-TRACE_LIMIT)));
    void this.load();
  }

  /** 从 JSON 源列表选择调试对象（方案 §5：booksourceListJson） */
  async load(): Promise<void> {
    const api = (window as unknown as { pomAPI?: PomAdmin }).pomAPI;
    if (!api?.booksourceListJson) {
      this.toast.error('IPC 不可用');
      return;
    }
    try {
      const list = await api.booksourceListJson();
      this.sources.set(Array.isArray(list) ? list : []);
      // 支持 ?source=xx.json 预选（智能添加保存后跳转）
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

  /** RuleTrace → 单行日志（阶段 / URL+method / HTTP 状态 / 命中规则 / 提取条数 / 耗时） */
  private formatTrace(t: RuleTrace): string {
    const head = `[${t.phase}]`;
    if (t.stage === 'http') {
      return `${head} HTTP ${t.method ?? 'GET'} ${t.url ?? ''} → ${t.status ?? '?'}（${t.durationMs}ms）`;
    }
    if (t.stage === 'extract') {
      const extra =
        t.itemCount !== undefined
          ? `，提取 ${t.itemCount} 条`
          : t.contentLength !== undefined
            ? `，正文 ${t.contentLength} 字符`
            : '';
      return `${head} 命中规则 ${t.ruleField ?? ''}${t.rule ? ` = ${t.rule}` : ''}${extra}`;
    }
    return t.error
      ? `${head} ✗ 失败：${t.error}（${t.durationMs}ms）`
      : `${head} ✓ 完成（${t.durationMs}ms）`;
  }

  /** 通用执行：清空 trace → 调引擎入口 → 写状态/预览数据/原始 JSON */
  private async exec<T>(
    run: (meta: BookSourceMeta) => Promise<T>,
    m: DebugMode,
    okText: (v: T) => string,
    apply: (v: T) => void,
  ): Promise<void> {
    const meta = this.selectedMeta;
    if (!meta) {
      this.toast.warn('请先选择书源');
      return;
    }
    this.loading.set(true);
    this.resetResult();
    this.traces.set([]);
    try {
      const raw = await run(meta);
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
    const keyword = this.testKeyword.trim();
    void this.exec<RuleSearchItem[]>(
      (meta) => this.engine.search(meta, keyword, 1),
      'search',
      (v) => `✓ 搜索成功，找到 ${v.length} 条结果`,
      (v) => this.items.set(v),
    );
  }

  runBookInfo(): void {
    const url = this.bookUrl.trim();
    void this.exec<RuleBookInfo>(
      (meta) => this.engine.bookInfo(meta, url),
      'bookInfo',
      () => '✓ 书籍详情获取成功',
      (v) => this.bookInfo.set(v as unknown as Record<string, unknown>),
    );
  }

  runChapterList(): void {
    const url = this.bookUrl.trim();
    void this.exec<RuleChapterItem[]>(
      (meta) => this.engine.chapterList(meta, url),
      'chapterList',
      (v) => `✓ 目录获取成功，共 ${v.length} 章`,
      (v) => this.chapters.set(v),
    );
  }

  runChapterContent(): void {
    const url = this.chapterUrl.trim();
    void this.exec<string>(
      (meta) => this.engine.chapterContent(meta, url),
      'chapterContent',
      (v) => `✓ 正文获取成功（${v.length} 字符）`,
      (v) => this.contentText.set(typeof v === 'string' ? v : JSON.stringify(v, null, 2)),
    );
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
  }
}
