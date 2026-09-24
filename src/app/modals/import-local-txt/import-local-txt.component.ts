import { Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { NzUploadModule, NzUploadFile } from 'ng-zorro-antd/upload';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzListModule } from 'ng-zorro-antd/list';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { splitChapters, ImportedChapter } from '../../core/logic/chapter-split';
import { ToastService } from '../../core/services/toast.service';
import { BookService } from '../../core/services/book.service';
import { Book } from '../../core/models/book.model';
import { Chapter } from '../../core/models/chapter.model';

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB（security-reviewer L4 缓解）

/**
 * 导入本地 TXT（modal 内容组件）
 * 由 NzModalService.create({ nzContent: ImportLocalTxtComponent }) 调用
 */
@Component({
  selector: 'app-import-local-txt',
  standalone: true,
  imports: [CommonModule, FormsModule, NzUploadModule, NzButtonModule, NzListModule, NzIconModule],
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
        <h4>识别到 {{ chapters().length }} 个章节：</h4>
        <nz-list [nzDataSource]="chapters()" nzBordered>
          <ng-template let-item let-index>
            <nz-list-item>
              <strong>{{ index + 1 }}.</strong> {{ item.title }}
              <small class="range">（{{ item.endLine - item.startLine + 1 }} 行）</small>
            </nz-list-item>
          </ng-template>
        </nz-list>
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
    `,
  ],
})
export class ImportLocalTxtComponent {
  readonly filename = signal<string>('');
  readonly chapters = signal<ImportedChapter[]>([]);
  readonly lineCount = signal(0);
  readonly fileSize = signal('');

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

  confirm(): boolean {
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
      this.books.addBook(book, chapters);
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