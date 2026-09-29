import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';

import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzAlertModule } from 'ng-zorro-antd/alert';
import { RulesPanelComponent } from '../../shared/components/rules-panel/rules-panel.component';
import { ToastService } from '../../core/services/toast.service';
import { PageFetcherService } from '../../core/book-source/page-fetcher.service';
import { buildRules, countChapterLinks } from '../../core/book-source/smart-add/smart-rules';
import {
  buildSourceDoc,
  isValidSourceDocFileName,
  serializeSourceDoc,
  sourceDocFileName,
} from '../../core/logic/source-doc-build';
import { BookSourceDocSchema } from '../../core/models/book-source-doc.model';
import * as v from 'valibot';

type PomSave = {
  booksourceSave?: (fileName: string, content: string, sourceDir?: string) => Promise<void>;
};

/**
 * 智能添加页(迁移自 legado SmartSourceDetector)
 * 步骤:输入 URL → 真实抓取 + 启发式探测 → 规则面板(可编辑 + 逐阶段真实命中测试)
 *      → 规则参数化生成代码(由 RulesPanelComponent 驱动,自动随规则变更重生成)
 *      → 保存 / 保存并调试
 *
 * 规则双模式:CSS 选择器(如 dl.list dd a;含特殊符号加 css: 前缀)或正则;
 * 沙箱无 DOM → CSS 选择器经 legado.query 主线程 DOMParser 代理执行
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-book-source-smart-add',
  imports: [
    FormsModule,
    NzButtonModule,
    NzIconModule,
    NzInputModule,
    NzAlertModule,
    RulesPanelComponent,
  ],
  template: `
    <!-- 返回书源列表（移除内嵌 Tab 后替代入口） -->
    <div class="back-row">
      <button nz-button nzSize="small" (click)="back()">
        <span nz-icon nzType="arrow-left"></span> 返回书源列表
      </button>
    </div>

    <!-- ① URL 输入 -->
    <div class="url-row">
      <input
        nz-input
        [(ngModel)]="targetUrl"
        placeholder="目标网站首页或书籍页 URL(https://...)"
        [disabled]="analyzing()"
        (keyup.enter)="analyze()"
        class="grow"
      />
      <button
        nz-button
        nzType="primary"
        (click)="analyze()"
        [disabled]="analyzing() || !targetUrl.trim()"
      >
        <span nz-icon [nzType]="analyzing() ? 'loading' : 'thunderbolt'"></span>
        {{ analyzing() ? '分析中...' : '分析' }}
      </button>
    </div>

    @if (error()) {
      <nz-alert nzType="error" [nzMessage]="error()" class="mb"></nz-alert>
    }

    @if (analyzed()) {
      <!-- ② 探测摘要 -->
      <div class="summary">
        <div class="summary-item">
          <span class="k">章节链接</span
          ><span class="v">首页检测到 {{ chapterLinkCount() }} 个疑似章节链接</span>
        </div>
      </div>

      <!-- ③ 规则处理提示(智能添加特有,讲清楚 CSS/正则双模式与 css: 前缀) -->
      <div class="rules-title">
        规则处理<span class="rules-hint"
          >支持 CSS 选择器(如 dl.list dd a)或正则;含 * ^ $ | + ? ( ) &#123; &#125; 等正则特征符号的
          CSS(如 a[href*="x"]、div + p、a:not(.x))需加 css: 前缀</span
        >
      </div>

      <!-- ④ 规则编辑 + 测试面板 -->
      <!-- baseUrl 走**分析快照**而非输入框：面板的逐阶段测试要把相对 URL 解析成绝对，
             用当前输入框值会让测试结果配着别的站点，测出来的"命中"是假的 -->
      <app-rules-panel #panel [baseUrl]="analyzedHomepage() || targetUrl" />

      <!-- ④ 文件名 + 代码生成 -->
      <div class="file-row">
        <span class="k">文件名</span>
        <input
          nz-input
          [ngModel]="fileName()"
          (ngModelChange)="fileName.set($event)"
          class="file-input"
        />
        <span class="hint">规则修改后下方代码自动重新生成</span>
      </div>

      <textarea nz-input [(ngModel)]="code" class="code-editor" spellcheck="false"></textarea>

      <div class="actions">
        <button nz-button (click)="reset()"><span nz-icon nzType="reload"></span> 重新分析</button>
        <button
          nz-button
          nzType="primary"
          (click)="save(true)"
          [disabled]="saving() || !fileName().trim()"
        >
          <span nz-icon nzType="save"></span> {{ saving() ? '保存中...' : '保存并调试' }}
        </button>
        <button nz-button (click)="save(false)" [disabled]="saving() || !fileName().trim()">
          仅保存
        </button>
      </div>
    }
  `,
  styles: [
    `
      .url-row {
        display: flex;
        gap: 8px;
        margin-bottom: 12px;
      }
      .back-row {
        margin-bottom: 8px;
      }
      .grow {
        flex: 1;
        min-width: 0;
      }
      .mb {
        margin-bottom: 12px;
      }
      .summary {
        display: flex;
        gap: 32px;
        padding: 10px 12px;
        border: 1px solid var(--pom-border);
        border-radius: 4px;
        background: var(--pom-card);
        margin-bottom: 14px;
      }
      .summary-item {
        display: flex;
        gap: 8px;
        align-items: baseline;
        min-width: 0;
      }
      .k {
        color: var(--pom-text-muted);
        font-size: 12px;
        white-space: nowrap;
      }
      .file-row {
        display: flex;
        align-items: center;
        gap: 8px;
        margin: 14px 0 10px;
        flex-wrap: wrap;
      }
      .file-input {
        width: 240px;
        font-family: Consolas, monospace;
      }
      .hint {
        color: var(--pom-text-muted);
        font-size: 12px;
      }
      .code-editor {
        width: 100%;
        height: 38vh;
        resize: vertical;
        font-family: 'Cascadia Code', Consolas, monospace;
        font-size: 12px;
        line-height: 1.6;
        background: var(--pom-card);
        color: var(--pom-text);
        border: 1px solid var(--pom-border);
        border-radius: 4px;
        padding: 12px;
      }
      .actions {
        display: flex;
        gap: 8px;
        margin-top: 12px;
        justify-content: flex-end;
      }
    `,
  ],
})
export class BookSourceSmartAddComponent {
  readonly analyzing = signal(false);
  readonly saving = signal(false);
  readonly error = signal('');
  readonly analyzed = signal(false);
  readonly chapterLinkCount = signal(0);

  /**
   * 目标 URL（普通属性，**刻意不做 signal**）
   *
   * 生成文档的 effect 若追踪它，用户在分析完就改 URL 输入框会把「**旧页面探测出的规则**」
   * 与「新 URL」配成一份文档 —— 那是静默的错误规则，比陈旧文档更糟。
   * 改 URL 后的正确动作是重新点「分析」（那是显式重探测）。
   */
  targetUrl = '';
  /**
   * 文件名（signal —— 文档里的 `uuid` 取它，必须随改名同步重生成）
   *
   * 外部评审 R1 抓到：初版它是普通属性，`effect` 不追踪，用户在面板出来后改名，
   * 存盘的 `B.json` 里却写着 `uuid: "A.json"` —— 命名空间连续性就断在这里，且无报错。
   */
  readonly fileName = signal('');
  /**
   * 本次**分析**所用的主站 origin（快照，非输入框当前值）
   *
   * 与规则同源：`analyze()` 里在 URL 校验通过后就落定，此后即使用户改 URL 输入框，
   * 重新生成的文档也仍指向"当初探测规则的那个站点"。改 URL 后的正确动作是重新点「分析」。
   */
  private readonly analyzedHomepage = signal('');
  /**
   * 待保存的 JSON 文档文本（书源 JSON 规则化 P2.3：以前这里是生成的 JS 模板）
   *
   * 仍然用 `<textarea [(ngModel)]>` 暴露给用户手改 —— JSON 比 JS 模板好改得多，
   * 但**手改之后可能非法**，所以保存前会过一遍 `BookSourceDocSchema`（见 `save()`）。
   */
  code = '';

  private readonly panel = viewChild<RulesPanelComponent>('panel');
  private readonly fetcher = inject(PageFetcherService);
  private readonly toast = inject(ToastService);
  private readonly router = inject(Router);

  constructor() {
    // 规则或文件名变化 → 重新生成文档（替代原 Proxy 包装方案）
    effect(() => {
      const p = this.panel();
      if (!p || !this.analyzed()) return;
      // 读 fileName() 建立依赖：改名也要重生成，否则 uuid 与落盘文件名不一致
      this.fileName();
      this.code = this.buildDocText(p.getRules());
    });
  }

  /**
   * 规则集 → JSON 文档文本
   *
   * `homepage` 取 **`analyzedHomepage` 快照**，不是输入框里的 `targetUrl`：
   * 规则是在**分析那一刻的页面**上探测出来的，homepage 必须与它们同源。
   * 若读当前输入框，用户分析完顺手改一下 URL、再改文件名触发重生成，就会得到
   * "新 URL + 旧页面规则"的文档 —— 抓取必然失败，而界面上看不出任何异常
   * （外部评审 R2 推翻了我"R1 里让 targetUrl 不做 signal 就够了"的判断：
   * 不追踪只是**推迟**，任何由 fileName / 规则变化触发的重跑照样会读到脏值）。
   *
   * `uuid` 取 `fileName`（带扩展名）：与存量 `.js` 无 `@uuid` 时 `booksource-meta.ts:142`
   * 的回退**同构** —— 同一逻辑源在"新建"与"迁移"两条路上必须落到同一个命名空间口径。
   */
  private buildDocText(rules: Parameters<typeof buildSourceDoc>[0]['rules']): string {
    return serializeSourceDoc(
      buildSourceDoc({
        uuid: this.fileName().trim() || 'book_source.json',
        name: rules.siteName,
        homepage: this.analyzedHomepage(),
        rules,
      }),
    );
  }

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
    // 先落定 homepage 快照：URL 此时已校验通过，且必须在 analyzed 置位**之前** ——
    // 否则 effect 的第一次重生成会读到空快照，代码区先闪一份非法文档。
    this.analyzedHomepage.set(originOf(url));
    this.analyzing.set(true);
    this.error.set('');
    // 先把 analyzed 置 true 让 RulesPanelComponent 渲染,viewChild 才能就绪;
    // 若 fetch 失败再回滚到 false 隐藏面板。这样 await 期间 zone.js 至少跑一次 CD,
    // panel() 才不会是 undefined(commit 33c21e7 引入的 viewChild 时序坑)。
    this.analyzed.set(true);
    try {
      const html = await this.fetcher.fetchHtml(url);
      const p = this.panel();
      if (!p) {
        this.error.set('规则面板未就绪,请稍后重试');
        this.analyzed.set(false);
        return;
      }
      // 先清空面板状态(测试输出 + bookUrl/chapterUrl + keyword),再注入探测得到的规则
      p.reset();
      p.setRules(buildRules(url, html));
      this.chapterLinkCount.set(countChapterLinks(html));
      this.fileName.set(sourceDocFileName(url));
    } catch (e) {
      this.error.set(`抓取或分析失败:${(e as Error).message}`);
      this.analyzed.set(false);
    } finally {
      this.analyzing.set(false);
    }
  }

  reset(): void {
    this.analyzed.set(false);
    this.analyzedHomepage.set('');
    this.code = '';
    this.error.set('');
    this.chapterLinkCount.set(0);
    this.panel()?.reset();
  }

  /** 返回书源列表（移除内嵌 Tab 后智能添加页需手动返回） */
  back(): void {
    void this.router.navigateByUrl('/book-sources');
  }

  /** 保存书源;andDebug=true 时跳调试页预选该书源 */
  async save(andDebug: boolean): Promise<void> {
    const api = (window as unknown as { pomAPI?: PomSave }).pomAPI;
    if (!api?.booksourceSave) {
      this.toast.error('booksourceSave IPC 不可用');
      return;
    }
    const fileName = this.fileName().trim();
    if (!isValidSourceDocFileName(fileName)) {
      this.toast.warn('文件名需为 字母/数字/下划线/中划线/中文 + .json 后缀');
      return;
    }
    // 用户可能在这个 textarea 里手改过 JSON，落盘前必须校验：
    // 写盘一个非法文档 → 列表页标"规则非法"、书源不可用，且**内容已被覆盖**。
    let parsed: unknown;
    try {
      parsed = JSON.parse(this.code);
    } catch (e) {
      this.toast.warn(`内容不是合法 JSON：${(e as Error).message}`);
      return;
    }
    const checked = v.safeParse(BookSourceDocSchema, parsed);
    if (!checked.success) {
      const issue = checked.issues[0];
      this.toast.warn(`规则非法：${issue ? issue.message : '未知错误'}`);
      return;
    }
    this.saving.set(true);
    try {
      // 原样落盘**用户看到的那份文本**，不用 `checked.output` 重写：
      // 重写会把 schema 缺省补进文件（多出一堆键）并让 diff 全红，而校验的目的只是"拦"。
      await api.booksourceSave(fileName, this.code);
      this.toast.success(`书源「${fileName}」保存成功`);
      if (andDebug) {
        void this.router.navigate(['/book-sources/debug'], { queryParams: { source: fileName } });
      }
    } catch (e) {
      this.toast.error(`保存失败:${(e as Error).message}`);
    } finally {
      this.saving.set(false);
    }
  }
}

/** origin；非法 URL 返回空串（调用点不在异常路径上，见 `buildDocText` 注释） */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}
