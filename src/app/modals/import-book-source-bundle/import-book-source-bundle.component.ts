/**
 * 导入书源 bundle 预览（弹窗内容组件，Phase 1，设计 §5.2 / §5.3 / §6.4）
 *
 * 流程：
 *  1. 打开即调 pom:booksource-bundle-open → 主进程 showOpenDialog + parseBundle + diffBundle
 *     - null            = 用户取消选文件 → 直接关弹窗
 *     - error 非 null   = parseBundle 整体拒绝 → 展示原因并停留（不进入预览）
 *     - 否则取 entries  → 进入预览
 *  2. 每条 content 渲染端再过一次 BookSourceDocSchema（valibot，设计 §4.2 双保险）取名称/标签等
 *     meta；parse 失败的条目标记为损坏：不可勾选、不计入统计
 *  3. 按 new / update / conflict / identical 分组（本地导入实际只会出现前三类，UI 四类都支持）：
 *     new / update 默认勾选，conflict 默认不勾，identical 灰显不可勾且不计入统计（§8 取舍 4）
 *  4. 确认 → pom:booksource-bundle-apply(decisions) → toast written/failed 结果 → 关弹窗刷新列表
 */
import { Component, inject, signal, ChangeDetectionStrategy, computed } from '@angular/core';

import { NZ_MODAL_DATA, NzModalRef } from 'ng-zorro-antd/modal';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzCheckboxModule } from 'ng-zorro-antd/checkbox';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { NzSpinModule } from 'ng-zorro-antd/spin';
import { NzTagModule } from 'ng-zorro-antd/tag';
import { NzAlertModule } from 'ng-zorro-antd/alert';
import * as v from 'valibot';
import { BookSourceDocSchema } from '../../core/models/book-source-doc.model';
import { ToastService } from '../../core/services/toast.service';

type DiffKind = BookSourceBundleDiffEntry['kind'];

/** 预览条目 = DiffEntry + 渲染端 valibot parse 出的展示 meta */
export interface BundlePreviewItem {
  kind: DiffKind;
  fileName: string;
  uuid: string;
  content: string;
  /** parse 成功时为 doc.name；损坏条目为 null（UI 回退展示 fileName） */
  name: string | null;
  author?: string;
  tags: string[];
  /** content 未通过 BookSourceDocSchema（双保险；主进程 parseBundle 已整体拒绝过，正常不会命中） */
  corrupted: boolean;
}

interface ModalData {
  /** 导入完成后父组件回调（用于刷新书源列表） */
  onImported?: () => void;
}

type Phase = 'loading' | 'error' | 'preview';

/** 分组顺序与标签（identical 垫底；conflict 仅订阅场景出现，排在 update 后） */
const GROUP_DEFS: readonly { kind: DiffKind; label: string; color: string }[] = [
  { kind: 'new', label: '新增', color: 'green' },
  { kind: 'update', label: '更新（覆盖本地）', color: 'blue' },
  { kind: 'conflict', label: '冲突（本地已修改）', color: 'orange' },
  { kind: 'identical', label: '与本地一致', color: 'default' },
];

function pomApi(): PomBookSourceBundleApi | null {
  if (typeof window === 'undefined') return null;
  return (window.pomAPI as unknown as PomBookSourceBundleApi | undefined) ?? null;
}

/** content → valibot parse 取展示 meta；JSON 非法或 schema 校验失败 → 损坏条目 */
export function toPreviewItem(entry: BookSourceBundleDiffEntry): BundlePreviewItem {
  const base: BundlePreviewItem = {
    kind: entry.kind,
    fileName: entry.fileName,
    uuid: entry.uuid,
    content: entry.content,
    name: null,
    tags: [],
    corrupted: true,
  };
  try {
    const parsed = v.safeParse(BookSourceDocSchema, JSON.parse(entry.content));
    if (!parsed.success) return base;
    const doc = parsed.output;
    return { ...base, name: doc.name, author: doc.author, tags: doc.tags, corrupted: false };
  } catch {
    return base;
  }
}

/** 是否可勾选：identical 灰显不可勾、损坏条目不可勾（两者也都不计入统计） */
export function isSelectable(item: BundlePreviewItem): boolean {
  return !item.corrupted && item.kind !== 'identical';
}

