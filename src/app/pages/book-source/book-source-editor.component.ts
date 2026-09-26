import { Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzAlertModule } from 'ng-zorro-antd/alert';
import { NzSelectModule } from 'ng-zorro-antd/select';
import { PageHeaderComponent } from '../../shared/components/page-header/page-header.component';
import { ToastService } from '../../core/services/toast.service';
import { parseHeaderMeta } from '../../core/book-source/js-source/header-parser';
import {
  matchLinkItems, pickText, pickHtml, absUrl,
  generateSourceCode, randomTestKeyword,
  SearchMethod, buildFormBody,
} from '../../core/book-source/smart-add/smart-rules';
import { PageFetcherService } from '../../core/book-source/page-fetcher.service';

/** PomAPI 子集（全局 Window.pomAPI 在 page-fetcher.service.ts 声明）。 */
type PomBooksourceEditor = {
  booksourceRead?: (fileName: string, sourceDir?: string) => Promise<string>;
  booksourceSave?: (fileName: string, content: string, sourceDir?: string) => Promise<void>;
};

function pomApi(): PomBooksourceEditor | null {
  if (typeof window === 'undefined') return null;
  return (window.pomAPI as unknown as PomBooksourceEditor | undefined) ?? null;
}

/**
 * 书源编辑器（实施计划 T-005）
 * - 路由 /edit/:fileName 编辑现有书源
 * - 左侧 textarea 编辑；右侧实时解析预览
 * - 保存调 booksourceSave，失败 toast
 */
@Component({
  selector: 'app-book-source-editor',
  standalone: true,
  imports: [CommonModule, FormsModule, NzButtonModule, NzIconModule, NzInputModule, NzAlertModule, NzSelectModule, PageHeaderComponent],
  templateUrl: './book-source-editor.component.html',
  styleUrl: './book-source-editor.component.scss',
})
export class BookSourceEditorComponent {
  fileName = '';
  readonly source = signal('');
  readonly saving = signal(false);

  private readonly fetcher = inject(PageFetcherService);

  // ── 规则编辑面板(智能添加的可视化模式 + 测试 + 应用按钮) ──
  readonly showRules = signal(true);
  readonly ruleSearchPath = signal('');
  readonly ruleSearchMethod = signal<SearchMethod>('GET');
  readonly ruleSearchBodyParams = signal<Array<{ key: string; value: string }>>([]);
  readonly ruleSearchContentType = signal('application/x-www-form-urlencoded');
  readonly ruleSearchRawBody = signal('');
  readonly ruleSearchItem = signal('');
  readonly ruleBookTitle = signal('');
  readonly ruleBookAuthor = signal('');
  readonly ruleChapterItem = signal('');
  readonly ruleContent = signal('');
  readonly ruleBookCategory = signal('');
  readonly ruleKeyword = signal(randomTestKeyword());
  readonly ruleBookUrl = signal('');
  readonly ruleChapterUrl = signal('');
  readonly ruleBaseUrl = signal('');
  readonly applyingRules = signal(false);
  // 测试输出(与智能添加页 stage 结构一致:error + summary + samples)
  readonly testSearchError = signal<string>('');
  readonly testSearchResult = signal<string>('');
  readonly testSearchSamples = signal<Array<{ label: string; value: string }>>([]);
  readonly testInfoError = signal<string>('');
  readonly testInfoResult = signal<string>('');
  readonly testChapterError = signal<string>('');
  readonly testChapterResult = signal<string>('');
  readonly testChapterSamples = signal<Array<{ label: string; value: string }>>([]);
  readonly testCategoryError = signal<string>('');
  readonly testCategoryResult = signal<string>('');
  readonly testCategorySamples = signal<Array<{ label: string; value: string }>>([]);
  readonly testContentError = signal<string>('');
  readonly testContentResult = signal<string>('');
  readonly testContentPreview = signal<string>('');
  readonly testRunning = signal<'search' | 'info' | 'chapter' | 'content' | null>(null);

