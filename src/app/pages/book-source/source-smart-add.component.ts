import { Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzAlertModule } from 'ng-zorro-antd/alert';
import { NzSelectModule } from 'ng-zorro-antd/select';
import { PageHeaderComponent } from '../../shared/components/page-header/page-header.component';
import { BookSourceTabsComponent } from '../../shared/components/book-source-tabs/book-source-tabs.component';
import { ToastService } from '../../core/services/toast.service';
import { PageFetcherService } from '../../core/book-source/page-fetcher.service';
import {
  SourceRules,
  MatchedItem,
  SearchMethod,
  SearchBodyParam,
  buildRules,
  buildFormBody,
  countChapterLinks,
  generateSourceCode,
  matchLinkItems,
  pickHtml,
  pickText,
  pickAttr,
  stripTags,
  absUrl,
  randomTestKeyword,
} from '../../core/book-source/smart-add/smart-rules';

type PomSave = {
  booksourceSave?: (fileName: string, content: string, sourceDir?: string) => Promise<void>;
};

/** 单阶段测试状态（搜索/详情/目录/正文共用） */
interface StageState {
  running: boolean;
  error: string;
  summary: string;
  /** 样本预览；clickable=true 的样本点击后回填下游 URL 输入框 */
  samples: Array<{ label: string; value: string; clickable: boolean }>;
}

function emptyStage(): StageState {
  return { running: false, error: '', summary: '', samples: [] };
}

/**
 * 智能添加页（迁移自 legado SmartSourceDetector）
 * 步骤：输入 URL → 真实抓取 + 启发式探测 → 可视化规则处理（可编辑 + 逐阶段真实命中测试）
 *      → 规则参数化生成代码（可再编辑）→ 保存 / 保存并调试
 * 规则双模式：CSS 选择器（如 dl.list dd a；含特殊符号加 css: 前缀）或正则；
 * 沙箱无 DOM → CSS 选择器经 legado.query 主线程 DOMParser 代理执行
 */