@Component({
  selector: 'app-import-book-source-bundle',
  changeDetection: ChangeDetectionStrategy.OnPush,
  preserveWhitespaces: true,
  imports: [
    NzButtonModule,
    NzCheckboxModule,
    NzIconModule,
    NzSpinModule,
    NzTagModule,
    NzAlertModule,
  ],
  templateUrl: './import-book-source-bundle.component.html',
  styles: [
    `
      .import-bundle {
        display: flex;
        flex-direction: column;
        gap: 12px;
        min-width: 560px;
        max-height: 70vh;
      }
      .hint {
        color: var(--pom-text-muted);
        font-size: 12px;
        margin: 0;
      }
      .group-title {
        font-weight: 600;
        margin: 4px 0 0;
      }
      .source-list {
        list-style: none;
        padding: 0;
        margin: 0;
        overflow: auto;
        max-height: 40vh;
        border: 1px solid var(--pom-border-soft);
        border-radius: 4px;
      }
      .source-item {
        padding: 8px 12px;
        border-bottom: 1px solid var(--pom-border-soft);
      }
      .source-item:last-child {
        border-bottom: none;
      }
      .source-item.disabled {
        opacity: 0.6;
      }
      .source-row {
        display: flex;
        gap: 8px;
        align-items: center;
      }
      .source-name {
        font-weight: 500;
      }
      .source-meta {
        flex: 1;
        color: var(--pom-text-muted);
        font-size: 12px;
      }
      .actions {
        display: flex;
        gap: 8px;
        justify-content: flex-end;
        align-items: center;
      }
      .select-hint {
        margin-right: auto;
        color: var(--pom-text-muted);
        font-size: 12px;
      }
    `,
  ],
})
export class ImportBookSourceBundleComponent {
  private readonly data = inject<ModalData>(NZ_MODAL_DATA);
  private readonly modalRef = inject(NzModalRef, { optional: true });
  private readonly toast = inject(ToastService);

  protected readonly phase = signal<Phase>('loading');
  /** parseBundle 整体拒绝原因（phase === 'error' 时展示） */
  protected readonly errorMsg = signal('');
  protected readonly applying = signal(false);
  protected readonly items = signal<BundlePreviewItem[]>([]);
  protected readonly selectedFileNames = signal<Set<string>>(new Set());

  protected readonly groupDefs = GROUP_DEFS;

  /** 按 kind 分组（固定顺序 new → update → conflict → identical），空组不渲染 */
  protected readonly groups = computed(() =>
    GROUP_DEFS.map((def) => ({
      ...def,
      items: this.items().filter((i) => i.kind === def.kind),
    })).filter((g) => g.items.length > 0),
  );

  /** 统计基数：可勾选条目（identical 与损坏条目不计入，§5.3 / §8 取舍 4） */
  protected readonly totalCount = computed(() => this.items().filter(isSelectable).length);
  /** 将写入条数 = 已勾选数（勾选集只含可勾选条目） */
  protected readonly selectedCount = computed(() => this.selectedFileNames().size);
  protected readonly corruptedCount = computed(
    () => this.items().filter((i) => i.corrupted).length,
  );

  constructor() {
    void this.open();
  }

  /** 打开选文件对话框（主进程）→ 解析 + diff → 进入预览 */
  protected async open(): Promise<void> {
    const api = pomApi();
    if (!api?.booksourceBundleOpen) {
      this.errorMsg.set('IPC 不可用');
      this.phase.set('error');
      return;
    }
    try {
      const result = await api.booksourceBundleOpen();
      if (result === null) {
        // 用户取消选文件：无需提示，直接关弹窗
        this.modalRef?.close();
        return;
      }
      if (result.error !== null) {
        this.errorMsg.set(result.error);
        this.phase.set('error');
        return;
      }
      const items = result.entries.map(toPreviewItem);
      this.items.set(items);
      // 默认勾选：new / update 勾、conflict 不勾；identical / 损坏条目本就不可勾
      this.selectedFileNames.set(
        new Set(
          items
            .filter((i) => isSelectable(i) && (i.kind === 'new' || i.kind === 'update'))
            .map((i) => i.fileName),
        ),
      );
      this.phase.set('preview');
    } catch (e) {
      this.errorMsg.set((e as Error).message ?? String(e));
      this.phase.set('error');
    }
  }

  protected isSelected(item: BundlePreviewItem): boolean {
    return this.selectedFileNames().has(item.fileName);
  }

  protected toggle(item: BundlePreviewItem): void {
    if (!isSelectable(item)) return;
    const next = new Set(this.selectedFileNames());
    if (next.has(item.fileName)) next.delete(item.fileName);
    else next.add(item.fileName);
    this.selectedFileNames.set(next);
  }

  /** 确认导入：勾选条目 → apply → toast written/failed（§8 取舍 1：批量非原子，失败收集报告） */
  protected async apply(): Promise<void> {
    const api = pomApi();
    if (!api?.booksourceBundleApply) {
      this.toast.error('IPC 不可用');
      return;
    }
    const decisions = this.items()
      .filter((i) => this.selectedFileNames().has(i.fileName))
      .map((i) => ({ fileName: i.fileName, content: i.content }));
    if (decisions.length === 0) return;
    this.applying.set(true);
    try {
      const result = await api.booksourceBundleApply(decisions);
      if (result.failed.length > 0) {
        this.toast.error(
          `已写入 ${result.written.length} 个，失败 ${result.failed.length} 个：${result.failed
            .map((f) => `${f.fileName}（${f.error}）`)
            .join('、')}`,
        );
      } else {
        this.toast.success(`已导入 ${result.written.length} 个书源`);
      }
      this.data?.onImported?.();
      this.modalRef?.close();
    } catch (e) {
      this.toast.error(`导入失败：${(e as Error).message ?? String(e)}`);
    } finally {
      this.applying.set(false);
    }
  }

  protected cancel(): void {
    this.modalRef?.close();
  }
}
