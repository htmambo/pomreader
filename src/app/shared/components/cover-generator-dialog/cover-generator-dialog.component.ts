import { Component, inject, signal, computed, OnInit, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { NZ_MODAL_DATA, NzModalRef } from 'ng-zorro-antd/modal';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { NzSpinModule } from 'ng-zorro-antd/spin';
import { Book } from '../../../core/models/book.model';
import { BUILTIN_COVER_GENERATORS } from '../../../core/cover/generators/builtin';

interface CoverGeneratorData {
  book: Book;
}

interface PreviewItem {
  id: string;
  name: string;
  description: string;
  status: 'pending' | 'generating' | 'ready' | 'error';
  coverUrl: string;
  error: string;
}

/**
 * 生成封面 Dialog — 两段式交互
 * 1. 点击缩略图选中（边框高亮 + 选中标记）
 * 2. 点底部「应用封面」按钮确认；「取消」放弃
 * 缩略图比例 = 书架封面 5:7（width/height aspect-ratio），object-fit: cover 与书架一致
 */
@Component({
  selector: 'app-cover-generator-dialog',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, NzButtonModule, NzIconModule, NzSpinModule],
  template: `
    <div class="cg-dialog">
      <div class="cg-summary">
        <div class="cg-summary__cover">
          @if (book.coverImageUrl) {
            <img [src]="book.coverImageUrl" [alt]="book.title" />
          } @else {
            <span class="cg-empty-cover">暂无封面</span>
          }
        </div>
        <div class="cg-summary__meta">
          <h3>{{ book.title }}</h3>
          <p>{{ book.author || '佚名' }}</p>
          <p>共 {{ totalCount() }} 款内置封面，已生成 {{ readyCount() }} 款</p>
        </div>
        <button
          nz-button
          nzType="default"
          [disabled]="generating()"
          (click)="regenerate()"
          class="cg-regen"
        >
          <span nz-icon nzType="reload"></span>
          重新生成
        </button>
      </div>

      <section class="cg-grid">
        @for (item of previews(); track item.id) {
          <article
            class="cg-card"
            [class.cg-card--selected]="selectedId() === item.id"
            [class.cg-card--disabled]="item.status !== 'ready'"
            (click)="select(item)"
          >
            <div class="cg-card__preview">
              @if (item.coverUrl) {
                <img [src]="item.coverUrl" [alt]="item.name" loading="lazy" />
              } @else if (item.status === 'generating') {
                <div class="cg-card__state"><nz-spin nzSimple></nz-spin><span>生成中</span></div>
              } @else if (item.status === 'error') {
                <div class="cg-card__state cg-card__state--error"><span>生成失败</span></div>
              } @else {
                <div class="cg-card__state"><span>等待生成</span></div>
              }
              @if (selectedId() === item.id) {
                <div class="cg-card__badge">
                  <span nz-icon nzType="check"></span>
                </div>
              }
            </div>
            <div class="cg-card__body">
              <h4>{{ item.name }}</h4>
              <p>{{ item.error || item.description }}</p>
            </div>
          </article>
        }
      </section>

      <footer class="cg-footer">
        <div class="cg-footer__hint">
          @if (selectedItem(); as sel) {
            已选中：{{ sel.name }}
          } @else {
            点击缩略图选中一款封面
          }
        </div>
        <div class="cg-footer__actions">
          <button nz-button nzType="default" (click)="cancel()">取消</button>
          <button
            nz-button
            nzType="primary"
            [disabled]="!selectedItem()"
            (click)="confirm()"
          >
            <span nz-icon nzType="check"></span>
            应用封面
          </button>
        </div>
      </footer>
    </div>
  `,
  styles: [
    `
      :host { display: block; }
      .cg-dialog {
        display: flex;
        flex-direction: column;
        /* 占满 modal 内容区，确保 footer 永远可见 */
        height: 72vh;
        max-height: 72vh;
      }
      .cg-summary {
        display: grid;
        grid-template-columns: 64px minmax(0, 1fr) auto;
        gap: 12px;
        align-items: center;
        padding-bottom: 12px;
        border-bottom: 1px solid var(--pom-border);
        flex: 0 0 auto;
      }
      .cg-summary__cover {
        /* 与书架封面比例一致 5:7 — 用显式 height 而非 aspect-ratio（防止 grid 嵌套失效） */
        width: 64px;
        height: 90px; /* 64 * 7/5 ≈ 90 */
        overflow: hidden;
        border-radius: 6px;
        background: rgba(0, 0, 0, 0.06);
        display: flex; align-items: center; justify-content: center;
        color: var(--pom-text-muted);
        font-size: 12px;
        flex: 0 0 auto;
      }
      .cg-summary__cover img {
        width: 100%; height: 100%;
        /* 与书架 cover-img 一致：填满裁切（避免 contain 留白） */
        object-fit: cover;
        display: block;
      }
      .cg-summary__meta h3 { margin: 0 0 4px; font-size: 16px; color: var(--pom-text); }
      .cg-summary__meta p { margin: 0; color: var(--pom-text-muted); font-size: 12px; }
      .cg-regen { flex: 0 0 auto; }

      .cg-grid {
        flex: 1 1 auto;
        overflow-y: auto;
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
        gap: 14px;
        padding: 14px 4px;
        min-height: 0; /* 关键：让 grid 在 flex 容器内可收缩 */
      }
      .cg-card {
        border: 2px solid var(--pom-border);
        border-radius: 8px;
        /* 注意：不能加 overflow:hidden — 会裁掉 .cg-card__preview 的 padding-bottom 高度
           圆角裁切由 .cg-card__preview 自身的 border-radius + overflow:hidden 负责 */
        background: var(--pom-bg);
        display: flex; flex-direction: column;
        cursor: pointer;
        transition: border-color 0.15s, box-shadow 0.15s, transform 0.15s;
      }
      .cg-card:hover { transform: translateY(-2px); box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12); }
      .cg-card--selected {
        border-color: #177ddc;
        box-shadow: 0 0 0 2px rgba(23, 125, 220, 0.2);
      }
      .cg-card--disabled {
        cursor: not-allowed;
        opacity: 0.6;
      }
      .cg-card--disabled:hover { transform: none; box-shadow: none; }

      .cg-card__preview {
        width: 100%;
        /* 显式高度（padding-bottom 140% = 5:7 比例），比 aspect-ratio 在 grid 嵌套下更可靠 */
        position: relative;
        height: 0;
        padding-bottom: 140%; /* 100% * 7/5 = 140% */
        background: rgba(0, 0, 0, 0.04);
        /* 圆角裁切（顶部与 .cg-card 圆角对齐） */
        overflow: hidden;
        border-radius: 6px 6px 0 0;
      }
      .cg-card__preview img {
        position: absolute;
        inset: 0;
        width: 100%; height: 100%;
        object-fit: cover;
        display: block;
      }
      .cg-card__state {
        position: absolute;
        inset: 0;
        display: flex; flex-direction: column; gap: 6px;
        align-items: center; justify-content: center;
        color: var(--pom-text-muted);
        font-size: 12px;
      }
      .cg-card__state--error { color: #cf1322; }

      .cg-card__badge {
        position: absolute;
        top: 8px; right: 8px;
        width: 28px; height: 28px;
        border-radius: 50%;
        background: #177ddc;
        color: #ffffff;
        display: flex; align-items: center; justify-content: center;
        font-size: 16px;
        box-shadow: 0 2px 6px rgba(0, 0, 0, 0.25);
      }

      .cg-card__body { padding: 8px 10px; display: flex; flex-direction: column; gap: 4px; }
      .cg-card__body h4 {
        margin: 0; font-size: 13px; color: var(--pom-text);
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .cg-card__body p {
        margin: 0; color: var(--pom-text-muted); font-size: 11px;
        display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
      }

      .cg-footer {
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding-top: 12px;
        border-top: 1px solid var(--pom-border);
        background: var(--pom-bg);
      }
      .cg-footer__hint {
        color: var(--pom-text-muted);
        font-size: 12px;
      }
      .cg-footer__actions { display: flex; gap: 8px; }
    `,
  ],
})
export class CoverGeneratorDialogComponent implements OnInit {
  protected readonly data = inject<CoverGeneratorData>(NZ_MODAL_DATA);
  private readonly modalRef = inject(NzModalRef);

