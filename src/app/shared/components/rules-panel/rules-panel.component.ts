import { Component, computed, inject, input, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzAlertModule } from 'ng-zorro-antd/alert';
import { NzSelectModule } from 'ng-zorro-antd/select';
import { PageFetcherService } from '../../../core/book-source/page-fetcher.service';
import {
  SearchMethod,
  SourceRules,
  buildFormBody,
  absUrl,
  matchLinkItems,
  pickAttr,
  pickHtml,
  pickText,
  randomTestKeyword,
  stripTags,
} from '../../../core/book-source/smart-add/smart-rules';

interface StageSample {
  label: string;
  value: string;
  clickable: boolean;
}

interface StageState {
  running: boolean;
  error: string;
  summary: string;
  samples: StageSample[];
}

function emptyStage(): StageState {
  return { running: false, error: '', summary: '', samples: [] };
}

/**
 * 规则编辑 + 4 阶段真实命中测试 共享面板
 *
 * 智能添加页 与 书源编辑页 都嵌入同一组件,UI/标签/测试语义保持一致;
 * 父组件通过 input(baseUrl) 决定测试时的 URL 解析基址,通过 setRules/getRules 与 panel 同步规则状态。
 *
 * 测试仅验证规则(直接抓 HTML + CSS/正则提取),不执行书源 JS —— 该限制由调用方
 * 在「调试书源」/「书源搜索」链路中覆盖。
 */
