import { Injectable, inject } from '@angular/core';
import { NzMessageService } from 'ng-zorro-antd/message';

/**
 * ToastService — 全局消息提示
 * v1.1 §15.1：mock 失败 / 全局异常时给用户明确反馈
 */
@Injectable({ providedIn: 'root' })
export class ToastService {
  private readonly nz = inject(NzMessageService);

  info(msg: string): void {
    this.nz.info(msg);
  }
  success(msg: string): void {
    this.nz.success(msg);
  }
  warn(msg: string): void {
    this.nz.warning(msg);
  }
  error(msg: string): void {
    this.nz.error(msg);
  }
}