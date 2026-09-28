import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';

import { FormsModule } from '@angular/forms';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzAlertModule } from 'ng-zorro-antd/alert';
import { NzSelectModule } from 'ng-zorro-antd/select';
import { PageFetcherService } from '../../../core/book-source/page-fetcher.service';
import {
  type MatchedSearchItem,
  type SearchMethod,
  type SourceRules,
  applyContentReplaceRules,
  buildFormBody,
  absUrl,
  matchLinkItems,
  matchSearchItems,
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
 * 搜索测试摘要：条目数 + 作者/分类增强字段的命中条数。
 * 规则填了却一条没命中时给出作用域提示 —— 增强规则作用于**条目内部**，
 * 条目规则若只选中书名 `<a>`（`dl.list dd a`）就取不到作者/分类，需选到整块容器（`dl.list dd`）。
 */
function buildSearchSummary(
  total: number,
  authorHits: number,
  categoryHits: number,
  authorRule: string,
  categoryRule: string,
): string {
  if (total <= 0) return '未命中任何结果 —— 请调整列表项规则';
  const parts = [`✓ 命中 ${total} 条(点击样本填充书籍 URL,列表可滚动)`];
  if (authorHits) parts.push(`作者 ${authorHits} 条`);
  if (categoryHits) parts.push(`分类 ${categoryHits} 条`);
  const miss: string[] = [];
  if (authorRule.trim() && !authorHits) miss.push('作者');
  if (categoryRule.trim() && !categoryHits) miss.push('分类');
  const hint = miss.length
    ? ` —— ${miss.join('/')}规则未命中：作用域是**条目内部**，列表项规则要选到含该信息的整块容器(如 dl.list dd)，而非单个书名链接(dl.list dd a)`
    : '';
  return parts.join(' · ') + hint;
}

/** 搜索样本标签：书名 + 已命中的增强字段(作者/分类) */
function formatSearchSample(item: MatchedSearchItem): string {
  const label = item.name || '（无书名）';
  const extras = [
    item.author ? `作者:${item.author}` : '',
    item.kind ? `分类:${item.kind}` : '',
  ].filter(Boolean);
  return extras.length ? `${label}（${extras.join(' ')}）` : label;
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
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-rules-panel',
  imports: [
    FormsModule,
    NzButtonModule,
    NzIconModule,
    NzInputModule,
    NzAlertModule,
    NzSelectModule,
  ],
  preserveWhitespaces: true,
  templateUrl: './rules-panel.component.html',
  styleUrl: './rules-panel.component.scss',
})
export class RulesPanelComponent {
  /** 测试 URL 解析基址 —— 父组件提供,智能添加传 targetUrl,书源编辑传 BASE_URL */
  readonly baseUrl = input<string>('');
  /** 是否显示「测试仅验证规则」行为提示(仅书源编辑页需要) */
  readonly showTestBehaviorHint = input<boolean>(false);

  // ── 规则字段(均为 signal) ──
  /** 站点名(对应 @name 头;不在面板显示,仅随 setRules/getRules 传递,保证整包重生成代码时不丢名称) */
  readonly siteName = signal('');
  readonly searchPath = signal('');
  readonly searchMethod = signal<SearchMethod>('GET');
  readonly searchBodyParams = signal<Array<{ key: string; value: string }>>([]);
  readonly searchContentType = signal('application/x-www-form-urlencoded');
  readonly searchRawBody = signal('');
  readonly searchItem = signal('');
  /** 【可选增强】搜索结果条目内的作者规则;空串 = 不提取(默认) */
  readonly searchAuthor = signal('');
  /** 【可选增强】搜索结果条目内的分类规则;空串 = 不提取(默认) */
  readonly searchCategory = signal('');
  readonly bookTitle = signal('');
  readonly bookCover = signal('');
  readonly bookAuthor = signal('');
  readonly chapterItem = signal('');
  readonly content = signal('');
  /** 正文净化规则(多条动态行;UI 始终保留至少一行,空 rule 行在打包规则时过滤) */
  readonly contentReplaceRules = signal<Array<{ rule: string; replace: string }>>([
    { rule: '', replace: '' },
  ]);
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

  /** 打包规则字段,父组件可用 effect 监听变化 */
  readonly rules = computed<SourceRules>(() => ({
    siteName: this.siteName(),
    searchPath: this.searchPath(),
    searchMethod: this.searchMethod(),
    searchBodyParams: this.searchBodyParams(),
    searchContentType: this.searchContentType(),
    searchRawBody: this.searchRawBody(),
    searchItemPattern: this.searchItem(),
    searchAuthorPattern: this.searchAuthor(),
    searchCategoryPattern: this.searchCategory(),
    bookTitlePattern: this.bookTitle(),
    coverUrlPattern: this.bookCover(),
    bookAuthorPattern: this.bookAuthor(),
    chapterItemPattern: this.chapterItem(),
    contentPattern: this.content(),
    contentReplaceRules: this.contentReplaceRules().filter((r) => r.rule.trim()),
    bookCategoryPattern: this.bookCategory(),
  }));

  private readonly fetcher = inject(PageFetcherService);

  // ── Public API ──

