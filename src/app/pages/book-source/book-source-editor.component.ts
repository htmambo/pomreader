import { Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzModalModule } from 'ng-zorro-antd/modal';
import { PageHeaderComponent } from '../../shared/components/page-header/page-header.component';
import { ToastService } from '../../core/services/toast.service';
import { parseHeaderMeta } from '../../core/book-source/js-source/header-parser';
import { AiDraftService } from '../../core/book-source/source-market/ai-draft.service';

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
 * - 路由 /edit 为新建；/edit/:fileName 为编辑
 * - 左侧 textarea 编辑；右侧实时解析预览
 * - 保存调 booksourceSave，失败 toast
 * - 文件名缺省时从 @name 推导，回退时间戳
 */
@Component({
  selector: 'app-book-source-editor',
  standalone: true,
  imports: [CommonModule, FormsModule, NzButtonModule, NzIconModule, NzInputModule, NzModalModule, PageHeaderComponent],
  templateUrl: './book-source-editor.component.html',
  styleUrl: './book-source-editor.component.scss',
})
export class BookSourceEditorComponent {
  fileName = '';
  readonly isNew = signal(true);
  readonly source = signal('');
  readonly saving = signal(false);

  // AI 草稿（仅新建模式可见；v1 mock 模板）
  readonly showAiDialog = signal(false);
  readonly draftName = signal('');
  readonly draftUrl = signal('');
  private readonly aiDraft = inject(AiDraftService);

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
      this.isNew.set(!this.fileName);
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
    } catch (e) {
      this.toast.error(`读取失败：${(e as Error).message}`);
    }
  }

  /** 保存：新建走文件名推导；编辑保留原 fileName */
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
      const target = this.fileName || this.suggestFileName();
      await api.booksourceSave(target, content);
      this.toast.success(`保存成功：${target}`);
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

  /** 从 @name 推导文件名；非法字符替换为下划线；缺失时回退时间戳 */
  private suggestFileName(): string {
    const m = /@name\s+(.+)/.exec(this.source());
    const raw = m ? m[1].trim() : '';
    const slug = raw
      ? raw.replace(/[^\w一-龥-]+/g, '_').replace(/^_+|_+$/g, '')
      : `source-${Date.now()}`;
    return `${slug || `source-${Date.now()}`}.js`;
  }

  /** AI 草稿生成（v1 mock 模板）：填入 source + 推导 fileName */
  async aiGenerate(): Promise<void> {
    if (!this.draftName().trim() || !this.draftUrl().trim()) {
      this.toast.warn('请先输入书源名称和 URL');
      return;
    }
    try {
      const code = await this.aiDraft.generate({
        name: this.draftName(),
        url: this.draftUrl(),
      });
      this.source.set(code);
      if (this.isNew() && !this.fileName) {
        this.fileName = this.aiDraft.suggestFileName(this.draftName());
      }
      this.toast.success('已生成模板（v1 mock，需手动调整）');
      this.showAiDialog.set(false);
    } catch (e) {
      this.toast.error(`生成失败：${(e as Error).message}`);
    }
  }
}