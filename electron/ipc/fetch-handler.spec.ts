import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import iconv from 'iconv-lite';

/**
 * fetch-handler spec — registerFetchHandler 的 4 个 channel 端到端契约
 *
 * 覆盖这个文件此前完全缺失的测试层（schema.spec.ts 只测 schema 本身，
 * 抓不到「schema 与实际 invoke 形态不匹配」这类注册级 bug —— 例如
 * pom:get-fetch-ua 曾用 v.nullish(v.null()) 解析 args 数组，恒抛验证失败）。
 *
 * mock 边界：
 * - electron：net.request / session.fromPartition / app（不碰真实网络与 session）
 * - ./render-handler：只留 cfFetchHtmlHidden（CF 隐藏窗口过盾链路）
 * - encoding / cf-guard / net-guard / fetch-session 保持真实实现（纯逻辑值得真跑）
 */

// ── electron mock ────────────────────────────────────────────────────────
type Handler = (...args: unknown[]) => void;

class FakeEmitter {
  private readonly handlers = new Map<string, Handler[]>();
  on(ev: string, cb: Handler): this {
    const arr = this.handlers.get(ev) ?? [];
    arr.push(cb);
    this.handlers.set(ev, arr);
    return this;
  }
  emit(ev: string, ...args: unknown[]): void {
    for (const cb of this.handlers.get(ev) ?? []) cb(...args);
  }
}

class FakeRequest extends FakeEmitter {
  readonly headers: Record<string, string> = {};
  aborted = false;
  ended = false;
  setHeader(k: string, v: string): void {
    this.headers[k] = v;
  }
  abort(): void {
    this.aborted = true;
  }
  end(): void {
    this.ended = true;
  }
}

class FakeResponse extends FakeEmitter {
  constructor(
    public statusCode: number,
    public headers: Record<string, string | string[]> = {},
  ) {
    super();
  }
}

/** webRequest.onHeadersReceived 拦截器记录器 */
interface WebRequestStub {
  setUserAgent: ReturnType<typeof vi.fn>;
  cookies: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> };
  webRequest?: { onHeadersReceived: ReturnType<typeof vi.fn> };
}

const sessionStubs = new Map<string, WebRequestStub>();
const pendingRequests: FakeRequest[] = [];
let lastRequestOpts: Record<string, unknown> | null = null;

function makeSessionStub(withWebRequest = true): WebRequestStub {
  return {
    setUserAgent: vi.fn(),
    cookies: { get: vi.fn(), set: vi.fn() },
    ...(withWebRequest ? { webRequest: { onHeadersReceived: vi.fn() } } : {}),
  };
}

vi.mock('electron', () => ({
  app: { userAgentFallback: '' },
  session: {
    defaultSession: { setUserAgent: vi.fn() },
    fromPartition: vi.fn((partition: string) => {
      if (!sessionStubs.has(partition)) sessionStubs.set(partition, makeSessionStub());
      return sessionStubs.get(partition);
    }),
  },
  net: {
    request: vi.fn((opts: Record<string, unknown>) => {
      lastRequestOpts = opts;
      const req = new FakeRequest();
      pendingRequests.push(req);
      return req;
    }),
  },
}));

vi.mock('./render-handler', () => ({
  cfFetchHtmlHidden: vi.fn(async () => null as string | null),
}));

import { net } from 'electron';
import { registerFetchHandler } from './fetch-handler';
import { registeredSchemas, IpcValidationError } from './schema';
import { defaultUA, setFetchUA } from './fetch-session';
import { cfFetchHtmlHidden } from './render-handler';

/** ipcMain.handle 收集器：invoke 复刻 Electron 的 (event, ...args) 展开语义 */
function makeIpcMainMock(): {
  handle: ReturnType<typeof vi.fn>;
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
} {
  const handlers: { channel: string; handler: (e: unknown, ...rest: unknown[]) => unknown }[] = [];
  return {
    handle: vi.fn((channel: string, handler: (e: unknown, ...rest: unknown[]) => unknown) => {
      handlers.push({ channel, handler });
    }),
    invoke: (channel: string, ...args: unknown[]) => {
      const entry = handlers.find((h) => h.channel === channel);
      if (!entry) throw new Error(`no handler for ${channel}`);
      return Promise.resolve(entry.handler({}, ...args));
    },
  };
}

