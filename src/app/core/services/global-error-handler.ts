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
    // 尝试多种方式提取错误信息（Angular 18 错误可能包装在多层对象中）
    let msg = '未知错误';
    let details = '';
    try {
      if (error instanceof Error) {
        msg = error.message;
        details = error.stack ?? '';
      } else if (typeof error === 'string') {
        msg = error;
      } else if (error && typeof error === 'object') {
        // Angular 18 错误对象常见结构：{ name, message, stack, ngOriginalError, ngErrorLogger }
        const e = error as Record<string, unknown>;
        if (typeof e['message'] === 'string') msg = e['message'] as string;
        else if (typeof e['ngOriginalError'] === 'object') {
          const orig = e['ngOriginalError'] as Record<string, unknown>;
          if (typeof orig['message'] === 'string') msg = orig['message'] as string;
          if (typeof orig['stack'] === 'string') details = orig['stack'] as string;
        } else if (typeof e['stack'] === 'string') {
          details = e['stack'] as string;
        } else {
          msg = JSON.stringify(error).slice(0, 300);
        }
      }
    } catch {
      msg = '错误格式化失败';
    }
    // eslint-disable-next-line no-console
    console.error('[GlobalErrorHandler]', msg, '\n', details);
    this.toast.error(`出错了：${msg.slice(0, 100)}`);
  }
}