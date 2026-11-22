import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * render-handler spec — 隐藏窗口抓取与 CF 过盾的并发语义（F11）
 *
 * 背景：原实现里 `pom:fetch-rendered` 与 `cfFetchHtmlHidden` 共用一条全局 promise 链
 * 和同一个 BrowserWindow → 一次 CF 过盾抓取（最长 40s = 20s loadURL 竞速 +
 * 20s 等挑战消失）会把所有渲染抓取一起堵在后面。
 *
 * 修复：CF 过盾改用**独立隐藏窗口**（同 partition → cookie 互通），
 * 两条链彻底互不阻塞。
 *
 * mock 边界：
 * - electron.BrowserWindow：受控假窗口（loadURL 可挂起，executeJavaScript 可控）
 * - electron.IpcMain：收集 handler
 * - ./fetch-session：UA / partition 桩
 * - ./net-guard：真实实现（私网拦截值得真跑）
 */

// vi.mock 会被提升到文件顶部 → 假类必须用 vi.hoisted 定义，否则报
// "Cannot access 'FakeBrowserWindow' before initialization"
const { FakeBrowserWindow, loadCalls } = vi.hoisted(() => {
  /** 全部窗口的 loadURL 调用记录（跨用例共享：模块级窗口状态会被复用） */
  const loadCalls: { win: FakeBrowserWindow; url: string }[] = [];

  class FakeWebContents {
    executeJavaScript = vi.fn(async (): Promise<string> => 'rendered');
    getURL = vi.fn((): string => 'https://example.com/');
  }

  class FakeBrowserWindow {
    static created: FakeBrowserWindow[] = [];

    readonly webContents = new FakeWebContents();
    destroyed = false;

    constructor() {
      FakeBrowserWindow.created.push(this);
    }

    /** URL 含 'hang' 的 loadURL 永不 resolve —— 模拟「CF 抓取卡住」 */
    loadURL = vi.fn(async (url: string): Promise<void> => {
      loadCalls.push({ win: this, url });
      if (url.includes('hang')) {
        await new Promise<void>(() => undefined);
      }
    });

    isDestroyed = (): boolean => this.destroyed;

    on(): this {
      return this;
    }
  }

  return { FakeBrowserWindow, loadCalls };
});

vi.mock('electron', () => ({
  BrowserWindow: FakeBrowserWindow,
  IpcMain: class {},
}));

vi.mock('./fetch-session', () => ({
  FETCH_PARTITION: 'persist:fetch',
  getUA: vi.fn(() => 'test-ua'),
}));

import { registerRenderHandler, cfFetchHtmlHidden } from './render-handler';

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

describe('render-handler — CF 过盾与渲染抓取的并发语义', () => {
  let ipc: ReturnType<typeof makeIpcMainMock>;

  beforeEach(() => {
    FakeBrowserWindow.created.length = 0;
    loadCalls.length = 0;
    ipc = makeIpcMainMock();
    registerRenderHandler(ipc as never);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('CF 过盾应使用与渲染抓取**不同**的隐藏窗口', async () => {
    const cfPromise = cfFetchHtmlHidden('https://example.com/hang');
    await vi.advanceTimersByTimeAsync(0);

    const renderPromise = ipc.invoke('pom:fetch-rendered', 'https://example.com/render');
    await vi.advanceTimersByTimeAsync(1500);
    await renderPromise;

    // CF 与渲染用的是**不同**的窗口
    const cfWin = loadCalls.find((c) => c.url.includes('/hang'))?.win;
    const renderWin = loadCalls.find((c) => c.url.includes('/render'))?.win;
    expect(cfWin).toBeDefined();
    expect(renderWin).toBeDefined();
    expect(cfWin).not.toBe(renderWin);

    // CF 那个请求仍挂起（loadURL 永不 resolve）
    let cfSettled = false;
    void cfPromise.then(() => {
      cfSettled = true;
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(cfSettled).toBe(false);
  });

  it('CF 抓取卡住时，渲染抓取仍应独立完成（不再被全局链堵住）', async () => {
    const cfPromise = cfFetchHtmlHidden('https://example.com/hang');
    await vi.advanceTimersByTimeAsync(0);

    const renderPromise = ipc.invoke('pom:fetch-rendered', 'https://example.com/render');
    await vi.advanceTimersByTimeAsync(1500);

    const res = (await renderPromise) as { text?: string; error?: string };
    expect(res).toEqual({ text: 'rendered' });

    let cfSettled = false;
    void cfPromise.then(() => {
      cfSettled = true;
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(cfSettled).toBe(false);
  });

  it('两个渲染抓取仍串行（同一窗口不能并发 loadURL）', async () => {
    const first = ipc.invoke('pom:fetch-rendered', 'https://example.com/r1');
    const second = ipc.invoke('pom:fetch-rendered', 'https://example.com/r2');
    await vi.advanceTimersByTimeAsync(3000);

    await first;
    await second;
    // 两次渲染共用**同一个**窗口（未被 CF 窗口带偏），且按提交顺序串行
    const urls = loadCalls.map((c) => c.url).filter((u) => u !== 'about:blank');
    expect(urls).toEqual(['https://example.com/r1', 'https://example.com/r2']);
    expect(new Set(loadCalls.map((c) => c.win)).size).toBe(1);
  });

  it('私网地址应在加载前被拒', async () => {
    const res = (await ipc.invoke('pom:fetch-rendered', 'http://127.0.0.1:8080/x')) as {
      error?: string;
    };
    expect(res.error).toBe('invalid-url');
  });
});