/** 让 handler 跑到 net.request 之后再继续（handler 内有多层 await） */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe('registerFetchHandler — 注册与 schema 契约', () => {
  let ipc: ReturnType<typeof makeIpcMainMock>;

  beforeEach(() => {
    ipc = makeIpcMainMock();
    registeredSchemas.clear();
    sessionStubs.clear();
    pendingRequests.length = 0;
    lastRequestOpts = null;
    vi.mocked(net.request).mockClear();
    vi.mocked(cfFetchHtmlHidden).mockReset();
    vi.mocked(cfFetchHtmlHidden).mockResolvedValue(null);
    registerFetchHandler(ipc as never);
  });

  it('4 个 channel 全部注册且带 schema 元信息', () => {
    expect([...registeredSchemas.keys()].sort()).toEqual([
      'pom:fetch-html',
      'pom:get-fetch-ua',
      'pom:set-fetch-ua',
      'pom:set-webview-encoding',
    ]);
    expect(registeredSchemas.get('pom:get-fetch-ua')).toBe('GetFetchUaArgsSchema');
  });

  it('回归：零参 invoke pom:get-fetch-ua 应放行（曾恒抛 IpcValidationError）', async () => {
    const r = (await ipc.invoke('pom:get-fetch-ua')) as { ua: string; defaultUa: string };
    expect(r.defaultUa).toBe(defaultUA());
    expect(r.ua).toBe(defaultUA());
  });

  it('schema 校验先于 handler：空 url 不应触发网络请求', async () => {
    await expect(ipc.invoke('pom:fetch-html', '')).rejects.toBeInstanceOf(IpcValidationError);
    expect(net.request).not.toHaveBeenCalled();
  });

  it('非法 webviewId 应在 schema 层被拒（handler 不执行）', async () => {
    await expect(
      ipc.invoke('pom:set-webview-encoding', 'bad/path', 'utf-8'),
    ).rejects.toBeInstanceOf(IpcValidationError);
  });

  it('非法编码 mode 应在 schema 层被拒', async () => {
    await expect(
      ipc.invoke('pom:set-webview-encoding', 'session-1', 'big5'),
    ).rejects.toBeInstanceOf(IpcValidationError);
  });
});

describe('pom:get-fetch-ua / pom:set-fetch-ua', () => {
  let ipc: ReturnType<typeof makeIpcMainMock>;

  beforeEach(() => {
    ipc = makeIpcMainMock();
    registeredSchemas.clear();
    setFetchUA(null); // 每个用例从平台默认开始
    registerFetchHandler(ipc as never);
  });

  it('读取的默认值随平台 UA 变化', async () => {
    const r = (await ipc.invoke('pom:get-fetch-ua')) as { ua: string; defaultUa: string };
    expect(r.defaultUa).toMatch(/^Mozilla\/5\.0 /);
    expect(r.ua).toBe(r.defaultUa);
  });

  it('设置自定义 UA 后立即生效（读回一致）', async () => {
    const custom = 'Mozilla/5.0 Custom/1.0';
    const set = (await ipc.invoke('pom:set-fetch-ua', custom)) as { ua: string };
    expect(set.ua).toBe(custom);
    const got = (await ipc.invoke('pom:get-fetch-ua')) as { ua: string };
    expect(got.ua).toBe(custom);
  });

  it('UA 不以 Mozilla/5.0 开头应抛错', async () => {
    await expect(ipc.invoke('pom:set-fetch-ua', 'curl/8.0')).rejects.toThrow('UA 格式无效');
  });

  it('UA 超长（>300）应抛错', async () => {
    const long = `Mozilla/5.0 ${'x'.repeat(300)}`;
    await expect(ipc.invoke('pom:set-fetch-ua', long)).rejects.toThrow('UA 格式无效');
  });

  it('null / 空串 = 恢复平台默认', async () => {
    await ipc.invoke('pom:set-fetch-ua', 'Mozilla/5.0 Custom/1.0');
    const r = (await ipc.invoke('pom:set-fetch-ua', null)) as { ua: string };
    expect(r.ua).toBe(defaultUA());
    const r2 = (await ipc.invoke('pom:set-fetch-ua', '')) as { ua: string };
    expect(r2.ua).toBe(defaultUA());
  });

  it('自定义值两端空白应被 trim', async () => {
    const r = (await ipc.invoke('pom:set-fetch-ua', '  Mozilla/5.0 Trim/1.0  ')) as {
      ua: string;
    };
    expect(r.ua).toBe('Mozilla/5.0 Trim/1.0');
  });
});

