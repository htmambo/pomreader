import {
  ChangeDetectionStrategy,
  Component,
  inject,
  signal,
  computed,
  type OnDestroy,
} from '@angular/core';

import { FormsModule } from '@angular/forms';
import { ScrollingModule } from '@angular/cdk/scrolling';
import { NzUploadModule, type NzUploadFile } from 'ng-zorro-antd/upload';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { NzSelectModule } from 'ng-zorro-antd/select';
import { splitChapters, type ImportedChapter } from '../../core/logic/chapter-split';
import { decodeTxtBuffer, type TxtEncodingMode } from '../../core/logic/detect-encoding';
import { finalizeChapterContent } from '../../core/logic/text-format';
import { ToastService } from '../../core/services/toast.service';
import { LocalTxtImportService } from '../../core/services/local-txt-import.service';

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB（security-reviewer L4 缓解）
const DEFAULT_DISPLAY_COUNT = 50;

/**
 * 导入本地 TXT（modal 内容组件）
 * 由 NzModalService.create({ nzContent: ImportLocalTxtComponent }) 调用
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-import-local-txt',
  imports: [
    FormsModule,
    ScrollingModule,
    NzUploadModule,
    NzButtonModule,
    NzIconModule,
    NzSelectModule,
  ],
  preserveWhitespaces: true,
  templateUrl: './import-local-txt.component.html',
  styles: [
    `
      .import-local-txt {
        min-height: 240px;
      }
      .encoding-row {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-top: 12px;
        color: var(--pom-text);
      }
      .encoding-row nz-select {
        width: 160px;
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
export class ImportLocalTxtComponent implements OnDestroy {
  readonly filename = signal<string>('');
  readonly chapters = signal<ImportedChapter[]>([]);
  readonly lineCount = signal(0);
  readonly fileSize = signal('');
  readonly showAll = signal(false);
  readonly selectedIndex = signal<number | null>(null);
  readonly detectedEncoding = signal('');
  /** nz-select 用字符串 model */
  encodingModel: TxtEncodingMode = 'auto';
  readonly DEFAULT_DISPLAY_COUNT = DEFAULT_DISPLAY_COUNT;

  private static readonly ENCODING_LABELS: Record<string, string> = {
    'utf-8': 'UTF-8',
    'utf-16le': 'UTF-16 LE',
    'utf-16be': 'UTF-16 BE',
    gb18030: 'GBK / GB18030',
  };

  readonly encodingLabel = computed(
    () => ImportLocalTxtComponent.ENCODING_LABELS[this.detectedEncoding()] ?? '',
  );

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

  ngOnDestroy(): void {
    this.readToken++; // 使 in-flight 的 FileReader 回调失效
  }

  /** 返回第 i 个章节的前 ~500 字预览 */
  previewOf(i: number): string {
    const chs = this.chapters();
    const ic = chs[i];
    if (!ic || !this.fullText) return '';
    const lines = this.fullText.split(/\r?\n/);
    const slice = lines.slice(ic.startLine, ic.endLine + 1);
    const text = finalizeChapterContent(slice.join('\n'));
    if (text.length <= 500) return text;
    return text.slice(0, 500) + '...';
  }

  private fullText = '';
  private rawBuffer: ArrayBuffer | null = null;
  private readToken = 0;
  private readonly toast = inject(ToastService);
  private readonly importer = inject(LocalTxtImportService);

  beforeUpload = (file: NzUploadFile): boolean => {
    const realFile = file as unknown as File;
    if (realFile.size > MAX_FILE_SIZE) {
      this.toast.error(`文件超过 50MB 上限（当前 ${(realFile.size / 1024 / 1024).toFixed(1)}MB）`);
      return false;
    }
    this.rawBuffer = null; // 先失效旧缓存，避免读取期间切编码解出旧文件
    const token = ++this.readToken; // 世代令牌：过期 reader 的回调直接丢弃
    const reader = new FileReader();
    reader.onload = () => {
      if (token !== this.readToken) return;
      this.rawBuffer = reader.result as ArrayBuffer;
      this.filename.set(realFile.name);
      this.fileSize.set(this.formatSize(realFile.size));
      try {
        this.applyDecode();
      } catch {
        this.toast.error('解析失败，请尝试手动切换编码');
      }
    };
    reader.onerror = () => {
      if (token !== this.readToken) return;
      this.rawBuffer = null;
      this.toast.error('文件读取失败，请重试');
    };
    reader.readAsArrayBuffer(realFile);
    return false; // 阻止默认上传
  };

  /** 切换编码：基于已读字节流重新解码 + 重新分章 */
  onEncodingChange(mode: TxtEncodingMode): void {
    this.encodingModel = mode;
    this.applyDecode();
  }

  private applyDecode(): void {
    if (!this.rawBuffer) return;
    const { text, encoding } = decodeTxtBuffer(this.rawBuffer, this.encodingModel);
    this.fullText = text;
    this.detectedEncoding.set(encoding);
    this.lineCount.set(text.split(/\r?\n/).length);
    const chs = splitChapters(text);
    this.chapters.set(chs);
    this.selectedIndex.set(null);
    if (chs.length === 1 && chs[0].title === '全文') {
      this.toast.warn('未识别到章节标题，将作为单章"全文"导入。');
    }
  }

  async confirm(): Promise<boolean> {
    if (this.chapters().length === 0) {
      this.toast.warn('请先选择文件');
      return false;
    }
    try {
      const { book, chapters } = await this.importer.importText(this.filename(), this.fullText);
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