  /** 实时解析头部：用于右侧预览，编辑时即时反馈 */
  readonly metaPreview = computed(() => {
    const content = this.source();
    if (!content.trim()) return '// 空内容';
    try {
      const meta = parseHeaderMeta(
        content,
        this.fileName || 'new.js',
        '',
        0,
        0,
        null,
      );
      return JSON.stringify(
        {
          name: meta.name,
          url: meta.url,
          urls: meta.urls,
          author: meta.author,
          tags: meta.tags,
          sourceType: meta.sourceType,
          enabled: meta.enabled,
        },
        null,
        2,
      );
    } catch (e) {
      return `解析失败：${(e as Error).message}`;
    }
  });

  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);

  constructor() {
    this.route.params.subscribe((params) => {
      const raw = params['fileName'];
      this.fileName = raw ? decodeURIComponent(String(raw)) : '';
      void this.loadExisting();
    });
  }

  /** 编辑模式：拉取书源 JS 内容 */
  private async loadExisting(): Promise<void> {
    if (!this.fileName) return;
    const api = pomApi();
    if (!api?.booksourceRead) {
      this.toast.error('IPC 不可用');
      return;
    }
    try {
      const content = await api.booksourceRead(this.fileName);
      this.source.set(content ?? '');
      this.parseRulesFromSource(content ?? '');
    } catch (e) {
      this.toast.error(`读取失败：${(e as Error).message}`);
    }
  }

  /** 从源码中解析 10 个规则常量 + BASE_URL 到 signals(支持点击规则面板时反填) */
  private parseRulesFromSource(content: string): void {
    const extract = (name: string): string => {
      const m = new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*(.+?)\\s*$`, 'm').exec(content);
      if (!m) return '';
      let raw = m[1].trim();
      // 去掉尾部分号 / 末尾空格
      raw = raw.replace(/;$/, '').trim();
      // 字符串字面量(双/单引号/反引号)
      if ((raw.startsWith('"') && raw.endsWith('"')) ||
          (raw.startsWith("'") && raw.endsWith("'")) ||
          (raw.startsWith('`') && raw.endsWith('`'))) {
        try { return JSON.parse(raw); } catch { /* backtick: 取内 */ }
        if (raw.startsWith('`')) return raw.slice(1, -1);
      }
      return raw;
    };
    /** 提取并求值 JS 数组字面量（如 SEARCH_BODY_PARAMS = [["q","{keyword}"]]）—— 仅解析受限语法 */
    const extractArray = (name: string): Array<{ key: string; value: string }> => {
      const raw = extract(name);
      if (!raw || !raw.startsWith('[')) return [];
      try {
        // 只接受 [string,string] 二元组 —— 防御非预期副作用
        const arr = new Function(`return (${raw});`)() as unknown;
        if (!Array.isArray(arr)) return [];
        const out: Array<{ key: string; value: string }> = [];
        for (const it of arr) {
          if (Array.isArray(it) && it.length >= 2 &&
              typeof it[0] === 'string' && typeof it[1] === 'string') {
            out.push({ key: it[0], value: it[1] });
          }
        }
        return out;
      } catch {
        return [];
      }
    };
    this.ruleSearchPath.set(extract('SEARCH_PATH'));
    // 请求方式：缺省 GET(空字符串或 'GET' 都视为 GET)
    const methodRaw = extract('SEARCH_METHOD').replace(/^["']|["']$/g, '');
    this.ruleSearchMethod.set((['GET', 'POST', 'POST_RAW'] as SearchMethod[]).includes(methodRaw as SearchMethod)
      ? (methodRaw as SearchMethod) : 'GET');
    this.ruleSearchBodyParams.set(extractArray('SEARCH_BODY_PARAMS'));
    this.ruleSearchContentType.set(extract('SEARCH_CONTENT_TYPE') || 'application/x-www-form-urlencoded');
    this.ruleSearchRawBody.set(extract('SEARCH_RAW_BODY'));
    this.ruleSearchItem.set(extract('SEARCH_ITEM_RULE'));
    this.ruleBookTitle.set(extract('BOOK_TITLE_RULE'));
    this.ruleBookAuthor.set(extract('BOOK_AUTHOR_RULE'));
    this.ruleChapterItem.set(extract('CHAPTER_ITEM_RULE'));
    this.ruleContent.set(extract('CONTENT_RULE'));
    this.ruleBookCategory.set(extract('BOOK_CATEGORY_RULE'));
    this.ruleBaseUrl.set(extract('BASE_URL'));
  }

  /** 应用规则到源码 —— 仅替换 10 个规则常量(保留 explore 等用户自定义代码) */
  applyRulesToSource(): void {
    const content = this.source();
    const updates = this.buildRuleReplacements();
    const updated = this.replaceRulesInSource(content, updates);
    this.source.set(updated);
    this.toast.success(`✓ 规则已应用(已替换 ${Object.keys(updates).length} 个常量)`);
  }

  /** 构造 const 名 → 序列化值的映射(SEARCH_BODY_PARAMS 输出 JS 数组字面量,其他走 JSON.stringify) */
  private buildRuleReplacements(): Record<string, string | { literal: string }> {
    return {
      SEARCH_PATH: this.ruleSearchPath(),
      SEARCH_METHOD: this.ruleSearchMethod(),
      SEARCH_BODY_PARAMS: { literal: JSON.stringify(this.ruleSearchBodyParams()) },
      SEARCH_CONTENT_TYPE: this.ruleSearchContentType(),
      SEARCH_RAW_BODY: this.ruleSearchRawBody(),
      SEARCH_ITEM_RULE: this.ruleSearchItem(),
      BOOK_TITLE_RULE: this.ruleBookTitle(),
      BOOK_AUTHOR_RULE: this.ruleBookAuthor(),
      CHAPTER_ITEM_RULE: this.ruleChapterItem(),
      CONTENT_RULE: this.ruleContent(),
      BOOK_CATEGORY_RULE: this.ruleBookCategory(),
    };
  }

  /** 从规则生成完整代码 —— 用 generateSourceCode 覆盖整个源码
   *  (与"应用规则到源码"的区别:本方法替换整个 source,包括 explore 函数 —— 用户自定义代码会丢失)
   */
  generateCodeFromRules(): void {
    if (!this.ruleBaseUrl().trim()) {
      this.toast.warn('请先填写 BASE_URL');
      return;
    }
    try {
      const rules = {
        siteName: '',
        searchPath: this.ruleSearchPath() || '/search?keyword={keyword}',
        searchMethod: this.ruleSearchMethod(),
        searchBodyParams: this.ruleSearchBodyParams(),
        searchContentType: this.ruleSearchContentType(),
        searchRawBody: this.ruleSearchRawBody(),
        searchItemPattern: this.ruleSearchItem(),
        bookTitlePattern: this.ruleBookTitle(),
        bookAuthorPattern: this.ruleBookAuthor(),
        chapterItemPattern: this.ruleChapterItem(),
        contentPattern: this.ruleContent(),
        bookCategoryPattern: this.ruleBookCategory(),
      };
      const baseUrl = this.ruleBaseUrl().trim();
      const code = generateSourceCode(baseUrl, rules);
      this.source.set(code);
      this.toast.success('✓ 已从规则生成完整代码(覆盖了整个源码)');
    } catch (e) {
      this.toast.error(`生成失败：${(e as Error).message}`);
    }
  }

  /** 编辑器：添加 / 删除 POST 表单参数 */
  addEditorBodyParam(): void {
    this.ruleSearchBodyParams.update((arr) => [...arr, { key: '', value: '' }]);
  }
  removeEditorBodyParam(index: number): void {
    this.ruleSearchBodyParams.update((arr) => arr.filter((_, i) => i !== index));
  }

  /** 把规则值替换到源码对应 const 行(只替换 const/let/var <NAME> = ... 这一行)
   *  - 默认 value 走 JSON.stringify 当字符串字面量
   *  - { literal: '...' } 直接写出 JS 字面量（用于 SEARCH_BODY_PARAMS 这类数组字面量） */
  private replaceRulesInSource(
    content: string,
    rules: Record<string, string | { literal: string }>,
  ): string {
    let out = content;
    for (const [name, v] of Object.entries(rules)) {
      const rendered = typeof v === 'string' ? JSON.stringify(v) : v.literal;
      const re = new RegExp(`^(\\s*(?:const|let|var)\\s+${name}\\s*=\\s*)(.+?)(\\s*;?\\s*)$`, 'm');
      out = out.replace(re, (_m, head, _old, tail) => `${head}${rendered}${tail}`);
    }
    return out;
  }

  // ── 4 个测试(与智能添加页同语义) ──
  async runTestSearch(): Promise<void> {
    this.testRunning.set('search');
    this.testSearchError.set('');
    this.testSearchResult.set('');
    this.testSearchSamples.set([]);
    try {
      const method: SearchMethod = this.ruleSearchMethod();
      const keyword = this.ruleKeyword().trim();
      const urlPath = this.ruleSearchPath()
        .replace('{keyword}', encodeURIComponent(keyword))
        .replace('{page}', '1');
      const url = absUrl(urlPath, this.ruleBaseUrl().trim());
      let html: string;
      if (method === 'GET') {
        html = await this.fetcher.fetchHtml(url);
      } else if (method === 'POST') {
        const body = buildFormBody(this.ruleSearchBodyParams(), keyword, 1);
        const ct = this.ruleSearchContentType() || 'application/x-www-form-urlencoded';
        html = await this.fetcher.fetchPost(url, body, ct);
      } else {
        // POST_RAW —— body 原文替换
        const body = this.ruleSearchRawBody()
          .replace('{keyword}', keyword)
          .replace('{page}', '1');
        const ct = this.ruleSearchContentType() || 'application/json';
        html = await this.fetcher.fetchPost(url, body, ct);
      }
      const items = matchLinkItems(this.ruleSearchItem(), html, url, 100);
      this.testSearchResult.set(items.length > 0 ? `✓ 命中 ${items.length} 条（点击样本填充书籍 URL，列表可滚动）` : '未命中任何结果 —— 请调整列表项规则');
      this.testSearchSamples.set(items.map((it) => ({ label: it.name || '（无书名）', value: it.url })));
      if (items[0]) this.ruleBookUrl.set(items[0].url);
    } catch (e) {
      this.testSearchError.set(`✗ ${(e as Error).message}`);
    } finally {
      this.testRunning.set(null);
    }
  }
  async runTestInfo(): Promise<void> {
    this.testRunning.set('info');
    this.testInfoError.set('');
    this.testInfoResult.set('');
    this.testCategoryError.set('');
    this.testCategoryResult.set('');
    this.testCategorySamples.set([]);
    try {
      const url = this.ruleBookUrl().trim();
      const html = await this.fetcher.fetchHtml(url);
      const title = pickText(this.ruleBookTitle(), html);
      const author = pickText(this.ruleBookAuthor(), html);
        const category = pickText(this.ruleBookCategory(), html);
      this.testInfoResult.set(`✓ 标题=${title || '(空)'}  作者=${author || '(空)'}  分类=${category || '(空)'}`);
    } catch (e) {
      this.testInfoError.set(`✗ ${(e as Error).message}`);
    } finally {
      this.testRunning.set(null);
    }
  }
  async runTestChapter(): Promise<void> {
    this.testRunning.set('chapter');
    this.testChapterError.set('');
    this.testChapterResult.set('');
    this.testChapterSamples.set([]);
    try {
      const url = this.ruleBookUrl().trim();
      const html = await this.fetcher.fetchHtml(url);
      const items = matchLinkItems(this.ruleChapterItem(), html, url, 100);
      this.testChapterResult.set(items.length > 0 ? `✓ 命中 ${items.length} 章（点击样本填充章节 URL，列表可滚动）` : '未命中任何章节 —— 请调整章节链接规则');
      this.testChapterSamples.set(items.map((it) => ({ label: it.name || '（无章节名）', value: it.url })));
    } catch (e) {
      this.testChapterError.set(`✗ ${(e as Error).message}`);
    } finally {
      this.testRunning.set(null);
    }
  }
  async runTestContent(): Promise<void> {
    this.testRunning.set('content');
    this.testContentError.set('');
    this.testContentResult.set('');
    this.testContentPreview.set('');
    try {
      const url = this.ruleChapterUrl().trim();
      const html = await this.fetcher.fetchHtml(url);
      var inner = pickHtml(this.ruleContent(), html);
      if (inner) {
        this.testContentResult.set(`✓ 命中 ${inner.length} 字节`);
        // 展示内容用的是<pre>，所以这里需要把一些html tag替换为换行符
        var search = ["<br[^>]*>", "<p[^>]*>", "<div[^>]*>"];
        for (const pattern of search) {
          inner = inner.replace(new RegExp(pattern, 'gi'), '\n');
        }
        // 截断预览到 2000 字符避免长文刷屏,strip 标签后展示纯文本
        const plain = inner
          .replace(/<[^>]+>/g, ' ')
          .replace(/\r\n?/g, '\n')
          .replace(/[^\S\n]+/g, ' ')
          .replace(/ *\n */g, '\n')
          .replace(/\n{2,}/g, '\n')
          .trim();
        this.testContentPreview.set(plain.slice(0, 2000) + (plain.length > 2000 ? '…' : ''));
      } else {
        this.testContentResult.set('未命中 —— 请调整正文规则');
      }
    } catch (e) {
      this.testContentError.set(`✗ ${(e as Error).message}`);
    } finally {
      this.testRunning.set(null);
    }
  }

  /** 保存（保留原 fileName） */
  async save(): Promise<void> {
    const content = this.source();
    if (!content.trim()) {
      this.toast.warn('内容为空，无法保存');
      return;
    }
    const api = pomApi();
    if (!api?.booksourceSave) {
      this.toast.error('IPC 不可用');
      return;
    }
    this.saving.set(true);
    try {
      await api.booksourceSave(this.fileName, content);
      this.toast.success(`保存成功：${this.fileName}`);
      void this.router.navigateByUrl('/book-sources');
    } catch (e) {
      this.toast.error(`保存失败：${(e as Error).message}`);
    } finally {
      this.saving.set(false);
    }
  }

  cancel(): void {
    void this.router.navigateByUrl('/book-sources');
  }
}