describe('pom:set-webview-encoding', () => {
  let ipc: ReturnType<typeof makeIpcMainMock>;

  beforeEach(() => {
    ipc = makeIpcMainMock();
    registeredSchemas.clear();
    sessionStubs.clear();
    registerFetchHandler(ipc as never);
  });

  it('指定编码时应注册拦截器并重写 content-type charset', async () => {
    await ipc.invoke('pom:set-webview-encoding', 'session-1', 'gbk');
    const stub = sessionStubs.get('persist:session-1')!;
    expect(stub.webRequest?.onHeadersReceived).toHaveBeenCalledTimes(1);

    const [filter, listener] = stub.webRequest!.onHeadersReceived.mock.calls[0] as unknown as [
      { urls: string[] },
      (
        d: { responseHeaders?: Record<string, string[]> },
        cb: (r: { responseHeaders?: Record<string, string[]> }) => void,
      ) => void,
    ];
    expect(filter.urls).toEqual(['*://*/*']);

    let out: { responseHeaders?: Record<string, string[]> } = {};
    listener({ responseHeaders: { 'content-type': ['text/html'] } }, (r) => {
      out = r;
    });
    expect(out.responseHeaders?.['content-type']).toEqual(['text/html; charset=gbk']);
  });

  it('mode=auto 时回调空对象（移除拦截效果）', async () => {
    await ipc.invoke('pom:set-webview-encoding', 'session-2', 'auto');
    const stub = sessionStubs.get('persist:session-2')!;
    const [, listener] = stub.webRequest!.onHeadersReceived.mock.calls[0] as unknown as [
      unknown,
      (d: unknown, cb: (r: unknown) => void) => void,
    ];
    let out: unknown = 'untouched';
    listener({ responseHeaders: { 'content-type': ['text/html'] } }, (r) => {
      out = r;
    });
    expect(out).toEqual({});
  });

  it('session 不支持 webRequest.onHeadersReceived 时不应抛错', async () => {
    sessionStubs.set('persist:legacy', makeSessionStub(false));
    await expect(ipc.invoke('pom:set-webview-encoding', 'legacy', 'gbk')).resolves.toBeUndefined();
  });
});

