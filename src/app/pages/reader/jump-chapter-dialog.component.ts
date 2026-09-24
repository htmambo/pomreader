import { Component, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { NZ_MODAL_DATA } from 'ng-zorro-antd/modal';
import { NzInputNumberModule } from 'ng-zorro-antd/input-number';

interface JumpDialogData {
  current: number;
  total: number;
}

/**
 * 跳转到指定章节 — modal 内容组件
 * 由 reader.component 的 openJumpDialog 通过 NzModalService.create 弹出
 * nzOnOk 回调里调 instance.target() 拿用户输入
 */
@Component({
  selector: 'app-jump-chapter-dialog',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, NzInputNumberModule],
  template: `
    <p style="margin-bottom: 8px; color: var(--pom-text-muted);">
      当前：第 {{ data.current }} / {{ data.total }} 章
    </p>
    <nz-input-number
      [(ngModel)]="value"
      [nzMin]="1"
      [nzMax]="data.total"
      [nzStep]="1"
      nzPlaceHolder="输入章节号"
      style="width: 100%;"
    ></nz-input-number>
  `,
})
export class JumpChapterDialogComponent {
  protected readonly data = inject<JumpDialogData>(NZ_MODAL_DATA);
  /** 用户输入的章节号（1-based） */
  protected value: number | null = this.data.current;

  /** nzOnOk 回调用：返回用户输入（null = 无效输入） */
  target(): number | null {
    if (this.value == null || !Number.isFinite(this.value)) return null;
    return Math.floor(this.value);
  }
}