@Component({
  selector: 'app-rules-panel',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    NzButtonModule,
    NzIconModule,
    NzInputModule,
    NzAlertModule,
    NzSelectModule,
  ],
  template: `
    @if (showTestBehaviorHint()) {
      <nz-alert
        nzType="info"
        nzShowIcon
        nzMessage="本页 4 个「测试*」按钮均直接抓 HTML 用 CSS 选择器提取内容,仅验证 12 条规则的正确性"
        nzDescription="不执行书源 JS 脚本里的 function search / bookInfo / chapterList / chapterContent 等函数。要测试 JS 代码(沙箱执行)→ 进入「调试书源」页;要验证完整链路 → 在「书源搜索」点导入,进入阅读。"
        style="margin-bottom: 12px;"
      ></nz-alert>
    }

    <div class="panel-grid panel-grid--2">
    <!-- 搜索规则 -->
    <div class="stage-card">
      <div class="stage-header">搜索</div>
      <div class="field-row">
        <span class="field-label">搜索路径</span>
        <input nz-input [ngModel]="searchPath()" (ngModelChange)="searchPath.set($event)" class="mono grow" [placeholder]="searchPathPlaceholder()" />
      </div>
      <div class="field-row">
        <span class="field-label">请求方式</span>
        <nz-select [ngModel]="searchMethod()" (ngModelChange)="searchMethod.set($event)" class="grow">
          <nz-option nzValue="GET" nzLabel="GET — URL 参数"></nz-option>
          <nz-option nzValue="POST" nzLabel="POST — 表单 (form-urlencoded)"></nz-option>
          <nz-option nzValue="POST_RAW" nzLabel="POST — 原始 body (JSON / XML)"></nz-option>
        </nz-select>
      </div>

      <!-- POST 表单参数可视化编辑 -->
      @if (searchMethod() === 'POST') {
        <div class="field-row" style="margin-top: 8px;">
          <span class="field-label">Content-Type</span>
          <input nz-input [ngModel]="searchContentType()" (ngModelChange)="searchContentType.set($event)" class="mono grow" placeholder="application/x-www-form-urlencoded" />
        </div>
        <div class="body-params">
          <div class="body-params-header">
            <span class="body-params-title">表单参数</span>
            <span class="body-params-hint">value 支持 &#123;keyword&#125; / &#123;page&#125; 占位符,运行时自动 encode</span>
            <button nz-button nzSize="small" nzType="dashed" (click)="addBodyParam()">
              <span nz-icon nzType="plus"></span> 添加参数
            </button>
          </div>
          @for (p of searchBodyParams(); track $index; let i = $index) {
            <div class="body-param-row">
              <input nz-input [ngModel]="p.key" (ngModelChange)="updateBodyParam(i, 'key', $event)" placeholder="key" class="mono param-key" />
              <span class="param-eq">=</span>
              <input nz-input [ngModel]="p.value" (ngModelChange)="updateBodyParam(i, 'value', $event)" placeholder="value (支持 {keyword} / {page})" class="mono param-value" />
              <button nz-button nzSize="small" nzType="text" nzDanger (click)="removeBodyParam(i)" title="删除">
                <span nz-icon nzType="delete"></span>
              </button>
            </div>
          }
          @if (!searchBodyParams().length) {
            <div class="body-params-empty">暂无参数 —— 点击「添加参数」开始配置</div>
          }
        </div>
      }

      <!-- POST 原始 body 文本框 -->
      @if (searchMethod() === 'POST_RAW') {
        <div class="field-row" style="margin-top: 8px;">
          <span class="field-label">Content-Type</span>
          <input nz-input [ngModel]="searchContentType()" (ngModelChange)="searchContentType.set($event)" class="mono grow" placeholder="application/json" />
        </div>
        <div class="field-row" style="margin-top: 8px; align-items: flex-start;">
          <span class="field-label">原始 Body</span>
          <textarea
            nz-input
            [ngModel]="searchRawBody()"
            (ngModelChange)="searchRawBody.set($event)"
            class="mono grow raw-body"
            rows="3"
            placeholder='{"keyword":"{keyword}","page":{page}}'
          ></textarea>
        </div>
      }

      <div class="field-row">
        <span class="field-label">列表项规则</span>
        <input nz-input [ngModel]="searchItem()" (ngModelChange)="searchItem.set($event)" class="mono grow" />
      </div>
      <div class="field-row">
        <span class="field-label">测试关键词</span>
        <input nz-input [ngModel]="keyword()" (ngModelChange)="keyword.set($event)" class="keyword-input" />
        <button nz-button nzSize="small" (click)="runTestSearch()" [disabled]="runningTest() !== null">
          <span nz-icon [nzType]="runningTest() === 'search' ? 'loading' : 'play-circle'"></span> 测试搜索
        </button>
      </div>
      @if (searchStage().error) { <div class="stage-error">{{ searchStage().error }}</div> }
      @if (searchStage().summary) { <div class="stage-summary">{{ searchStage().summary }}</div> }
      @if (searchStage().samples.length) {
        <div class="sample-list">
          @for (s of searchStage().samples; track s.value) {
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
        <input nz-input [ngModel]="bookUrl()" (ngModelChange)="bookUrl.set($event)" class="mono grow" placeholder="搜索测试命中后自动填充,也可手动输入" />
      </div>
      <div class="field-row">
        <span class="field-label">标题规则</span>
        <input nz-input [ngModel]="bookTitle()" (ngModelChange)="bookTitle.set($event)" class="mono grow" />
      </div>
      <div class="field-row">
        <span class="field-label">封面规则</span>
        <input nz-input [ngModel]="bookCover()" (ngModelChange)="bookCover.set($event)" class="mono grow" placeholder='css:.book-img img  或正则如 <img[^>]+src="([^"]+)"' />
      </div>
      <div class="field-row">
        <span class="field-label">作者规则</span>
        <input nz-input [ngModel]="bookAuthor()" (ngModelChange)="bookAuthor.set($event)" class="mono grow" />
      </div>

      <div class="field-row" style="margin-top: 12px;">
        <span class="field-label">分类规则</span>
        <input nz-input [ngModel]="bookCategory()" (ngModelChange)="bookCategory.set($event)" class="mono grow" placeholder='分类[：:]\s*&lt;[^&gt;]+&gt;\s*([^&lt;]{1,20})' />
        <button nz-button nzSize="small" (click)="runTestInfo()" [disabled]="runningTest() !== null || !bookUrl().trim()">
          <span nz-icon [nzType]="runningTest() === 'info' ? 'loading' : 'play-circle'"></span> 测试详情
        </button>
      </div>
      @if (infoStage().error) { <div class="stage-error">{{ infoStage().error }}</div> }
      @if (infoStage().summary) { <div class="stage-summary">{{ infoStage().summary }}</div> }
      @for (s of infoStage().samples; track $index) {
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
        <input nz-input [ngModel]="chapterItem()" (ngModelChange)="chapterItem.set($event)" class="mono grow" />
        <button nz-button nzSize="small" (click)="runTestChapter()" [disabled]="runningTest() !== null || !bookUrl().trim()">
          <span nz-icon [nzType]="runningTest() === 'chapter' ? 'loading' : 'play-circle'"></span> 测试目录
        </button>
      </div>
      @if (chapterStage().error) { <div class="stage-error">{{ chapterStage().error }}</div> }
      @if (chapterStage().summary) { <div class="stage-summary">{{ chapterStage().summary }}</div> }
      @if (chapterStage().samples.length) {
        <div class="sample-list">
          @for (s of chapterStage().samples; track s.value) {
            <div class="sample" (click)="pickSample('chapter', s)">
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
        <input nz-input [ngModel]="chapterUrl()" (ngModelChange)="chapterUrl.set($event)" class="mono grow" placeholder="目录测试命中后自动填充,也可手动输入" />
      </div>
      <div class="field-row">
        <span class="field-label">正文规则</span>
        <input nz-input [ngModel]="content()" (ngModelChange)="content.set($event)" class="mono grow" />
        <button nz-button nzSize="small" (click)="runTestContent()" [disabled]="runningTest() !== null || !chapterUrl().trim()">
          <span nz-icon [nzType]="runningTest() === 'content' ? 'loading' : 'play-circle'"></span> 测试正文
        </button>
      </div>
      @if (contentStage().error) { <div class="stage-error">{{ contentStage().error }}</div> }
      @if (contentStage().summary) { <div class="stage-summary">{{ contentStage().summary }}</div> }
      @if (contentPreview()) { <pre class="content-preview">{{ contentPreview() }}</pre> }
    </div>
    </div>
  `,
  styles: [
    `
      /* 内部双列网格 —— 搜索/详情/目录/正文 各占一格,跟编辑书源页保持一致布局 */
      .panel-grid {
        display: grid;
        grid-template-columns: 1fr;
        gap: 10px;
      }
      .panel-grid--2 {
        grid-template-columns: 1fr 1fr;
      }
      /* POST 表单参数编辑区样式见 src/styles/rules-panel.scss(全局共享) */
    `,
  ],
})
export class RulesPanelComponent {
  /** 测试 URL 解析基址 —— 父组件提供,智能添加传 targetUrl,书源编辑传 BASE_URL */
  readonly baseUrl = input<string>('');
  /** 是否显示「测试仅验证规则」行为提示(仅书源编辑页需要) */
  readonly showTestBehaviorHint = input<boolean>(false);

