import { Component, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { NZ_MODAL_DATA } from 'ng-zorro-antd/modal';
import { NzInputModule } from 'ng-zorro-antd/input';
import { Book } from '../../core/models/book.model';

interface EditBookInfoData {
  book: Book;
}

export interface EditBookInfoResult {
  title: string;
  author: string;
  sourceUrl?: string;
  coverColor: string;
  coverImageUrl?: string;
}

/**
 * 编辑书籍元信息（书名 / 作者 / 源地址）— modal 内容组件
 * 由 reader.component.openEditBookInfoDialog 通过 NzModalService.create 弹出
 * nzOnOk 回调里调 instance.result() 拿用户编辑结果（null = 无效输入）
 */
@Component({
  selector: 'app-edit-book-info-dialog',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, NzInputModule],
  template: `
    <div class="edit-book-form">
      <p style="margin: 0 0 8px; color: var(--pom-text-muted); font-size: 12px;">
        修改当前书籍的书名 / 作者 / 源地址（不影响章节内容）
      </p>

      <label class="field-label">书名</label>
      <input
        nz-input
        [(ngModel)]="title"
        placeholder="请输入书名"
        [nzStatus]="titleError() ? 'error' : ''"
        maxlength="120"
      />

      <label class="field-label">作者</label>
      <input
        nz-input
        [(ngModel)]="author"
        placeholder="请输入作者"
        [nzStatus]="authorError() ? 'error' : ''"
        maxlength="60"
      />

      <label class="field-label">源地址 <span style="color: var(--pom-text-muted); font-weight: normal;">(可选)</span></label>
      <input
        nz-input
        [(ngModel)]="sourceUrl"
        placeholder="https:// ... （在线书填源 URL，本地导入留空）"
      />

      <label class="field-label">
        封面图片 URL
        <span style="color: var(--pom-text-muted); font-weight: normal;">
          (可选；留空则用下方"封面颜色"渲染 SVG)
        </span>
      </label>
      <input
        nz-input
        [(ngModel)]="coverImageUrl"
        placeholder="https:// ... （在线书可填源站封面图）"
      />

      <label class="field-label">封面颜色</label>
      <div class="cover-color-row">
        <input
          type="color"
          class="cover-color-input"
          [(ngModel)]="coverColor"
          aria-label="封面颜色"
        />
        <div class="cover-swatches">
          @for (preset of PRESET_COLORS; track preset) {
            <button
              type="button"
              class="cover-swatch"
              [style.background]="preset"
              [class.active]="preset.toLowerCase() === coverColor.toLowerCase()"
              (click)="coverColor = preset"
              [attr.aria-label]="'选择颜色 ' + preset"
            ></button>
          }
        </div>
        <input
          nz-input
          class="cover-color-hex"
          [(ngModel)]="coverColor"
          (ngModelChange)="onCoverColorChange($event)"
          placeholder="#177ddc"
          maxlength="7"
        />
      </div>
    </div>
  `,
  styles: [
    `
      .edit-book-form .field-label {
        display: block;
        margin: 12px 0 4px;
        font-size: 13px;
        color: var(--pom-text);
        font-weight: 600;
      }
      .edit-book-form .field-label:first-of-type {
        margin-top: 4px;
      }
      .edit-book-form input[nz-input] {
        width: 100%;
      }
      .cover-color-row {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .cover-color-input {
        width: 40px;
        height: 32px;
        border: 1px solid var(--pom-border);
        border-radius: 4px;
        padding: 0;
        cursor: pointer;
        background: transparent;
      }
      .cover-swatches {
        display: flex;
        gap: 4px;
        flex-wrap: wrap;
        flex: 1;
      }
      .cover-swatch {
        width: 22px;
        height: 22px;
        border-radius: 50%;
        border: 2px solid transparent;
        cursor: pointer;
        padding: 0;
        outline: none;
      }
      .cover-swatch.active {
        border-color: var(--pom-text);
        box-shadow: 0 0 0 1px var(--pom-bg);
      }
      .cover-color-hex {
        width: 90px !important;
        flex: 0 0 auto;
      }
    `,
  ],
})
export class EditBookInfoDialogComponent {
  /** 8 个预设封面色板（点击快速选择） */
  protected readonly PRESET_COLORS = [
    '#177ddc', // 蓝（在线默认）
    '#8b4513', // 棕（本地默认）
    '#52c41a', // 绿
    '#fa8c16', // 橙
    '#eb2f96', // 粉
    '#722ed1', // 紫
    '#13c2c2', // 青
    '#595959', // 灰
  ];

  protected readonly data = inject<EditBookInfoData>(NZ_MODAL_DATA);
  protected readonly titleError = signal(false);
  protected readonly authorError = signal(false);

  protected title = this.data.book.title;
  protected author = this.data.book.author;
  protected sourceUrl = this.data.book.sourceUrl ?? '';
  protected coverImageUrl = this.data.book.coverImageUrl ?? '';
  protected coverColor = this.data.book.coverColor;

  /** 手动输入框实时小写化（color picker 输出小写，避免大小写闪烁） */
  onCoverColorChange(value: string): void {
    if (typeof value === 'string') this.coverColor = value.toLowerCase();
  }

  /** nzOnOk 回调：返回用户编辑结果（null = 输入无效） */
  result(): EditBookInfoResult | null {
    const t = this.title.trim();
    const a = this.author.trim();
    const u = this.sourceUrl.trim();
    const img = this.coverImageUrl.trim();
    const c = this.coverColor.trim();

    this.titleError.set(t.length === 0);
    this.authorError.set(a.length === 0);

    if (t.length === 0 || a.length === 0) return null;

    // 颜色：标准化为小写 hex（#rrggbb），无效则 fallback 当前色
    const color = /^#[0-9a-fA-F]{6}$/.test(c) ? c.toLowerCase() : this.data.book.coverColor;

    const result: EditBookInfoResult = { title: t, author: a, coverColor: color };
    if (u) result.sourceUrl = u;
    if (img) result.coverImageUrl = img;
    return result;
  }
}