  /** 父组件从已存在的源/探测结果加载规则;缺失字段保留 panel 当前值 */
  setRules(rules: Partial<SourceRules>): void {
    if (rules.siteName !== undefined) this.siteName.set(rules.siteName);
    if (rules.searchPath !== undefined) this.searchPath.set(rules.searchPath);
    if (rules.searchMethod !== undefined) this.searchMethod.set(rules.searchMethod);
    if (rules.searchBodyParams !== undefined) this.searchBodyParams.set(rules.searchBodyParams);
    if (rules.searchContentType !== undefined) this.searchContentType.set(rules.searchContentType);
    if (rules.searchRawBody !== undefined) this.searchRawBody.set(rules.searchRawBody);
    if (rules.searchItemPattern !== undefined) this.searchItem.set(rules.searchItemPattern);
    if (rules.searchAuthorPattern !== undefined) this.searchAuthor.set(rules.searchAuthorPattern);
    if (rules.searchCategoryPattern !== undefined)
      this.searchCategory.set(rules.searchCategoryPattern);
    if (rules.bookTitlePattern !== undefined) this.bookTitle.set(rules.bookTitlePattern);
    if (rules.coverUrlPattern !== undefined) this.bookCover.set(rules.coverUrlPattern);
    if (rules.bookAuthorPattern !== undefined) this.bookAuthor.set(rules.bookAuthorPattern);
    if (rules.chapterItemPattern !== undefined) this.chapterItem.set(rules.chapterItemPattern);
    if (rules.contentPattern !== undefined) this.content.set(rules.contentPattern);
    if (rules.contentReplaceRules !== undefined) {
      this.contentReplaceRules.set(
        rules.contentReplaceRules.length
          ? rules.contentReplaceRules.map((r) => ({ rule: r.rule, replace: r.replace }))
          : [{ rule: '', replace: '' }],
      );
    }
    if (rules.bookCategoryPattern !== undefined) this.bookCategory.set(rules.bookCategoryPattern);
  }

  /** 父组件读取当前规则(用于保存/生成代码) */
  getRules(): SourceRules {
    return this.rules();
  }

  /** 清空所有状态 —— analyze 重新开始或父组件 unmount 场景 */
  reset(): void {
    this.siteName.set('');
    this.searchPath.set('');
    this.searchMethod.set('GET');
    this.searchBodyParams.set([]);
    this.searchContentType.set('application/x-www-form-urlencoded');
    this.searchRawBody.set('');
    this.searchItem.set('');
    this.searchAuthor.set('');
    this.searchCategory.set('');
    this.bookTitle.set('');
    this.bookCover.set('');
    this.bookAuthor.set('');
    this.chapterItem.set('');
    this.content.set('');
    this.contentReplaceRules.set([{ rule: '', replace: '' }]);
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

  /** 正文净化规则 —— 末尾追加一行(只有最后一行显示 + 按钮) */
  addContentReplaceRule(): void {
    this.contentReplaceRules.update((arr) => [...arr, { rule: '', replace: '' }]);
  }

  /** 正文净化规则 —— 删除指定行(至少保留一行) */
  removeContentReplaceRule(index: number): void {
    this.contentReplaceRules.update((arr) => {
      const next = arr.filter((_, i) => i !== index);
      return next.length ? next : [{ rule: '', replace: '' }];
    });
  }

  /** 正文净化规则 —— 修改指定行的 rule 或 replace */
  updateContentReplaceRule(index: number, field: 'rule' | 'replace', value: string): void {
    this.contentReplaceRules.update((arr) =>
      arr.map((r, i) => (i === index ? { ...r, [field]: value } : r)),
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
      // 条目 + 可选的作者/分类增强字段(与生成的 search() 同链路:作用域 = 条目内部)
      const items = matchSearchItems(
        this.searchItem(),
        html,
        url,
        { authorRule: this.searchAuthor(), categoryRule: this.searchCategory() },
        100,
      );
      const authorHits = items.filter((it) => it.author).length;
      const categoryHits = items.filter((it) => it.kind).length;
      this.searchStage.set({
        running: false,
        error: '',
        summary: buildSearchSummary(
          items.length,
          authorHits,
          categoryHits,
          this.searchAuthor(),
          this.searchCategory(),
        ),
        samples: items.map((it) => ({
          label: formatSearchSample(it),
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
        // 与生成的 chapterContent() 严格同链路:stripTags(去标签 + 实体解码) → 按顺序执行净化规则。
        // 注意规则在 stripTags 之后执行 —— 想匹配 &nbsp; 等实体是匹配不到的(已转空格),规则应面向解码后文本
        const replaceRules = this.contentReplaceRules().filter((r) => r.rule.trim());
        const cleaned = applyContentReplaceRules(stripTags(rawHtml), replaceRules);
        this.contentPreview.set(cleaned.slice(0, 2000) + (cleaned.length > 2000 ? '…' : ''));
        this.contentStage.set({
          running: false,
          error: '',
          summary: replaceRules.length
            ? `✓ 命中 ${rawHtml.length} 字节(已应用 ${replaceRules.length} 条净化规则)`
            : `✓ 命中 ${rawHtml.length} 字节`,
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
