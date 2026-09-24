import { Component, inject, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ScrollingModule } from '@angular/cdk/scrolling';
import { NzUploadModule, NzUploadFile } from 'ng-zorro-antd/upload';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { splitChapters, ImportedChapter } from '../../core/logic/chapter-split';
import { ToastService } from '../../core/services/toast.service';
import { BookService } from '../../core/services/book.service';
import { Book } from '../../core/models/book.model';
import { Chapter } from '../../core/models/chapter.model';

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB（security-reviewer L4 缓解）
const DEFAULT_DISPLAY_COUNT = 50;

/**
 * 导入本地 TXT（modal 内容组件）
 * 由 NzModalService.create({ nzContent: ImportLocalTxtComponent }) 调用
 */
@Component({
  selector: 'app-import-local-txt',
  standalone: true,
  imports: [CommonModule, FormsModule, ScrollingModule, NzUploadModule, NzButtonModule, NzIconModule],
  template: `
    <div class="import-local-txt">
      <p>将 TXT 文件拖到下方或点击选择（≤ 50MB）：</p>
      <nz-upload
        nzType="drag"
        [nzMultiple]="false"
        [nzBeforeUpload]="beforeUpload"
        [nzShowUploadList]="false"
        nzAccept=".txt"
      >
        <p class="ant-upload-text">点击或拖动 TXT 到此区域</p>
        <p class="ant-upload-hint">仅支持单文件，大小不超过 50MB</p>
      </nz-upload>

      @if (filename()) {
        <p class="hint">已选择：{{ filename() }}（约 {{ lineCount() }} 行，{{ fileSize() }}）</p>
      }

      @if (chapters().length > 0) {
        <h4>
          识别到 {{ chapters().length }} 个章节
          <small class="hint-inline">（{{ chaptersPreview().length }} 预览 / {{ chapters().length }} 总数）</small>
          @if (chapters().length > DEFAULT_DISPLAY_COUNT) {
            <button nz-button nzType="link" nzSize="small" (click)="toggleShowAll()">
              {{ showAll() ? '收起' : '展开全部' }}
            </button>
          }
        </h4>
        <cdk-virtual-scroll-viewport itemSize="64" class="chapter-list">
          <div
            *cdkVirtualFor="let item of chaptersPreview(); let i = index"
            class="chapter-item"
            [class.expanded]="selectedIndex() === i"
            (click)="togglePreview(i)"
          >
            <div class="chapter-row">
              <strong>{{ i + 1 }}.</strong>
              <span class="title">{{ item.title }}</span>
              <span class="range">（{{ item.endLine - item.startLine + 1 }} 行）</span>
            </div>
            @if (selectedIndex() === i) {
              <pre class="preview">{{ previewOf(i) }}</pre>
            }
          </div>
        </cdk-virtual-scroll-viewport>
        <p class="hint-tip">
          <span nz-icon nzType="info-circle"></span>
          点击章节可预览前 ~500 字
        </p>
      } @else if (filename()) {
        <p class="hint warn">
          <span nz-icon nzType="warning"></span>
          未识别到章节标题，将作为单章"全文"导入。
        </p>
      }
    </div>
  `,
  styles: [
    `
      .import-local-txt {
        min-height: 240px;
      }
      .hint {
        margin: 16px 0;
        color: var(--pom-text);
      }
      .hint.warn {
        color: #d48806;
        display: flex;
        align-items: center;
        gap: 6px;
      }
      h4 {
        margin: 16px 0 8px;
        color: var(--pom-text-muted);
      }
      .range {
        color: var(--pom-text);
        margin-left: 8px;
      }
      h4 {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }
      .hint-inline {
        color: var(--pom-text);
        font-weight: normal;
        font-size: 12px;
      }
      .chapter-list {
        height: 320px;
        border: 1px solid var(--pom-border);
        border-radius: 4px;
        background: var(--pom-card);
      }
      .chapter-item {
        padding: 6px 12px;
        line-height: 24px;
        border-bottom: 1px solid var(--pom-border);
        color: var(--pom-text);
      }
      .chapter-item strong {
        color: var(--pom-text-muted);
        margin-right: 8px;
      }
      .chapter-row {
        display: flex;
        align-items: center;
        gap: 8px;
        cursor: pointer;
      }
      .chapter-row .title {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .chapter-item.expanded {
        background: var(--pom-border);
      }
      .preview {
        margin: 8px 0 0 24px;
        padding: 8px 12px;
        background: var(--pom-bg);
        border-left: 3px solid var(--pom-text-muted);
        color: var(--pom-text);
        font-size: 12px;
        line-height: 1.5;
        max-height: 200px;
        overflow: auto;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .hint-tip {
        margin: 8px 0 0;
        color: var(--pom-text);
        font-size: 12px;
        display: flex;
        align-items: center;
        gap: 4px;
      }
    `,
  ],
})
export class ImportLocalTxtComponent {
  readonly filename = signal<string>('');
  readonly chapters = signal<ImportedChapter[]>([]);
  readonly lineCount = signal(0);
  readonly fileSize = signal('');
  readonly showAll = signal(false);
  readonly selectedIndex = signal<number | null>(null);
  readonly DEFAULT_DISPLAY_COUNT = DEFAULT_DISPLAY_COUNT;

