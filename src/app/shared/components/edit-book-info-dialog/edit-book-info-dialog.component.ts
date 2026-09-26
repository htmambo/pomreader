import { Component, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { NZ_MODAL_DATA } from 'ng-zorro-antd/modal';
import { NzInputModule } from 'ng-zorro-antd/input';
import { Book } from '../../../core/models/book.model';

interface EditBookInfoData {
  book: Book;
}

export interface EditBookInfoResult {
  title: string;
  author: string;
  sourceUrl?: string;
  kind?: string;
  coverImageUrl?: string;
}

/**
 * 编辑书籍元信息（书名 / 作者 / 源地址 / 封面）— modal 内容组件
 * 入口：书卡右键菜单「编辑书籍信息」（bookshelf 通过 NzModalService.create 弹出）
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

      <div class="book-times">
        <span>入库时间：{{ formatTime(data.book.importedAt) }}</span>
        <span>最后阅读：{{ data.book.lastReadAt ? formatTime(data.book.lastReadAt) : '尚未阅读' }}</span>
      </div>

      <div class="field-row">
        <label class="field-label">书名</label>
        <input
          nz-input
          [(ngModel)]="title"
          placeholder="请输入书名"
          [nzStatus]="titleError() ? 'error' : ''"
          maxlength="120"
        />
      </div>

      <div class="field-row">
        <label class="field-label">作者</label>
        <input
          nz-input
          [(ngModel)]="author"
          placeholder="请输入作者"
          [nzStatus]="authorError() ? 'error' : ''"
          maxlength="60"
        />
      </div>

      <div class="field-row">
        <label class="field-label">源地址</label>
        <input
          nz-input
          [(ngModel)]="sourceUrl"
          placeholder="https:// ... （在线书填源 URL，本地导入留空）"
        />
      </div>
      <p class="field-hint">(可选)</p>

      <div class="field-row">
        <label class="field-label">题材/类型</label>
        <input
          nz-input
          [(ngModel)]="kind"
          placeholder="留空则各封面模板用自身默认风格"
          maxlength="20"
        />
      </div>
      <p class="field-hint">(可选；用于「生成封面」选择模板风格，如：玄幻 / 言情 / 科幻 / 武侠 / 悬疑)</p>

      <div class="field-row">
        <label class="field-label">封面图片 URL</label>
        <input
          nz-input
          [(ngModel)]="coverImageUrl"
          placeholder="https:// ... （在线书可填源站封面图）"
        />
      </div>
      <p class="field-hint">(可选；留空则显示「暂无封面」占位)</p>
    </div>
  `,
  styles: [
    `
      .book-times {
        display: flex;
        gap: 16px;
        flex-wrap: wrap;
        margin: 0 0 4px;
        padding: 6px 10px;
        border-radius: 4px;
        background: var(--pom-bg);
        font-size: 12px;
        color: var(--pom-text-muted);
      }
      .edit-book-form .field-row {
        display: flex;
        align-items: center;
        gap: 8px;
        margin: 12px 0 0;
      }
      /* 显式声明 width/margin/text-align，覆盖 rules-panel.scss 中泄漏的全局 .field-label 规则 */
      .edit-book-form .field-label {
        flex: 0 0 92px;
        width: 92px;
        margin: 0;
        font-size: 13px;
        color: var(--pom-text);
        font-weight: 600;
        text-align: right;
      }
      .edit-book-form .field-hint {
        margin: 2px 0 0;
        font-size: 12px;
        color: var(--pom-text-muted);
      }
      .edit-book-form input[nz-input] {
        width: 100%;
      }
    `,
  ],
})
export class EditBookInfoDialogComponent {
  protected readonly data = inject<EditBookInfoData>(NZ_MODAL_DATA);
  protected readonly titleError = signal(false);
  protected readonly authorError = signal(false);

  protected title = this.data.book.title;
  protected author = this.data.book.author;
  protected sourceUrl = this.data.book.sourceUrl ?? '';
  protected kind = this.data.book.kind ?? '';
  protected coverImageUrl = this.data.book.coverImageUrl ?? '';

  /** ISO 时间 → 本地可读格式（无效值原样返回） */
  formatTime(iso: string): string {
    const d = new Date(iso);
    return isNaN(d.getTime()) ? iso : d.toLocaleString('zh-CN', { hour12: false });
  }

  /** nzOnOk 回调：返回用户编辑结果（null = 输入无效） */
  result(): EditBookInfoResult | null {
    const t = this.title.trim();
    const a = this.author.trim();
    const u = this.sourceUrl.trim();
    const k = this.kind.trim();
    const img = this.coverImageUrl.trim();

    this.titleError.set(t.length === 0);
    this.authorError.set(a.length === 0);

    if (t.length === 0 || a.length === 0) return null;

    const result: EditBookInfoResult = { title: t, author: a };
    if (u) result.sourceUrl = u;
    if (k) result.kind = k;
    if (img) result.coverImageUrl = img;
    return result;
  }
}
