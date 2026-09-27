import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GlobalErrorHandler } from './global-error-handler';

/**
 * GlobalErrorHandler spec — v1.1 §15.1 全局异常兜底
 *
 * 覆盖：错误消息提取的多分支逻辑（Error / string / Angular 包装对象 / 嵌套 ngOriginalError）
 * - 不可变 toast.error 调用契约
 * - console.error 埋点格式
 * - 消息 100 字符截断
 */

describe('GlobalErrorHandler', () => {
  let handler: GlobalErrorHandler;
  let toastErrorSpy: ReturnType<typeof vi.fn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    toastErrorSpy = vi.fn();
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // Object.create + 手动注入 toast（绕开 Angular DI）
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler = Object.create(GlobalErrorHandler.prototype) as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (handler as any).toast = { error: toastErrorSpy };
  });

  it('Error 实例应提取 message + stack', () => {
    const e = new Error('boom');
    handler.handleError(e);
    expect(toastErrorSpy).toHaveBeenCalledWith('出错了：boom');
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[GlobalErrorHandler]',
      'boom',
      '\n',
      expect.stringContaining('boom'),
    );
  });

  it('string 错误应直接作为 message', () => {
    handler.handleError('plain string error');
    expect(toastErrorSpy).toHaveBeenCalledWith('出错了：plain string error');
  });

  it('Angular 18 错误对象（同时含 message + ngOriginalError）应优先用顶层 message', () => {
    // 实现语义：顶层 message 优先（else-if 链）→ wrapper msg
    const angularError = {
      name: 'Error',
      message: 'wrapper msg',
      stack: 'wrapper stack',
      ngOriginalError: {
        message: 'original msg',
        stack: 'original stack',
      },
    };
    handler.handleError(angularError);
    expect(toastErrorSpy).toHaveBeenCalledWith('出错了：wrapper msg');
  });

  it('object 无顶层 message 但有 ngOriginalError 时应 unwrap 原始 message + stack', () => {
    const angularError = {
      ngOriginalError: {
        message: 'unwrapped msg',
        stack: 'unwrapped stack',
      },
    };
    handler.handleError(angularError);
    expect(toastErrorSpy).toHaveBeenCalledWith('出错了：unwrapped msg');
    const call = consoleErrorSpy.mock.calls[0];
    expect(call[3]).toBe('unwrapped stack');
  });

  it('普通 object（无 message / ngOriginalError）应 fallback 到 JSON.stringify 截断 300', () => {
    const obj = { foo: 'bar', baz: 123 };
    handler.handleError(obj);
    expect(toastErrorSpy).toHaveBeenCalledWith(expect.stringContaining('"foo":"bar"'));
  });

  it('object 带 stack 无 message 应取 stack 作为 details', () => {
    const obj = { stack: 'just a stack trace' };
    handler.handleError(obj);
    expect(toastErrorSpy).toHaveBeenCalledWith('出错了：未知错误');
    const call = consoleErrorSpy.mock.calls[0];
    expect(call[3]).toBe('just a stack trace');
  });

  it('null / undefined 应使用未知错误 message', () => {
    handler.handleError(null);
    expect(toastErrorSpy).toHaveBeenCalledWith('出错了：未知错误');

    handler.handleError(undefined);
    expect(toastErrorSpy).toHaveBeenLastCalledWith('出错了：未知错误');
  });

  it('toast message 应截断到 100 字符', () => {
    const longMsg = 'x'.repeat(500);
    handler.handleError(longMsg);
    expect(toastErrorSpy).toHaveBeenCalledWith(`出错了：${'x'.repeat(100)}`);
  });

  it('错误格式化抛错时（如 message 是有 toString 抛错的 Symbol）应 fallback "错误格式化失败"', () => {
    const evilObj = {
      // toString 抛错 → 外层 try-catch 兜底
      toString: () => {
        throw new Error('toString boom');
      },
      // 提供对象访问路径但访问时也抛错
      get message() {
        throw new Error('message access boom');
      },
    };
    handler.handleError(evilObj);
    expect(toastErrorSpy).toHaveBeenCalledWith('出错了：错误格式化失败');
  });
});