@Component({
  selector: 'app-source-smart-add',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    NzButtonModule,
    NzIconModule,
    NzInputModule,
    NzAlertModule,
    NzSelectModule,
    PageHeaderComponent,
    BookSourceTabsComponent,
  ],
  template: `
    <app-page-header title="智能添加" subtitle="输入网址 → 调整规则 → 生成书源"></app-page-header>
    <app-book-source-tabs />

    <!-- ① URL 输入 -->
    <div class="url-row">
      <input
        nz-input
        [(ngModel)]="targetUrl"
        placeholder="目标网站首页或书籍页 URL（https://...）"
        [disabled]="analyzing()"
        (keyup.enter)="analyze()"
        class="grow"
      />
      <button nz-button nzType="primary" (click)="analyze()" [disabled]="analyzing() || !targetUrl.trim()">
        <span nz-icon [nzType]="analyzing() ? 'loading' : 'thunderbolt'"></span>
        {{ analyzing() ? '分析中...' : '分析' }}
      </button>
    </div>

    @if (error()) {
      <nz-alert nzType="error" [nzMessage]="error()" class="mb"></nz-alert>
    }

    @if (rules) {
      <!-- ② 探测摘要 -->
      <div class="summary">
        <div class="summary-item"><span class="k">站点名称</span><span class="v">{{ rules.siteName }}</span></div>
        <div class="summary-item"><span class="k">章节链接</span><span class="v">首页检测到 {{ chapterLinkCount }} 个疑似章节链接</span></div>
      </div>

      <!-- ③ 规则处理 -->
      <div class="rules-title">规则处理<span class="rules-hint">支持 CSS 选择器（如 dl.list dd a）或正则；含 * ^ $ | + ? ( ) &#123; &#125; \ 等正则特征符号的 CSS（如 a[href*="x"]、div + p、a:not(.x)）需加 css: 前缀</span></div>

      <!-- 搜索规则 -->
      <div class="stage-card">
        <div class="stage-header">搜索</div>
        <div class="field-row">
          <span class="field-label">搜索路径</span>
          <input nz-input [(ngModel)]="rules.searchPath" class="mono grow" [placeholder]="searchPathPlaceholder()" />
        </div>
        <div class="field-row">
          <span class="field-label">请求方式</span>
          <nz-select [(ngModel)]="rules.searchMethod" class="grow">
            <nz-option nzValue="GET" nzLabel="GET — URL 参数"></nz-option>
            <nz-option nzValue="POST" nzLabel="POST — 表单 (form-urlencoded)"></nz-option>
            <nz-option nzValue="POST_RAW" nzLabel="POST — 原始 body (JSON / XML)"></nz-option>
          </nz-select>
        </div>

        <!-- POST 表单参数可视化编辑（仅 POST 模式） -->
        @if (rules.searchMethod === 'POST') {
          <div class="field-row" style="margin-top: 8px;">
            <span class="field-label">Content-Type</span>
            <input nz-input [(ngModel)]="rules.searchContentType" class="mono grow" placeholder="application/x-www-form-urlencoded" />
          </div>
          <div class="body-params">
            <div class="body-params-header">
              <span class="body-params-title">表单参数</span>
              <span class="body-params-hint">value 支持 &#123;keyword&#125; / &#123;page&#125; 占位符,运行时自动 encode</span>
              <button nz-button nzSize="small" nzType="dashed" (click)="addBodyParam()">
                <span nz-icon nzType="plus"></span> 添加参数
              </button>
            </div>
            @for (p of rules.searchBodyParams; track $index; let i = $index) {
              <div class="body-param-row">
                <input nz-input [ngModel]="p.key" (ngModelChange)="updateBodyParam(i, 'key', $event)" placeholder="key" class="mono param-key" />
                <span class="param-eq">=</span>
                <input nz-input [ngModel]="p.value" (ngModelChange)="updateBodyParam(i, 'value', $event)" placeholder="value (支持 {keyword} / {page})" class="mono param-value" />
                <button nz-button nzSize="small" nzType="text" nzDanger (click)="removeBodyParam(i)" title="删除">
                  <span nz-icon nzType="delete"></span>
                </button>
              </div>
            }
            @if (!(rules.searchBodyParams && rules.searchBodyParams.length)) {
              <div class="body-params-empty">暂无参数 —— 点击「添加参数」开始配置</div>
            }
          </div>
        }

        <!-- POST 原始 body 文本框（仅 POST_RAW 模式） -->
        @if (rules.searchMethod === 'POST_RAW') {
          <div class="field-row" style="margin-top: 8px;">
            <span class="field-label">Content-Type</span>
            <input nz-input [(ngModel)]="rules.searchContentType" class="mono grow" placeholder="application/json" />
          </div>
          <div class="field-row" style="margin-top: 8px; align-items: flex-start;">
            <span class="field-label">原始 Body</span>
            <textarea
              nz-input
              [(ngModel)]="rules.searchRawBody"
              class="mono grow raw-body"
              rows="3"
              placeholder='{"keyword":"{keyword}","page":{page}}'
            ></textarea>
          </div>
        }

        <div class="field-row">
          <span class="field-label">列表项规则</span>
          <input nz-input [(ngModel)]="rules.searchItemPattern" class="mono grow" />
        </div>
        <div class="field-row">
          <span class="field-label">测试关键词</span>
          <input nz-input [(ngModel)]="testKeyword" class="keyword-input" />
          <button nz-button nzSize="small" (click)="testSearch()" [disabled]="stage.search.running">
            <span nz-icon [nzType]="stage.search.running ? 'loading' : 'play-circle'"></span> 测试搜索
          </button>
        </div>
        @if (stage.search.error) { <div class="stage-error">{{ stage.search.error }}</div> }
        @if (stage.search.summary) { <div class="stage-summary">{{ stage.search.summary }}</div> }
        @if (stage.search.samples.length) {
          <div class="sample-list">
            @for (s of stage.search.samples; track s.value) {
              <div class="sample" (click)="pickSample('search', s)">
                <span class="sample-label">{{ s.label }}</span>
                <span class="sample-value">{{ s.value }}</span>
              </div>
            }
          </div>
        }
      </div>

      <!-- 详情规则 -->
      <div class="stage-card">
        <div class="stage-header">书籍详情</div>
        <div class="field-row">
          <span class="field-label">书籍 URL</span>
          <input nz-input [(ngModel)]="bookUrl" class="mono grow" placeholder="搜索测试命中后自动填充，也可手动输入" />
        </div>
        <div class="field-row">
          <span class="field-label">标题规则</span>
          <input nz-input [(ngModel)]="rules.bookTitlePattern" class="mono grow" />
        </div>
        <div class="field-row">
          <span class="field-label">封面规则</span>
          <input nz-input [(ngModel)]="rules.coverUrlPattern" class="mono grow" placeholder="css:.book-img img  或正则如 <img[^>]+src=&quot;([^&quot;]+)&quot;" />
        </div>
        <div class="field-row">
          <span class="field-label">作者规则</span>
          <input nz-input [(ngModel)]="rules.bookAuthorPattern" class="mono grow" />
        </div>

        <!-- 分类字段(随测试详情一并跑):从书籍详情页抓取 + 用分类规则提取题材名 -->
        <div class="field-row" style="margin-top: 12px;">
          <span class="field-label">分类规则</span>
          <input nz-input [(ngModel)]="rules.bookCategoryPattern" class="mono grow" placeholder="分类[：:]\s*&lt;[^&gt;]+&gt;\s*([^&lt;]{1,20})" />
          <button nz-button nzSize="small" (click)="testBookInfo()" [disabled]="stage.info.running || !bookUrl.trim()">
            <span nz-icon [nzType]="stage.info.running ? 'loading' : 'play-circle'"></span> 测试详情
          </button>
        </div>
        @if (stage.info.error) { <div class="stage-error">{{ stage.info.error }}</div> }
        @if (stage.info.summary) { <div class="stage-summary">{{ stage.info.summary }}</div> }
        @for (s of stage.info.samples; track $index) {
          <div class="sample sample--static">
            <span class="sample-label">{{ s.label }}</span>
            <span class="sample-value">{{ s.value }}</span>
          </div>
        }
      </div>

      <!-- 目录规则 -->
      <div class="stage-card">
        <div class="stage-header">目录</div>
        <div class="field-row">
          <span class="field-label">章节链接规则</span>
          <input nz-input [(ngModel)]="rules.chapterItemPattern" class="mono grow" />
          <button nz-button nzSize="small" (click)="testToc()" [disabled]="stage.toc.running || !bookUrl.trim()">
            <span nz-icon [nzType]="stage.toc.running ? 'loading' : 'play-circle'"></span> 测试目录
          </button>
        </div>
        @if (stage.toc.error) { <div class="stage-error">{{ stage.toc.error }}</div> }
        @if (stage.toc.summary) { <div class="stage-summary">{{ stage.toc.summary }}</div> }
        @if (stage.toc.samples.length) {
          <div class="sample-list">
            @for (s of stage.toc.samples; track s.value) {
              <div class="sample" (click)="pickSample('toc', s)">
                <span class="sample-label">{{ s.label }}</span>
                <span class="sample-value">{{ s.value }}</span>
              </div>
            }
          </div>
        }
      </div>

      <!-- 正文规则 -->
      <div class="stage-card">
        <div class="stage-header">正文</div>
        <div class="field-row">
          <span class="field-label">章节 URL</span>
          <input nz-input [(ngModel)]="chapterUrl" class="mono grow" placeholder="目录测试命中后自动填充，也可手动输入" />
        </div>
        <div class="field-row">
          <span class="field-label">正文规则</span>
          <input nz-input [(ngModel)]="rules.contentPattern" class="mono grow" />
          <button nz-button nzSize="small" (click)="testContent()" [disabled]="stage.content.running || !chapterUrl.trim()">
            <span nz-icon [nzType]="stage.content.running ? 'loading' : 'play-circle'"></span> 测试正文
          </button>
        </div>
        @if (stage.content.error) { <div class="stage-error">{{ stage.content.error }}</div> }
        @if (stage.content.summary) { <div class="stage-summary">{{ stage.content.summary }}</div> }
        @if (contentPreview) { <pre class="content-preview">{{ contentPreview }}</pre> }
      </div>

      <!-- ④ 代码生成与保存 -->
      <div class="file-row">
        <span class="k">文件名</span>
        <input nz-input [(ngModel)]="fileName" class="file-input" />
        <button nz-button nzSize="small" (click)="regenerate()">
          <span nz-icon nzType="sync"></span> 从规则生成代码
        </button>
        <span class="hint">修改规则后需重新生成才会反映到代码</span>
      </div>

      <textarea
        nz-input
        [(ngModel)]="code"
        class="code-editor"
        spellcheck="false"
      ></textarea>

      <div class="actions">
        <button nz-button (click)="reset()">
          <span nz-icon nzType="reload"></span> 重新分析
        </button>
        <button nz-button nzType="primary" (click)="save(true)" [disabled]="saving() || !fileName.trim()">
          <span nz-icon nzType="save"></span> {{ saving() ? '保存中...' : '保存并调试' }}
        </button>
        <button nz-button (click)="save(false)" [disabled]="saving() || !fileName.trim()">仅保存</button>
      </div>
    }
  `,
  styles: [
    `
      .url-row { display: flex; gap: 8px; margin-bottom: 12px; }
      .grow { flex: 1; min-width: 0; }
      .mb { margin-bottom: 12px; }
      .summary { display: flex; gap: 32px; padding: 10px 12px; border: 1px solid var(--pom-border); border-radius: 4px; background: var(--pom-card); margin-bottom: 14px; }
      .summary-item { display: flex; gap: 8px; align-items: baseline; min-width: 0; }
      .k { color: var(--pom-text-muted); font-size: 12px; white-space: nowrap; }
      .v { color: var(--pom-text); font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .file-row { display: flex; align-items: center; gap: 8px; margin: 14px 0 10px; flex-wrap: wrap; }
      .file-input { width: 240px; font-family: Consolas, monospace; }
      .hint { color: var(--pom-text-muted); font-size: 12px; }
      .code-editor {
        width: 100%; height: 38vh; resize: vertical;
        font-family: 'Cascadia Code', Consolas, monospace; font-size: 12px; line-height: 1.6;
        background: var(--pom-card); color: var(--pom-text);
        border: 1px solid var(--pom-border); border-radius: 4px; padding: 12px;
      }
      .actions { display: flex; gap: 8px; margin-top: 12px; justify-content: flex-end; }
      /* POST 表单参数编辑区样式见 src/styles/rules-panel.scss(全局共享) */
    `,
  ],
})
export class SourceSmartAddComponent {
  readonly analyzing = signal(false);
  readonly saving = signal(false);
  readonly error = signal('');