  readonly chaptersPreview = computed<ImportedChapter[]>(() => {
    const all = this.chapters();
    if (this.showAll() || all.length <= DEFAULT_DISPLAY_COUNT) return all;
    return all.slice(0, DEFAULT_DISPLAY_COUNT);
  });

  toggleShowAll(): void {
    this.showAll.update((v) => !v);
  }

  togglePreview(i: number): void {
    this.selectedIndex.update((cur) => (cur === i ? null : i));
  }

  /** 返回第 i 个章节的前 ~500 字预览 */
  previewOf(i: number): string {
    const chs = this.chapters();
    const ic = chs[i];
    if (!ic || !this.fullText) return '';
    const lines = this.fullText.split(/\r?\n/);
    const slice = lines.slice(ic.startLine, ic.endLine + 1);
    const text = slice.join('\n').trim();
    if (text.length <= 500) return text;
    return text.slice(0, 500) + '...';
  }

  private fullText = '';
  private readonly toast = inject(ToastService);
  private readonly books = inject(BookService);

  beforeUpload = (file: NzUploadFile): boolean => {
    const realFile = file as unknown as File;
    if (realFile.size > MAX_FILE_SIZE) {
      this.toast.error(`文件超过 50MB 上限（当前 ${(realFile.size / 1024 / 1024).toFixed(1)}MB）`);
      return false;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || '');
      this.fullText = text;
      this.filename.set(realFile.name);
      this.fileSize.set(this.formatSize(realFile.size));
      this.lineCount.set(text.split(/\r?\n/).length);
      const chs = splitChapters(text);
      this.chapters.set(chs);
      if (chs.length === 1 && chs[0].title === '全文') {
        this.toast.warn('未识别到章节标题，将作为单章"全文"导入。');
      }
    };
    reader.readAsText(realFile, 'utf-8');
    return false; // 阻止默认上传
  };

  async confirm(): Promise<boolean> {
    if (this.chapters().length === 0) {
      this.toast.warn('请先选择文件');
      return false;
    }
    try {
      const id = `txt-${Date.now()}`;
      const baseTitle = this.filename().replace(/\.[^.]+$/, '');
      const book: Book = {
        id,
        title: baseTitle,
        author: '本地导入',
        coverColor: '#8b4513',
        chapterCount: this.chapters().length,
        totalChars: this.fullText.length,
        importedAt: new Date().toISOString(),
        source: 'local-txt',
      };
      const lines = this.fullText.split(/\r?\n/);
      const chapters: Chapter[] = this.chapters().map((c, i) => ({
        bookId: id,
        index: i,
        title: c.title === '__preamble__' ? '序章' : c.title,
        content: lines.slice(c.startLine, c.endLine + 1).join('\n').trim(),
      }));
      await this.books.addBook(book, chapters);
      this.toast.success(`已导入：${book.title}（${chapters.length} 章）`);
      return true;
    } catch (e) {
      this.toast.error(`导入失败：${(e as Error).message}`);
      return false;
    }
  }

  private formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }
}