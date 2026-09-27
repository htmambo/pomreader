import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as v from 'valibot';
import {
  safeHandle,
  safeHandleWithMeta,
  registeredSchemas,
  IpcValidationError,
  FetchHtmlArgsSchema,
  SetFetchUaArgsSchema,
  SetWebviewEncodingArgsSchema,
} from './schema';

/**
 * safeHandle + 4 个 schema 的契约 spec
 *
 * 覆盖：
 * - safeHandle 行为：rest args 收集、schema parse 失败抛 IpcValidationError
 * - 4 个 schema：合法 + 非法输入
 *
 * 关键契约（R6 修补 + 98c46eb 真 bug fix）：
 *   safeHandle 必须用 ...rest 收集 ipcMain.handle 的 spread 参数，
 *   否则 v.tuple schema 收到第一个字符串参数 → "Expected Array" 失败。
 */

 
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type MockIpcMain = any;

 
function makeIpcMainMock(): any {
   
  const handlers: any[] = [];
  return {
     
    handle: vi.fn((channel: string, handler: any) => {
      handlers.push({ channel, handler });
    }),
    // 调用注册到 channel 的 handler，模拟 ipcRenderer.invoke
     
    invoke: (channel: string, ...args: unknown[]) => {
       
      const entry = handlers.find((h: any) => h.channel === channel);
      if (!entry) throw new Error(`no handler for ${channel}`);
      // Electron 实际行为：handler 收到 (event, ...args) —— 即 spread
       
      return entry.handler({}, ...args);
    },
  };
}

describe('safeHandle', () => {
   
  let ipc: any;

  beforeEach(() => {
    ipc = makeIpcMainMock();
  });

  it('rest args 收集：v.tuple schema 应接收 spread 调用（url, encoding）', async () => {
     
    const handler = vi.fn(async (_e: unknown, [url, mode]: [string, string]) => ({
      url,
      mode,
    }));
    safeHandle(ipc, 'test:tuple', FetchHtmlArgsSchema, handler);
    const result = await ipc.invoke('test:tuple', 'https://x.com/', 'utf-8');
    expect(result).toEqual({ url: 'https://x.com/', mode: 'utf-8' });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('rest args 收集：仅 url（无 encoding）应使用 schema 默认值', async () => {
     
    const handler = vi.fn(async (_e: unknown, [url, mode]: [string, string]) => ({
      url,
      mode,
    }));
    safeHandle(ipc, 'test:tuple-default', FetchHtmlArgsSchema, handler);
    const result = await ipc.invoke('test:tuple-default', 'https://x.com/');
    expect(result).toEqual({ url: 'https://x.com/', mode: 'auto' });
  });

  it('rest args 收集：空调用（无参数）应使用 schema 全部默认值', async () => {
     
    const handler = vi.fn(async () => 'ok');
    // 单参数 schema（可选）
     
    const schema = v.tuple([v.optional(v.string())]);
    safeHandle(ipc, 'test:optional', schema, handler);
    const result = await ipc.invoke('test:optional');
    expect(result).toBe('ok');
  });

  it('schema 验证失败应抛 IpcValidationError', async () => {
     
    const handler = vi.fn();
    safeHandle(ipc, 'test:invalid', FetchHtmlArgsSchema, handler);
    // url 为空字符串 → minLength 验证失败
    await expect(ipc.invoke('test:invalid', '')).rejects.toBeInstanceOf(IpcValidationError);
    expect(handler).not.toHaveBeenCalled();
  });

  it('IpcValidationError 应包含 channel + issues 详情', async () => {
     
    const handler = vi.fn();
    safeHandle(ipc, 'test:bad-url', FetchHtmlArgsSchema, handler);
    try {
      await ipc.invoke('test:bad-url', '');
      throw new Error('expected throw');
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(IpcValidationError);
       
      const err = e as any;
      expect(err.channel).toBe('test:bad-url');
      expect(err.issues.length).toBeGreaterThan(0);
      expect(err.message).toContain('[test:bad-url]');
    }
  });

  it('handler 返回值应原样转发', async () => {
     
    safeHandle(ipc, 'test:passthrough', FetchHtmlArgsSchema, async (_e, [url]) => ({
      ok: true,
      url,
    }));
    const r = await ipc.invoke('test:passthrough', 'https://x.com/', 'gbk');
    expect(r).toEqual({ ok: true, url: 'https://x.com/' });
  });
});

describe('safeHandleWithMeta', () => {
   
  let ipc: any;

  beforeEach(() => {
    registeredSchemas.clear();
    ipc = makeIpcMainMock();
  });

  it('应注册 schemaName 到 registeredSchemas（debug 用）', () => {
    safeHandleWithMeta(ipc, 'test:meta', 'MyArgsSchema', FetchHtmlArgsSchema, () => undefined);
    expect(registeredSchemas.get('test:meta')).toBe('MyArgsSchema');
  });
});

describe('FetchHtmlArgsSchema', () => {
  it('应接受合法 url+encoding', () => {
    const r = v.safeParse(FetchHtmlArgsSchema, ['https://x.com', 'utf-8']);
    expect(r.success).toBe(true);
  });

  it('应接受仅 url（encoding 默认 auto）', () => {
    const r = v.safeParse(FetchHtmlArgsSchema, ['https://x.com']);
    expect(r.success).toBe(true);
     
    if (r.success) expect((r.output as any[])[1]).toBe('auto');
  });

  it('空 url 应失败（minLength 1）', () => {
    const r = v.safeParse(FetchHtmlArgsSchema, ['']);
    expect(r.success).toBe(false);
  });

  it('非法 encoding 应失败（picklist）', () => {
    const r = v.safeParse(FetchHtmlArgsSchema, ['https://x.com', 'invalid']);
    expect(r.success).toBe(false);
  });
});

describe('SetFetchUaArgsSchema', () => {
  it('应接受 null', () => {
    expect(v.safeParse(SetFetchUaArgsSchema, [null]).success).toBe(true);
  });

  it('应接受 string', () => {
    expect(v.safeParse(SetFetchUaArgsSchema, ['Mozilla/5.0']).success).toBe(true);
  });

  it('应接受 undefined（nullish 默认 null）', () => {
     
    const r = v.safeParse(SetFetchUaArgsSchema, [undefined]) as any;
    expect(r.success).toBe(true);
    expect(r.output[0]).toBe(null);
  });
});

describe('SetWebviewEncodingArgsSchema', () => {
  it('应接受合法 webviewId + mode', () => {
    expect(
      v.safeParse(SetWebviewEncodingArgsSchema, ['session-1', 'utf-8']).success,
    ).toBe(true);
  });

  it('空 webviewId 应失败', () => {
    expect(v.safeParse(SetWebviewEncodingArgsSchema, ['', 'utf-8']).success).toBe(false);
  });

  it('非法字符 webviewId 应失败（security regex）', () => {
    // 包含特殊字符 → 应被 ^[a-zA-Z0-9_-]+$ 拒绝
    expect(
      v.safeParse(SetWebviewEncodingArgsSchema, ['bad/path', 'utf-8']).success,
    ).toBe(false);
    expect(
      v.safeParse(SetWebviewEncodingArgsSchema, ['bad.path', 'utf-8']).success,
    ).toBe(false);
  });

  it('合法字符 webviewId（字母数字下划线连字符）应通过', () => {
    expect(
      v.safeParse(SetWebviewEncodingArgsSchema, ['session_123-abc', 'auto']).success,
    ).toBe(true);
  });
});