  targetUrl = '';
  fileName = '';
  code = '';
  /**
   * 规则对象 —— 读写都走 getter/setter，setter 用 Proxy 包裹以自动同步代码：
   * 用户在 UI 改任意字段（如切换 method / 加 body 参数）→ Proxy set trap → regenerate()
   * 否则会出现"配置变了但代码还是老的"，保存出去实际跑的不是用户配置的逻辑
   * （典型 bug：智能添加测 POST 正常但保存后调试书源仍按 GET 跑 → 404）
   *
   * 例外：数组的 push/splice/index-set 不会触发 Proxy 的 rules set trap（mutate 内部不冒泡），
   * 所以 addBodyParam / removeBodyParam / updateBodyParam 显式调 regenerate()。
   */
  private _rules: SourceRules | null = null;
  get rules(): SourceRules | null { return this._rules; }
  set rules(v: SourceRules | null) {
    if (!v) { this._rules = null; return; }
    const self = this;
    this._rules = new Proxy(v, {
      set(target, prop, value) {
        (target as unknown as Record<string | symbol, unknown>)[prop] = value;
        self.regenerate();
        return true;
      },
    });
  }
  chapterLinkCount = 0;

  /** 规则测试状态（各阶段独立） */
  readonly stage: Record<'search' | 'info' | 'toc' | 'content' | 'category', StageState> = {
    search: emptyStage(),
    info: emptyStage(),
    toc: emptyStage(),
    content: emptyStage(),
    category: emptyStage(),
  };
  testKeyword = randomTestKeyword();
  bookUrl = '';
  chapterUrl = '';
  contentPreview = '';
  /** 详情页 HTML 缓存：目录测试复用，避免重复抓取 */
  private bookHtml = '';