  protected readonly book: Book = this.data.book;
  protected readonly previews = signal<PreviewItem[]>([]);
  protected readonly selectedId = signal<string>('');
  private runId = 0;

  protected readonly readyCount = computed(
    () => this.previews().filter((p) => p.status === 'ready').length,
  );
  protected readonly generating = computed(() =>
    this.previews().some((p) => p.status === 'generating'),
  );
  protected readonly totalCount = computed(() => this.previews().length);
  protected readonly selectedItem = computed(() =>
    this.previews().find((p) => p.id === this.selectedId() && p.status === 'ready'),
  );

  ngOnInit(): void {
    void this.generatePreviews(false);
  }

  regenerate(): void {
    this.selectedId.set('');
    void this.generatePreviews(true);
  }

  select(item: PreviewItem): void {
    if (item.status !== 'ready') return;
    // 再次点击已选中的卡 → 取消选中
    this.selectedId.set(this.selectedId() === item.id ? '' : item.id);
  }

  cancel(): void {
    this.modalRef.close(undefined);
  }

  /** 点底部「应用封面」→ 关闭并把选中 data URL 传给调用方 */
  confirm(): void {
    const sel = this.selectedItem();
    if (!sel) return;
    this.modalRef.close({ coverUrl: sel.coverUrl, generatorName: sel.name });
  }

  private async generatePreviews(force: boolean): Promise<void> {
    if (!force && this.previews().length > 0) return;
    this.runId += 1;
    const myRun = this.runId;
    this.previews.set(
      BUILTIN_COVER_GENERATORS.map((g) => ({
        id: g.id,
        name: g.name,
        description: g.description,
        status: 'pending' as const,
        coverUrl: '',
        error: '',
      })),
    );

    // 逐个生成 + 让出主线程，避免一次性阻塞 UI
    for (const gen of BUILTIN_COVER_GENERATORS) {
      if (myRun !== this.runId) return;
      this.previews.update((list) =>
        list.map((p) => (p.id === gen.id ? { ...p, status: 'generating' as const, error: '' } : p)),
      );
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      try {
        const coverUrl = gen.generate({
          title: this.book.title,
          author: this.book.author,
          // 传入书籍题材；undefined 时各模板用自己的 fallback 文案
          ...(this.book.kind ? { kind: this.book.kind } : {}),
        });
        if (myRun !== this.runId) return;
        this.previews.update((list) =>
          list.map((p) =>
            p.id === gen.id ? { ...p, status: 'ready' as const, coverUrl } : p,
          ),
        );
      } catch (e) {
        if (myRun !== this.runId) return;
        this.previews.update((list) =>
          list.map((p) =>
            p.id === gen.id
              ? {
                  ...p,
                  status: 'error' as const,
                  error: e instanceof Error ? e.message : String(e),
                }
              : p,
          ),
        );
      }
    }
  }
}
