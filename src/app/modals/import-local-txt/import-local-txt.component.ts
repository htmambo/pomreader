import { Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { NzModalModule } from 'ng-zorro-antd/modal';
import { NzUploadModule, NzUploadFile } from 'ng-zorro-antd/upload';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzListModule } from 'ng-zorro-antd/list';
import { splitChapters, ImportedChapter } from '../../core/logic/chapter-split';
import { ToastService } from '../../core/services/toast.service';
import { BookService } from '../../core/services/book.service';
import { Book } from '../../core/models/book.model';
import { Chapter } from '../../core/models/chapter.model';

@Component({
  selector: 'app-import-local-txt',
  standalone: true,
  imports: [CommonModule, FormsModule, NzModalModule, NzUploadModule, NzButtonModule, NzListModule],
  template: `
    <nz-modal
      [nzVisible]="true"
      nzTitle="导入本地 TXT"
      (nzOnCancel)="close.emit()"
      (nzOnOk)="confirm()"
      [nzOkText]="importing() ? '导入中...' : '确认导入'"
      [nzCancelText]="'取消'"
      [nzOkDisabled]="chapters().length === 0 || importing()"
      [nzWidth]="640"
    >
      <ng-container *nzModalContent>
        <p>将 TXT 文件拖到下方或点击选择：</p>
        <nz-upload
          nzType="drag"
          [nzMultiple]="false"
          [nzBeforeUpload]="beforeUpload"
          [nzShowUploadList]="false"
          nzAccept=".txt"
        >
          <p class="ant-upload-text">点击或拖动 TXT 到此区域</p>
          <p class="ant-upload-hint">仅支持单文件，大小不限</p>
        </nz-upload>

        @if (filename()) {
          <p class="hint">已选择：{{ filename() }}（约 {{ lineCount() }} 行）</p>
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
          <p class="hint warn">未识别到章节标题，将作为单章"全文"导入。</p>
        }

        @if (importing()) {
          <p class="hint">正在加入书架...</p>
        }
      </ng-container>
    </nz-modal>
  `,
  styles: [
    `
      .hint {
        margin: 16px 0;
        color: var(--pom-text);
      }
      .hint.warn {
        color: #d48806;
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
  readonly close = { emit: () => undefined };
  readonly filename = signal<string>('');
  readonly chapters = signal<ImportedChapter[]>([]);
  readonly lineCount = signal(0);
  readonly importing = signal(false);

  private fullText = '';
  private readonly toast = inject(ToastService);
  private readonly books = inject(BookService);

  beforeUpload = (file: NzUploadFile): boolean => {
    const realFile = file as unknown as File;
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || '');
      this.fullText = text;
      this.filename.set(realFile.name);
      this.lineCount.set(text.split(/\r?\n/).length);
      const chs = splitChapters(text);
      this.chapters.set(chs);
      if (chs.length === 1 && chs[0].title === '全文') {
        this.toast.warn('未识别到章节标题，将作为单章"全文"导入。');
      }
    };
    reader.readAsText(realFile);
    return false; // 阻止默认上传
  };

  confirm(): void {
    if (this.chapters().length === 0) return;
    this.importing.set(true);
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
      this.importing.set(false);
      this.close.emit();
    } catch (e) {
      this.toast.error(`导入失败：${(e as Error).message}`);
      this.importing.set(false);
    }
  }
}