  private readonly fetcher = inject(PageFetcherService);
  private readonly toast = inject(ToastService);
  private readonly router = inject(Router);

  /** 抓取首页 → 启发式探测 → 初始化规则 + 生成首版代码 */
  async analyze(): Promise<void> {
    const url = this.targetUrl.trim();
    if (!url) return;
    try {
      new URL(url);
    } catch {
      this.toast.warn('请输入有效的 URL 地址');
      return;
    }
    this.analyzing.set(true);
    this.error.set('');
    try {
      const html = await this.fetcher.fetchHtml(url);
      this.rules = buildRules(url, html);
      this.chapterLinkCount = countChapterLinks(html);
      const host = new URL(url).hostname.replace(/^www\./, '');
      this.fileName = `${host.replace(/\./g, '_')}.js`;
      this.regenerate();
      this.resetStages();
    } catch (e) {
      this.error.set(`抓取或分析失败：${(e as Error).message}`);
      this.rules = null;
    } finally {
      this.analyzing.set(false);
    }
  }

  /** 规则 → 重新生成代码（覆盖 textarea 当前内容） */
  regenerate(): void {
    if (!this.rules) return;
    this.code = generateSourceCode(this.targetUrl.trim(), this.rules);
  }

  reset(): void {
    this.rules = null;
    this.code = '';
    this.error.set('');
    this.resetStages();
  }