describe('pom:fetch-html', () => {
  let ipc: ReturnType<typeof makeIpcMainMock>;

  beforeEach(() => {
    ipc = makeIpcMainMock();
    registeredSchemas.clear();
    pendingRequests.length = 0;
    lastRequestOpts = null;
    vi.mocked(net.request).mockClear();
    vi.mocked(cfFetchHtmlHidden).mockReset();
    vi.mocked(cfFetchHtmlHidden).mockResolvedValue(null);
    registerFetchHandler(ipc as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** 触发一次完整响应 */
  function respond(
    req: FakeRequest,
    status: number,
    headers: Record<string, string | string[]>,
    body: Buffer,
  ): void {
    const resp = new FakeResponse(status, headers);
    req.emit('response', resp);
    resp.emit('data', body);
    resp.emit('end');
  }

  it('非法 URL / 内网地址应直接返回 invalid-url，不发请求', async () => {
    for (const url of [
      'not-a-url',
      'ftp://example.com/x',
      'file:///etc/passwd',
      'http://127.0.0.1:8080/x',
      'http://localhost/x',
      'http://169.254.169.254/latest/meta-data',
    ]) {
      const r = (await ipc.invoke('pom:fetch-html', url)) as { error?: string };
      expect(r).toEqual({ error: 'invalid-url' });
    }
    expect(net.request).not.toHaveBeenCalled();
  });

  it('正常响应应返回解码后的 html，且带浏览器导航请求头', async () => {
    const p = ipc.invoke('pom:fetch-html', 'https://example.com/book/1') as Promise<{
      html?: string;
      error?: string;
    }>;
    await flush();
    const req = pendingRequests[0];

    // 请求构造：跟随重定向 + 共享 fetch session + 类浏览器头
    expect(lastRequestOpts).toMatchObject({
      url: 'https://example.com/book/1',
      redirect: 'follow',
    });
    expect(req.ended).toBe(true);
    expect(req.headers['User-Agent']).toMatch(/^Mozilla\/5\.0 /);
    expect(req.headers['Sec-Fetch-Dest']).toBe('document');
    expect(req.headers['Referer']).toBe('https://example.com/');

    respond(
      req,
      200,
      { 'content-type': 'text/html; charset=utf-8' },
      Buffer.from('<h1>第一章</h1>'),
    );
    await expect(p).resolves.toEqual({ html: '<h1>第一章</h1>' });
  });

  it('mode=gbk 应对 gbk 字节流正确解码（覆盖 charset 声明缺失场景）', async () => {
    const p = ipc.invoke('pom:fetch-html', 'https://example.com/gbk', 'gbk') as Promise<{
      html?: string;
    }>;
    await flush();
    respond(pendingRequests[0], 200, {}, iconv.encode('<p>連城訣</p>', 'gbk'));
    await expect(p).resolves.toEqual({ html: '<p>連城訣</p>' });
  });

  it('CF 挑战页（403 + cloudflare + cf-chl）应回落隐藏窗口过盾', async () => {
    vi.mocked(cfFetchHtmlHidden).mockResolvedValue('<h1>已渲染</h1>');
    const p = ipc.invoke('pom:fetch-html', 'https://example.com/cf') as Promise<{
      html?: string;
      error?: string;
    }>;
    await flush();
    respond(
      pendingRequests[0],
      403,
      { server: 'cloudflare' },
      Buffer.from('<div id="cf-chl-widget"></div>'),
    );
    await expect(p).resolves.toEqual({ html: '<h1>已渲染</h1>' });
    expect(cfFetchHtmlHidden).toHaveBeenCalledWith('https://example.com/cf');
  });

  it('CF 过盾也失败时应返回原始 cf-challenge 错误', async () => {
    vi.mocked(cfFetchHtmlHidden).mockResolvedValue(null);
    const p = ipc.invoke('pom:fetch-html', 'https://example.com/cf2') as Promise<{
      error?: string;
    }>;
    await flush();
    respond(pendingRequests[0], 503, { server: 'cloudflare' }, Buffer.from('challenge-platform'));
    await expect(p).resolves.toEqual({ error: 'cf-challenge' });
  });

  it('cf-mitigated: challenge 响应头同样触发过盾回落', async () => {
    vi.mocked(cfFetchHtmlHidden).mockResolvedValue('<h1>ok</h1>');
    const p = ipc.invoke('pom:fetch-html', 'https://example.com/cf3') as Promise<{
      html?: string;
    }>;
    await flush();
    respond(pendingRequests[0], 200, { 'cf-mitigated': 'challenge' }, Buffer.from('<html></html>'));
    await expect(p).resolves.toEqual({ html: '<h1>ok</h1>' });
  });

  it('请求层错误应返回 source-unavailable', async () => {
    const p = ipc.invoke('pom:fetch-html', 'https://example.com/boom') as Promise<{
      error?: string;
    }>;
    await flush();
    pendingRequests[0].emit('error', new Error('ECONNRESET'));
    await expect(p).resolves.toEqual({ error: 'source-unavailable' });
  });

  it('响应超过 8MB 上限应中止并返回 parse-failed', async () => {
    const p = ipc.invoke('pom:fetch-html', 'https://example.com/big') as Promise<{
      error?: string;
    }>;
    await flush();
    const req = pendingRequests[0];
    const resp = new FakeResponse(200, { 'content-type': 'text/html' });
    req.emit('response', resp);
    const chunk = Buffer.alloc(4 * 1024 * 1024);
    resp.emit('data', chunk);
    resp.emit('data', chunk);
    resp.emit('data', chunk); // 累计 12MB > 8MB
    await expect(p).resolves.toEqual({ error: 'parse-failed' });
    expect(req.aborted).toBe(true);
  });

  it('超过 15s 未响应应中止并返回 timeout', async () => {
    vi.useFakeTimers();
    const p = ipc.invoke('pom:fetch-html', 'https://example.com/slow') as Promise<{
      error?: string;
    }>;
    await flush();
    const req = pendingRequests[0];
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(p).resolves.toEqual({ error: 'timeout' });
    expect(req.aborted).toBe(true);
  });
});
