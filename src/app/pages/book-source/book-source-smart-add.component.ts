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
import { buildBookSourceDoc } from '../../core/logic/build-book-source-doc';
import { type BookSourceDoc } from '../../core/models/book-source-doc.model';

type PomSave = {
  booksourceSaveJson?: (fileName: string, doc: BookSourceDoc, sourceDir?: string) => Promise<void>;
};

/**
 * 智能添加页(迁移自 legado SmartSourceDetector)
 * 步骤:输入 URL → 真实抓取 + 启发式探测 → 规则面板(可编辑 + 逐阶段真实命中测试)
 *      → 规则 + meta 组装 BookSourceDoc(由 RulesPanelComponent 驱动,自动随规则变更重生成预览)
 *      → 保存 / 保存并调试（booksourceSaveJson 落盘 .json，方案 §3.1）
 *
 * 规则双模式:CSS 选择器(如 dl.list dd a;含特殊符号加 css: 前缀)或正则;
 * 沙箱无 DOM → CSS 选择器经 legado.query 主线程 DOMParser 代理执行
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  preserveWhitespaces: true,
  selector: 'app-book-source-smart-add',
  imports: [
    FormsModule,
    NzButtonModule,
    NzIconModule,
    NzInputModule,
    NzAlertModule,
    RulesPanelComponent,
  ],
  templateUrl: './book-source-smart-add.component.html',
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

  targetUrl = '';
  readonly fileName = signal('');
  /** BookSourceDoc 的 JSON 预览（只读展示；保存时以 buildDoc() 实时组装的 doc 为准） */
  code = '';

  private readonly panel = viewChild<RulesPanelComponent>('panel');
  private readonly fetcher = inject(PageFetcherService);
  private readonly toast = inject(ToastService);
  private readonly router = inject(Router);

  constructor() {
    // 规则/文件名变化 → 重新生成 JSON 预览(替代原 Proxy 包装方案)
    effect(() => {
      const p = this.panel();
      if (!p || !this.analyzed()) return;
      this.fileName(); // 预览中的 uuid 跟随文件名（uuid 缺省回退 fileName）
      this.code = JSON.stringify(this.buildDoc(), null, 2);
    });
  }

  /** 抓取首页 → 启发式探测 → 初始化规则 + 生成首版 JSON 预览 */
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
      const host = new URL(url).hostname.replace(/^www\./, '');
      this.fileName.set(`${host.replace(/\./g, '_')}.json`);
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

  /** 返回书源列表（移除内嵌 Tab 后智能添加页需手动返回） */
  back(): void {
    void this.router.navigateByUrl('/book-sources');
  }

  /** 保存书源;andDebug=true 时跳调试页预选该书源 */
  async save(andDebug: boolean): Promise<void> {
    const api = (window as unknown as { pomAPI?: PomSave }).pomAPI;
    if (!api?.booksourceSaveJson) {
      this.toast.error('booksourceSaveJson IPC 不可用');
      return;
    }
    const fileName = this.fileName().trim();
    if (!/^[a-zA-Z0-9_\-一-龥]+\.json$/.test(fileName)) {
      this.toast.warn('文件名需为 字母/数字/下划线/中划线/中文 + .json 后缀');
      return;
    }
    this.saving.set(true);
    try {
      await api.booksourceSaveJson(fileName, this.buildDoc());
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

  /**
   * 规则 + meta → BookSourceDoc（meta 口径与历史模板生成源的文件头一致：
   * author 智能添加 / tags 智能识别 / version 1.2.0 / description 含 host）；
   * uuid 缺省回退 fileName（带 .json 扩展名，§3.1 硬约束）
   */
  private buildDoc(): BookSourceDoc {
    const url = new URL(this.targetUrl.trim());
    const rules = this.panel()!.getRules();
    return buildBookSourceDoc({
      // 预览期文件名可能尚未生成（analyze 抓取中）→ 兜底占位；保存前已经过了 .json 合法性校验
      fileName: this.fileName().trim() || 'untitled.json',
      name: rules.siteName,
      homepage: url.origin,
      rules,
      author: '智能添加',
      tags: ['智能识别'],
      sourceVersion: '1.2.0',
      description: `由智能添加从 ${url.host} 生成(CSS 选择器/正则双模式,可在智能添加页继续调规则)`,
    });
  }
}
