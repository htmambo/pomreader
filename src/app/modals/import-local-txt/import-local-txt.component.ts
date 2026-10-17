import {
  ChangeDetectionStrategy,
  Component,
  inject,
  signal,
  computed,
  viewChild,
  type OnDestroy,
} from '@angular/core';

import { FormsModule } from '@angular/forms';
import { CdkVirtualScrollViewport, ScrollingModule } from '@angular/cdk/scrolling';
import { NzUploadModule, type NzUploadFile } from 'ng-zorro-antd/upload';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { NzSelectModule } from 'ng-zorro-antd/select';
import { type ImportedChapter } from '../../core/logic/chapter-split';
import {
  decodeTxtBuffer,
  type TxtEncoding,
  type TxtEncodingMode,
} from '../../core/logic/detect-encoding';
import { finalizeChapterContent } from '../../core/logic/text-format';
import { ToastService } from '../../core/services/toast.service';
import { LocalTxtImportService } from '../../core/services/local-txt-import.service';

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB（security-reviewer L4 缓解）
const DEFAULT_DISPLAY_COUNT = 50;

/** 批量导入列表中的一行（一个文件） */
interface BatchEntry {
  name: string;
  sizeLabel: string;
  /** 保留 File 引用用于切换编码时重读，避免全部 buffer 常驻内存 */
  file: File;
  text: string;
  encoding: TxtEncoding | '';
  chapters: ImportedChapter[];
  /** 非空即错误行（超限 / 读取失败 / 解析失败），不参与导入 */
  error: string;
  status: 'pending' | 'imported' | 'failed';
}

