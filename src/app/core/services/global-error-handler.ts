import { ErrorHandler, Injectable, inject } from '@angular/core';
import { ToastService } from './toast.service';

/**
 * GlobalErrorHandler — v1.1 §15.1 自定义全局异常兜底
 * 捕获未处理异常 → ToastService.error() + 控制台埋点；UI 不白屏
 */
@Injectable()
export class GlobalErrorHandler implements ErrorHandler {
  private readonly toast = inject(ToastService);

  handleError(error: unknown): void {
    // eslint-disable-next-line no-console
    console.error('[GlobalErrorHandler]', error);
    const msg = error instanceof Error ? error.message : String(error);
    this.toast.error(`出错了：${msg}`);
  }
}