  private resetStages(): void {
    for (const k of ['search', 'info', 'toc', 'content', 'category'] as const) this.stage[k] = emptyStage();
    this.bookUrl = '';
    this.chapterUrl = '';
    this.contentPreview = '';
    this.bookHtml = '';
  }

  /** 样本点击回填：搜索样本 → 书籍 URL；目录样本 → 章节 URL */
  pickSample(from: 'search' | 'toc', s: { value: string; clickable: boolean }): void {
    if (!s.clickable) return;
    if (from === 'search') {
      this.bookUrl = s.value;
      this.bookHtml = '';
      this.toast.success('已填充书籍 URL');
    } else {
      this.chapterUrl = s.value;
      this.toast.success('已填充章节 URL');
    }
  }

  // ── POST 表单参数编辑 ────────────────────────────────────────

  /** 添加一条表单参数（POST 模式） */
  addBodyParam(): void {
    if (!this.rules) return;
    if (!this.rules.searchBodyParams) this.rules.searchBodyParams = [];
    this.rules.searchBodyParams.push({ key: '', value: '' });
    // 数组 push 不触发 Proxy rules set trap → 显式重生成
    this.regenerate();
  }

  /** 删除指定下标的表单参数 */
  removeBodyParam(index: number): void {
    if (!this.rules?.searchBodyParams) return;
    this.rules.searchBodyParams.splice(index, 1);
    // 数组 splice 不触发 Proxy rules set trap → 显式重生成
    this.regenerate();
  }

  /** 修改单条表单参数的 key 或 value（模板 ngModelChange 调用） */
  updateBodyParam(index: number, field: 'key' | 'value', value: string): void {
    if (!this.rules?.searchBodyParams?.[index]) return;
    this.rules.searchBodyParams[index][field] = value;
    // 数组元素属性写入不触发 Proxy rules set trap（是 params 自身的修改）→ 显式重生成
    this.regenerate();
  }

  /** 搜索路径 placeholder 随请求方式变化(GET 强调 ?keyword=,POST 强调 /api/...) */
  searchPathPlaceholder(): string {
    const m = this.rules?.searchMethod ?? 'GET';
    if (m === 'GET') return '/search?keyword={keyword}';
    if (m === 'POST') return '/api/search';
    return '/api/search';
  }

  // ── 逐阶段真实命中测试 ─────────────────────────────────────────

  async testSearch(): Promise<void> {
    if (!this.rules) return;
    const st = (this.stage.search = emptyStage());
    st.running = true;
    try {
      const method: SearchMethod = this.rules.searchMethod ?? 'GET';
      const keyword = this.testKeyword.trim();
      // URL 模板替换({keyword} 在 GET 走 encode,POST/POST_RAW 也 encode 保持一致)
      const urlPath = this.rules.searchPath
        .replace('{keyword}', encodeURIComponent(keyword))
        .replace('{page}', '1');
      const url = absUrl(urlPath, this.targetUrl.trim());
      let html: string;
      if (method === 'GET') {
        html = await this.fetcher.fetchHtml(url);
      } else if (method === 'POST') {
        const body = buildFormBody(this.rules.searchBodyParams ?? [], keyword, 1);
        const ct = this.rules.searchContentType ?? 'application/x-www-form-urlencoded';
        html = await this.fetcher.fetchPost(url, body, ct);
      } else {
        // POST_RAW —— body 原文替换,不做 encode
        const body = (this.rules.searchRawBody ?? '')
          .replace('{keyword}', keyword)
          .replace('{page}', '1');
        const ct = this.rules.searchContentType ?? 'application/json';
        html = await this.fetcher.fetchPost(url, body, ct);
      }
      const items = matchLinkItems(this.rules.searchItemPattern, html, url, 100);
      st.summary = items.length > 0 ? `✓ 命中 ${items.length} 条（点击样本填充书籍 URL，列表可滚动）` : '未命中任何结果 —— 请调整列表项规则';
      st.samples = items.map((it: MatchedItem) => ({ label: it.name || '（无书名）', value: it.url, clickable: true }));
      if (items[0]) this.bookUrl = items[0].url;
      this.bookHtml = '';
    } catch (e) {
      st.error = `✗ ${(e as Error).message}`;
    } finally {
      st.running = false;
    }
  }