/**
 * 导入本地 TXT（modal 内容组件，支持批量：每个文件一本书）
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
      .file-list {
        margin-top: 12px;
        border: 1px solid var(--pom-border);
        border-radius: 4px;
        background: var(--pom-card);
        max-height: 160px;
        overflow: auto;
      }
      .file-item {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 6px 12px;
        line-height: 24px;
        border-bottom: 1px solid var(--pom-border);
        color: var(--pom-text);
        cursor: pointer;
      }
      .file-item:last-child {
        border-bottom: none;
      }
      .file-item.selected {
        background: var(--pom-border);
      }
      .file-item .name {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .file-item .meta {
        color: var(--pom-text-muted);
        font-size: 12px;
        white-space: nowrap;
      }
      .file-item .badge {
        font-size: 12px;
        white-space: nowrap;
      }
      .file-item .badge.warn {
        color: #d48806;
      }
      .file-item .badge.error {
        color: #cf1322;
      }
      .file-item .badge.ok {
        color: #389e0d;
      }
      .file-item .remove {
        color: var(--pom-text-muted);
        cursor: pointer;
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
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }
      .range {
        color: var(--pom-text);
        margin-left: 8px;
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
        margin: 8px 0 0;
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
  readonly entries = signal<BatchEntry[]>([]);
  /** 当前预览章节列表的文件下标（-1 = 无） */
  readonly selectedFile = signal(-1);
  readonly showAll = signal(false);
  readonly selectedIndex = signal<number | null>(null);
  /** nz-select 用字符串 model；手动选择会应用到全部文件 */
  encodingModel: TxtEncodingMode = 'auto';
  readonly DEFAULT_DISPLAY_COUNT = DEFAULT_DISPLAY_COUNT;

  private static readonly ENCODING_LABELS: Record<string, string> = {
    'utf-8': 'UTF-8',
    'utf-16le': 'UTF-16 LE',
    'utf-16be': 'UTF-16 BE',
    gb18030: 'GBK / GB18030',
  };

  readonly selectedEntry = computed(() => this.entries()[this.selectedFile()] ?? null);
  readonly chapters = computed<ImportedChapter[]>(() => this.selectedEntry()?.chapters ?? []);
  readonly encodingLabel = computed(() => {
    const e = this.selectedEntry();
    return e?.encoding ? (ImportLocalTxtComponent.ENCODING_LABELS[e.encoding] ?? '') : '';
  });

  readonly chaptersPreview = computed<ImportedChapter[]>(() => {
    const all = this.chapters();
    if (this.showAll() || all.length <= DEFAULT_DISPLAY_COUNT) return all;
    return all.slice(0, DEFAULT_DISPLAY_COUNT);
  });

  /** 书架已有 / 批次内同名的文件集合（响应式：导入成功后书架变化会自动重算） */
  readonly duplicateNames = computed<Set<string>>(() => {
    const seen = new Set<string>();
    const dups = new Set<string>();
    for (const e of this.entries()) {
      if (e.status !== 'pending') continue;
      const title = this.importer.titleOf(e.name);
      if (seen.has(title) || this.importer.hasBook(e.name)) dups.add(e.name);
      seen.add(title);
    }
    return dups;
  });

  /** 待导入数量（排除错误行与重复行） */
  readonly importableCount = computed(
    () => this.entries().filter((e) => this.isImportable(e)).length,
  );

  /** 导入进行中：防 confirm 重入，并禁用文件追加与编码切换 */
  readonly importing = signal(false);
  /** 重解码进行中：防 onEncodingChange 重入，并禁用 confirm（避免混合编码导入） */
  readonly reencoding = signal(false);

  encodingLabelOf(e: BatchEntry): string {
    return e.encoding ? (ImportLocalTxtComponent.ENCODING_LABELS[e.encoding] ?? e.encoding) : '';
  }

  isDuplicate(name: string): boolean {
    return this.duplicateNames().has(name);
  }

  /** 条目被排除的原因（唯一判定来源）：null = 可导入 */
  private exclusion(e: BatchEntry): 'invalid' | 'duplicate' | null {
    if (e.status !== 'pending' || e.error || e.chapters.length === 0) return 'invalid';
    return this.isDuplicate(e.name) ? 'duplicate' : null;
  }

  /** 单条目是否可导入（importableCount 与 confirm 共用） */
  private isImportable(e: BatchEntry): boolean {
    return this.exclusion(e) === null;
  }

  /** 不可变地更新列表中的某个条目（按旧对象引用匹配，每条目每轮只 patch 一次） */
  private patchEntry(target: BatchEntry, patch: Partial<BatchEntry>): void {
    this.entries.update((list) => list.map((x) => (x === target ? { ...x, ...patch } : x)));
  }

  /** 当前选中章节的前 ~500 字预览（渲染在滚动列表外的固定面板，避免破坏固定行高） */
  readonly previewText = computed(() => {
    const i = this.selectedIndex();
    return i === null ? '' : this.previewOf(i);
  });

  private readonly viewport = viewChild(CdkVirtualScrollViewport);

  toggleShowAll(): void {
    this.showAll.update((v) => !v);
  }

  togglePreview(i: number): void {
    this.selectedIndex.update((cur) => (cur === i ? null : i));
    // 预览面板会压缩列表高度，样式生效后让虚拟滚动重新测量
    setTimeout(() => this.viewport()?.checkViewportSize());
  }

  selectFile(i: number): void {
    this.selectedFile.set(i);
    this.selectedIndex.set(null);
    this.showAll.set(false);
  }

  removeFile(i: number): void {
    this.entries.update((list) => list.filter((_, idx) => idx !== i));
    this.selectedFile.update((cur) => {
      if (cur === i) return Math.min(i, this.entries().length - 1);
      if (cur > i) return cur - 1;
      return cur;
    });
    this.selectedIndex.set(null);
  }

  ngOnDestroy(): void {
    this.destroyed = true; // 使 in-flight 的 FileReader 回调失效
  }

  /** 返回第 i 个章节的前 ~500 字预览（当前选中文件） */
  previewOf(i: number): string {
    const entry = this.selectedEntry();
    const ic = this.chapters()[i];
    if (!entry || !ic) return '';
    const lines = entry.text.split(/\r?\n/);
    const slice = lines.slice(ic.startLine, ic.endLine + 1);
    const text = finalizeChapterContent(slice.join('\n'));
    if (text.length <= 500) return text;
    return text.slice(0, 500) + '...';
  }

  private destroyed = false;
  private readonly toast = inject(ToastService);
  private readonly importer = inject(LocalTxtImportService);

  /** nz-upload 多选时每个文件各回调一次；每个文件读进自己的条目，无共享状态故无竞态 */
  beforeUpload = (file: NzUploadFile): boolean => {
    if (this.importing()) return false; // 导入进行中禁止追加
    const realFile = file as unknown as File;
    if (realFile.size > MAX_FILE_SIZE) {
      this.pushEntry({
        name: realFile.name,
        sizeLabel: this.formatSize(realFile.size),
        file: realFile,
        text: '',
        encoding: '',
        chapters: [],
        error: `超过 50MB 上限（${(realFile.size / 1024 / 1024).toFixed(1)}MB）`,
        status: 'pending',
      });
      return false;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (this.destroyed) return;
      const buffer = reader.result as ArrayBuffer;
      try {
        this.pushEntry(this.decodeEntry(realFile, buffer));
      } catch {
        this.pushEntry(this.errorEntry(realFile, '解析失败，请尝试手动切换编码'));
      }
    };
    reader.onerror = () => {
      if (this.destroyed) return;
      this.pushEntry(this.errorEntry(realFile, '文件读取失败'));
    };
    reader.readAsArrayBuffer(realFile);
    return false; // 阻止默认上传
  };

  /** 切换编码：逐条重读 File 并重新解码 + 重新分章（条间让出主线程；reencoding 防重入） */
  async onEncodingChange(mode: TxtEncodingMode): Promise<void> {
    if (this.importing() || this.reencoding()) return;
    this.reencoding.set(true);
    this.encodingModel = mode;
    try {
      for (const e of this.entries()) {
        if (e.status === 'imported') continue; // 已入库条目不重解码，避免预览与库内内容不一致
        if (e.file.size > MAX_FILE_SIZE) continue; // 超限条目不重读
        try {
          const buffer = await e.file.arrayBuffer();
          if (this.destroyed || this.importing()) return;
          const { text, encoding } = decodeTxtBuffer(buffer, mode);
          // status 复位 pending：failed 行经重编码可重试（重复导入由 isDuplicate 兜底）
          this.patchEntry(e, {
            text,
            encoding,
            chapters: this.importer.split(text),
            error: '',
            status: 'pending',
          });
        } catch {
          if (this.destroyed || this.importing()) return;
          this.patchEntry(e, { error: '解析失败，请尝试手动切换编码', status: 'pending' });
        }
      }
    } finally {
      this.reencoding.set(false);
    }
  }

  async confirm(): Promise<boolean> {
    if (this.importing() || this.reencoding()) return false; // 防重入/防混合编码
    if (this.importableCount() === 0) {
      this.toast.warn(this.entries().length ? '没有可导入的文件' : '请先选择文件');
      return false;
    }
    this.importing.set(true);
    let ok = 0;
    let skipped = 0;
    const failed: string[] = [];
    try {
      for (const e of this.entries()) {
        const reason = this.exclusion(e);
        if (reason !== null) {
          if (reason === 'duplicate') skipped++;
          continue;
        }
        try {
          await this.importer.importText(e.name, e.text);
          this.patchEntry(e, { status: 'imported' });
          ok++;
        } catch {
          this.patchEntry(e, { status: 'failed' });
          failed.push(e.name);
        }
      }
    } finally {
      this.importing.set(false);
    }

    const parts: string[] = [];
    if (ok) parts.push(`已导入 ${ok} 本`);
    if (skipped) parts.push(`跳过重复 ${skipped} 本`);
    // ok===0 时纯跳过摘要不走 success 通道，避免与失败 error toast 级别冲突
    if (parts.length) {
      if (ok > 0) this.toast.success(parts.join('，'));
      else this.toast.warn(parts.join('，'));
    }
    if (failed.length) {
      const shown = failed.slice(0, 5).join('、');
      this.toast.error(`导入失败 ${failed.length} 本：${shown}${failed.length > 5 ? ' 等' : ''}`);
    }
    // 入口已保证至少尝试一条，ok+failed ≥ 1；有失败时留在弹窗内，失败行标红可移除后重试
    return ok > 0 && failed.length === 0;
  }

  private decodeEntry(file: File, buffer: ArrayBuffer): BatchEntry {
    const { text, encoding } = decodeTxtBuffer(buffer, this.encodingModel);
    const chapters = this.importer.split(text);
    if (chapters.length === 1 && chapters[0].title === '全文') {
      this.toast.warn(`${file.name}：未识别到章节标题，将作为单章"全文"导入。`);
    }
    return {
      name: file.name,
      sizeLabel: this.formatSize(file.size),
      file,
      text,
      encoding,
      chapters,
      error: '',
      status: 'pending',
    };
  }

  private errorEntry(file: File, error: string): BatchEntry {
    return {
      name: file.name,
      sizeLabel: this.formatSize(file.size),
      file,
      text: '',
      encoding: '',
      chapters: [],
      error,
      status: 'pending',
    };
  }

  private pushEntry(entry: BatchEntry): void {
    this.entries.update((list) => [...list, entry]);
    this.selectFile(this.entries().length - 1);
  }

  private formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }
}