  // ── 12 个规则字段(均为 signal) ──
  readonly searchPath = signal('');
  readonly searchMethod = signal<SearchMethod>('GET');
  readonly searchBodyParams = signal<Array<{ key: string; value: string }>>([]);
  readonly searchContentType = signal('application/x-www-form-urlencoded');
  readonly searchRawBody = signal('');
  readonly searchItem = signal('');
  readonly bookTitle = signal('');
  readonly bookCover = signal('');
  readonly bookAuthor = signal('');
  readonly chapterItem = signal('');
  readonly content = signal('');
  readonly bookCategory = signal('');

  // ── 关联状态(测试串联用) ──
  readonly keyword = signal(randomTestKeyword());
  readonly bookUrl = signal('');
  readonly chapterUrl = signal('');
  readonly contentPreview = signal('');

  // ── 测试结果状态(4 个 stage) ──
  readonly searchStage = signal<StageState>(emptyStage());
  readonly infoStage = signal<StageState>(emptyStage());
  readonly chapterStage = signal<StageState>(emptyStage());
  readonly contentStage = signal<StageState>(emptyStage());
  readonly runningTest = signal<'search' | 'info' | 'chapter' | 'content' | null>(null);

  /** 详情页 HTML 缓存:目录测试复用,避免重复抓取 */
  private bookHtml = '';

  /** 打包 12 个规则字段,父组件可用 effect 监听变化 */
  readonly rules = computed<SourceRules>(() => ({
    siteName: '',
    searchPath: this.searchPath(),
    searchMethod: this.searchMethod(),
    searchBodyParams: this.searchBodyParams(),
    searchContentType: this.searchContentType(),
    searchRawBody: this.searchRawBody(),
    searchItemPattern: this.searchItem(),
    bookTitlePattern: this.bookTitle(),
    coverUrlPattern: this.bookCover(),
    bookAuthorPattern: this.bookAuthor(),
    chapterItemPattern: this.chapterItem(),
    contentPattern: this.content(),
    bookCategoryPattern: this.bookCategory(),
  }));

  private readonly fetcher = inject(PageFetcherService);

  // ── Public API ──