  async testBookInfo(): Promise<void> {
    if (!this.rules) return;
    const st = (this.stage.info = emptyStage());
    const stCategory = (this.stage.category = emptyStage());
    st.running = true;
    try {
      const url = this.bookUrl.trim();
      const html = await this.fetcher.fetchHtml(url);
      this.bookHtml = html;
      const title = stripTags(pickText(this.rules.bookTitlePattern, html));
      const author = stripTags(pickText(this.rules.bookAuthorPattern, html));
      const category = stripTags(pickText(this.rules.bookCategoryPattern ?? '', html));
      const coverRaw = pickAttr(this.rules.coverUrlPattern ?? 'css:img', html, 'src');
      const cover = coverRaw ? absUrl(coverRaw, url) : '';
      st.summary = title ? '✓ 详情提取成功' : '标题未命中 —— 请调整标题规则';
      st.samples = [
        { label: '标题', value: title || '（未命中）', clickable: false },
        { label: '作者', value: author || '（未命中）', clickable: false },
        { label: '分类', value: category || '（未命中）', clickable: false },
        { label: '封面', value: cover || '（未命中）', clickable: false },
      ];
    } catch (e) {
      st.error = `✗ ${(e as Error).message}`;
    } finally {
      st.running = false;
    }
  }

  async testToc(): Promise<void> {
    if (!this.rules) return;
    const st = (this.stage.toc = emptyStage());
    st.running = true;
    try {
      const url = this.bookUrl.trim();
      // 详情测试已抓过同一页则复用
      if (!this.bookHtml) this.bookHtml = await this.fetcher.fetchHtml(url);
      const chapters = matchLinkItems(this.rules.chapterItemPattern, this.bookHtml, url, 100);
      st.summary = chapters.length > 0 ? `✓ 命中 ${chapters.length} 章（点击样本填充章节 URL，列表可滚动）` : '未命中章节链接 —— 请调整章节链接规则';
      st.samples = chapters.map((c) => ({ label: c.name || '（无章节名）', value: c.url, clickable: true }));
      if (chapters[0]) this.chapterUrl = chapters[0].url;
    } catch (e) {
      st.error = `✗ ${(e as Error).message}`;
    } finally {
      st.running = false;
    }
  }

  /** 正文测试 —— 提取章节正文文本并显示预览 */
  async testContent(): Promise<void> {
    if (!this.rules) return;
    const st = (this.stage.content = emptyStage());
    this.contentPreview = '';
    st.running = true;
    try {
      const html = await this.fetcher.fetchHtml(this.chapterUrl.trim());
      const text = stripTags(pickHtml(this.rules.contentPattern, html));
      st.summary = text ? `✓ 正文提取成功（${text.length} 字符）` : '正文未命中 —— 请调整正文规则';
      this.contentPreview = text ? text.slice(0, 300) : '';
    } catch (e) {
      st.error = `✗ ${(e as Error).message}`;
    } finally {
      st.running = false;
    }
  }

  // ── 保存 ────────────────────────────────────────────────────────

  /** 保存书源；andDebug=true 时跳调试页预选该书源 */
  async save(andDebug: boolean): Promise<void> {
    const api = (window as unknown as { pomAPI?: PomSave }).pomAPI;
    if (!api?.booksourceSave) {
      this.toast.error('booksourceSave IPC 不可用');
      return;
    }
    const fileName = this.fileName.trim();
    if (!/^[a-zA-Z0-9_\-一-龥]+\.js$/.test(fileName)) {
      this.toast.warn('文件名需为 字母/数字/下划线/中划线/中文 + .js 后缀');
      return;
    }
    this.saving.set(true);
    try {
      await api.booksourceSave(fileName, this.code);
      this.toast.success(`书源「${fileName}」保存成功`);
      if (andDebug) {
        void this.router.navigate(['/book-sources/debug'], { queryParams: { source: fileName } });
      }
    } catch (e) {
      this.toast.error(`保存失败：${(e as Error).message}`);
    } finally {
      this.saving.set(false);
    }
  }
}
