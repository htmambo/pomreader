import { Component, effect, inject, signal, viewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzAlertModule } from 'ng-zorro-antd/alert';
import { PageHeaderComponent } from '../../shared/components/page-header/page-header.component';
import { BookSourceTabsComponent } from '../../shared/components/book-source-tabs/book-source-tabs.component';
import { RulesPanelComponent } from '../../shared/components/rules-panel/rules-panel.component';
import { ToastService } from '../../core/services/toast.service';
import { PageFetcherService } from '../../core/book-source/page-fetcher.service';
import {
  buildRules,
  countChapterLinks,
  generateSourceCode,
} from '../../core/book-source/smart-add/smart-rules';

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
  selector: 'app-source-smart-add',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    NzButtonModule,
    NzIconModule,
    NzInputModule,
    NzAlertModule,
    PageHeaderComponent,
    BookSourceTabsComponent,
    RulesPanelComponent,
  ],
  template: `
    <app-page-header title="智能添加" subtitle="输入网址 → 调整规则 → 生成书源"></app-page-header>
    <app-book-source-tabs />

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
      <button nz-button nzType="primary" (click)="analyze()" [disabled]="analyzing() || !targetUrl.trim()">
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
        <div class="summary-item"><span class="k">章节链接</span><span class="v">首页检测到 {{ chapterLinkCount() }} 个疑似章节链接</span></div>
      </div>

      <!-- ③ 规则处理提示(智能添加特有,讲清楚 CSS/正则双模式与 css: 前缀) -->
      <div class="rules-title">规则处理<span class="rules-hint">支持 CSS 选择器(如 dl.list dd a)或正则;含 * ^ $ | + ? ( ) &#123; &#125; \ 等正则特征符号的 CSS(如 a[href*="x"]、div + p、a:not(.x))需加 css: 前缀</span></div>

      <!-- ④ 规则编辑 + 测试面板 -->
      <app-rules-panel #panel [baseUrl]="targetUrl" />

      <!-- ④ 文件名 + 代码生成 -->
      <div class="file-row">
        <span class="k">文件名</span>
        <input nz-input [(ngModel)]="fileName" class="file-input" />
        <span class="hint">规则修改后下方代码自动重新生成</span>
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
    `,
  ],
})
export class SourceSmartAddComponent {
  readonly analyzing = signal(false);
  readonly saving = signal(false);
  readonly error = signal('');
  readonly analyzed = signal(false);
  readonly chapterLinkCount = signal(0);

  targetUrl = '';
  fileName = '';
  code = '';

  private readonly panel = viewChild<RulesPanelComponent>('panel');
  private readonly fetcher = inject(PageFetcherService);
  private readonly toast = inject(ToastService);
  private readonly router = inject(Router);

  constructor() {
    // 规则变化 → 重新生成代码(替代原 Proxy 包装方案)
    effect(() => {
      const p = this.panel();
      if (!p || !this.analyzed()) return;
      this.code = generateSourceCode(this.targetUrl.trim(), p.getRules());
    });
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
    this.analyzing.set(true);
    this.error.set('');
    try {
      const html = await this.fetcher.fetchHtml(url);
      const p = this.panel();
      if (!p) {
        this.error.set('规则面板未就绪,请稍后重试');
        return;
      }
      // 先清空面板状态(测试输出 + bookUrl/chapterUrl + keyword),再注入探测得到的规则
      p.reset();
      p.setRules(buildRules(url, html));
      this.chapterLinkCount.set(countChapterLinks(html));
      const host = new URL(url).hostname.replace(/^www\./, '');
      this.fileName = `${host.replace(/\./g, '_')}.js`;
      this.analyzed.set(true);
    } catch (e) {
      this.error.set(`抓取或分析失败:${(e as Error).message}`);
      this.analyzed.set(false);
    } finally {
      this.analyzing.set(false);
    }
  }

  reset(): void {
    this.analyzed.set(false);
    this.code = '';
    this.error.set('');
    this.chapterLinkCount.set(0);
    this.panel()?.reset();
  }

  /** 保存书源;andDebug=true 时跳调试页预选该书源 */
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
      this.toast.error(`保存失败:${(e as Error).message}`);
    } finally {
      this.saving.set(false);
    }
  }
}