  /** 父组件从已存在的源/探测结果加载规则;缺失字段保留 panel 当前值 */
  setRules(rules: Partial<SourceRules>): void {
    if (rules.searchPath !== undefined) this.searchPath.set(rules.searchPath);
    if (rules.searchMethod !== undefined) this.searchMethod.set(rules.searchMethod);
    if (rules.searchBodyParams !== undefined) this.searchBodyParams.set(rules.searchBodyParams);
    if (rules.searchContentType !== undefined) this.searchContentType.set(rules.searchContentType);
    if (rules.searchRawBody !== undefined) this.searchRawBody.set(rules.searchRawBody);
    if (rules.searchItemPattern !== undefined) this.searchItem.set(rules.searchItemPattern);
    if (rules.bookTitlePattern !== undefined) this.bookTitle.set(rules.bookTitlePattern);
    if (rules.coverUrlPattern !== undefined) this.bookCover.set(rules.coverUrlPattern);
    if (rules.bookAuthorPattern !== undefined) this.bookAuthor.set(rules.bookAuthorPattern);
    if (rules.chapterItemPattern !== undefined) this.chapterItem.set(rules.chapterItemPattern);
    if (rules.contentPattern !== undefined) this.content.set(rules.contentPattern);
    if (rules.bookCategoryPattern !== undefined) this.bookCategory.set(rules.bookCategoryPattern);
  }

  /** 父组件读取当前规则(用于保存/生成代码) */
  getRules(): SourceRules {
    return this.rules();
  }

  /** 清空所有状态 —— analyze 重新开始或父组件 unmount 场景 */
  reset(): void {
    this.searchPath.set('');
    this.searchMethod.set('GET');
    this.searchBodyParams.set([]);
    this.searchContentType.set('application/x-www-form-urlencoded');
    this.searchRawBody.set('');
    this.searchItem.set('');
    this.bookTitle.set('');
    this.bookCover.set('');
    this.bookAuthor.set('');
    this.chapterItem.set('');
    this.content.set('');
    this.bookCategory.set('');
    this.keyword.set(randomTestKeyword());
    this.bookUrl.set('');
    this.chapterUrl.set('');
    this.contentPreview.set('');
    this.searchStage.set(emptyStage());
    this.infoStage.set(emptyStage());
    this.chapterStage.set(emptyStage());
    this.contentStage.set(emptyStage());
    this.runningTest.set(null);
    this.bookHtml = '';
  }

  /** POST 表单参数 —— 添加一行(key/value 空串) */
  addBodyParam(): void {
    this.searchBodyParams.update((arr) => [...arr, { key: '', value: '' }]);
  }

  /** POST 表单参数 —— 删除指定下标 */
  removeBodyParam(index: number): void {
    this.searchBodyParams.update((arr) => arr.filter((_, i) => i !== index));
  }

  /** POST 表单参数 —— 修改指定行的 key 或 value */
  updateBodyParam(index: number, field: 'key' | 'value', value: string): void {
    this.searchBodyParams.update((arr) =>
      arr.map((p, i) => (i === index ? { ...p, [field]: value } : p)),
    );
  }

  /** 搜索路径 placeholder 随请求方式变化(GET 强调 ?keyword=,POST 强调 /api/...) */
  searchPathPlaceholder(): string {
    const m = this.searchMethod();
    if (m === 'GET') return '/search?keyword={keyword}';
    return '/api/search';
  }

  // ── 4 个测试方法 ──

  async runTestSearch(): Promise<void> {
    this.runningTest.set('search');
    this.searchStage.set(emptyStage());
    try {
      const method = this.searchMethod();
      const keyword = this.keyword().trim();
      const urlPath = this.searchPath()
        .replace('{keyword}', encodeURIComponent(keyword))
        .replace('{page}', '1');
      const baseUrl = this.baseUrl().trim();
      const url = absUrl(urlPath, baseUrl);
      let html: string;
      if (method === 'GET') {
        html = await this.fetcher.fetchHtml(url);
      } else if (method === 'POST') {
        const body = buildFormBody(this.searchBodyParams(), keyword, 1);
        const ct = this.searchContentType() || 'application/x-www-form-urlencoded';
        html = await this.fetcher.fetchPost(url, body, ct);
      } else {
        const body = (this.searchRawBody() || '')
          .replace('{keyword}', keyword)
          .replace('{page}', '1');
        const ct = this.searchContentType() || 'application/json';
        html = await this.fetcher.fetchPost(url, body, ct);
      }
      const items = matchLinkItems(this.searchItem(), html, url, 100);
      this.searchStage.set({
        running: false,
        error: '',
        summary:
          items.length > 0
            ? `✓ 命中 ${items.length} 条(点击样本填充书籍 URL,列表可滚动)`
            : '未命中任何结果 —— 请调整列表项规则',
        samples: items.map((it) => ({
          label: it.name || '（无书名）',
          value: it.url,
          clickable: true,
        })),
      });
      if (items[0]) this.bookUrl.set(items[0].url);
      this.bookHtml = '';
    } catch (e) {
      this.searchStage.update((s) => ({ ...s, error: `✗ ${(e as Error).message}` }));
    } finally {
      this.runningTest.set(null);
    }
  }

  async runTestInfo(): Promise<void> {
    this.runningTest.set('info');
    this.infoStage.set(emptyStage());
    try {
      const url = this.bookUrl().trim();
      const html = await this.fetcher.fetchHtml(url);
      this.bookHtml = html;
      const title = stripTags(pickText(this.bookTitle(), html));
      const author = stripTags(pickText(this.bookAuthor(), html));
      const category = stripTags(pickText(this.bookCategory() || '', html));
      const coverRaw = pickAttr(this.bookCover() || 'css:img', html, 'src');
      const cover = coverRaw ? absUrl(coverRaw, url) : '';
      this.infoStage.set({
        running: false,
        error: '',
        summary: title ? '✓ 详情提取成功' : '标题未命中 —— 请调整标题规则',
        samples: [
          { label: '标题', value: title || '（未命中）', clickable: false },
          { label: '作者', value: author || '（未命中）', clickable: false },
          { label: '分类', value: category || '（未命中）', clickable: false },
          { label: '封面', value: cover || '（未命中）', clickable: false },
        ],
      });
    } catch (e) {
      this.infoStage.update((s) => ({ ...s, error: `✗ ${(e as Error).message}` }));
    } finally {
      this.runningTest.set(null);
    }
  }

  async runTestChapter(): Promise<void> {
    this.runningTest.set('chapter');
    this.chapterStage.set(emptyStage());
    try {
      const url = this.bookUrl().trim();
      // 详情测试已抓过同一页则复用,避免重复请求
      const html = this.bookHtml || (await this.fetcher.fetchHtml(url));
      this.bookHtml = html;
      const chapters = matchLinkItems(this.chapterItem(), html, url, 100);
      this.chapterStage.set({
        running: false,
        error: '',
        summary:
          chapters.length > 0
            ? `✓ 命中 ${chapters.length} 章(点击样本填充章节 URL,列表可滚动)`
            : '未命中章节链接 —— 请调整章节链接规则',
        samples: chapters.map((c) => ({
          label: c.name || '（无章节名）',
          value: c.url,
          clickable: true,
        })),
      });
      if (chapters[0]) this.chapterUrl.set(chapters[0].url);
    } catch (e) {
      this.chapterStage.update((s) => ({ ...s, error: `✗ ${(e as Error).message}` }));
    } finally {
      this.runningTest.set(null);
    }
  }

  async runTestContent(): Promise<void> {
    this.runningTest.set('content');
    this.contentStage.set(emptyStage());
    this.contentPreview.set('');
    try {
      const url = this.chapterUrl().trim();
      const html = await this.fetcher.fetchHtml(url);
      const rawHtml = pickHtml(this.content(), html);
      if (rawHtml) {
        // 展示内容用的是<pre>,把常见块级 tag 替换为换行符再 strip
        const withBreaks = rawHtml
          .replace(/<br\s*\/?>/gi, '\n')
          .replace(/<p[^>]*>/gi, '\n')
          .replace(/<div[^>]*>/gi, '\n');
        const plain = withBreaks
          .replace(/<[^>]+>/g, ' ')
          .replace(/\r\n?/g, '\n')
          .replace(/[^\S\n]+/g, ' ')
          .replace(/ *\n */g, '\n')
          .replace(/\n{2,}/g, '\n')
          .trim();
        this.contentPreview.set(plain.slice(0, 2000) + (plain.length > 2000 ? '…' : ''));
        this.contentStage.set({
          running: false,
          error: '',
          summary: `✓ 命中 ${rawHtml.length} 字节`,
          samples: [],
        });
      } else {
        this.contentStage.set({
          running: false,
          error: '',
          summary: '未命中 —— 请调整正文规则',
          samples: [],
        });
      }
    } catch (e) {
      this.contentStage.update((s) => ({ ...s, error: `✗ ${(e as Error).message}` }));
    } finally {
      this.runningTest.set(null);
    }
  }

  // ── 样本点击回填 ──

  /** 样本点击 → 搜索样本填 bookUrl,目录样本填 chapterUrl */
  pickSample(from: 'search' | 'chapter', s: StageSample): void {
    if (!s.clickable) return;
    if (from === 'search') {
      this.bookUrl.set(s.value);
      this.bookHtml = '';
    } else {
      this.chapterUrl.set(s.value);
    }
  }
}
