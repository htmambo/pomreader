import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * safe-net spec — 重定向链的超时预算语义（F10）
 *
 * 背景：本文件此前没有单测层。safe-net 是 SSRF 防护与所有出网请求的公共底座，
 * 行为改错（超时上界、跳转次数、私网拦截）会直接影响全应用抓取。
 *
 * 本 spec 只覆盖「超时预算在重定向链上累计」这一条 —— 此前每跳递归各自新建一个
 * timeoutMs 计时器，预算不累计，最坏 4×timeout（MAX_REDIRECTS=3）：
 *   调用方声明 15s → 实测最坏 60s；声明 60s → 实测最坏 240s。
 * 修复后：入口处算一次绝对 deadline，逐跳用剩余预算。
 *
 * mock 边界：
 * - electron.net.request：按 URL 查表返回预设响应（302/200），可指定耗时
 * - Date.now：受控时钟，让「时间流逝」确定可复现，不依赖真实等待
 * - ./fetch-session：只需 UA / session 桩
 * - ./net-guard / ./encoding：保持真实实现（纯逻辑值得真跑）
 */

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
  /** 由 net.request mock 在构造后注入（按 URL 查表驱动响应） */
  end!: () => void;
  setHeader(): void {
    /* noop */
  }
  abort(): void {
    this.aborted = true;
    this.emit('close');
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

interface Plan {
  status: number;
  location?: string;
  /** 本跳消耗的毫秒数（推进受控时钟） */
  delay: number;
}

const plans = new Map<string, Plan>();
/** 受控时钟（毫秒） */
let clock = 0;

vi.mock('electron', () => ({
  net: {
    request: vi.fn((opts: { url: string }) => {
      const req = new FakeRequest();
      req.end = () => {
        const plan = plans.get(opts.url);
        if (!plan) return;
        clock += plan.delay;
        const resp = new FakeResponse(
          plan.status,
          plan.location ? { location: plan.location } : {},
        );
        req.emit('response', resp);
        // 3xx 由调用方 abort 后递归；非 3xx 才走 body 流程
        if (plan.status < 300 || plan.status >= 400) {
          resp.emit('data', Buffer.from('body', 'utf-8'));
          resp.emit('end');
        }
      };
      return req;
    }),
  },
  session: {
    fromPartition: vi.fn(() => ({})),
  },
}));

vi.mock('./fetch-session', () => ({
  FETCH_PARTITION: 'persist:fetch',
  getFetchSession: vi.fn(() => ({})),
  browserHeaders: vi.fn(() => ({ 'User-Agent': 'test-ua' })),
}));

import { safeNetRequest } from './safe-net';

describe('safe-net 重定向链的超时预算', () => {
  beforeEach(() => {
    plans.clear();
    clock = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
  });

  it('预算耗尽的跳转链应整体超时（而不是每跳各拿一份完整预算）', async () => {
    plans.set('https://example.com/a', {
      status: 302,
      location: 'https://example.com/b',
      delay: 600,
    });
    plans.set('https://example.com/b', {
      status: 302,
      location: 'https://example.com/c',
      delay: 600,
    });
    plans.set('https://example.com/c', { status: 200, delay: 10 });

    // 总预算 1000ms：第一跳用掉 600，第二跳入口时剩余 -200 → 必须超时
    await expect(safeNetRequest('https://example.com/a', { timeoutMs: 1000 })).rejects.toThrow(
      'timeout',
    );
    // 第三跳不应被发起（预算已耗尽）
    expect(plans.has('https://example.com/c')).toBe(true);
  });

  it('预算内的正常跳转链应成功返回', async () => {
    plans.set('https://example.com/a', {
      status: 302,
      location: 'https://example.com/b',
      delay: 100,
    });
    plans.set('https://example.com/b', { status: 200, delay: 100 });

    const res = await safeNetRequest('https://example.com/a', { timeoutMs: 1000 });
    expect(res.status).toBe(200);
    expect(res.body).toBe('body');
  });

  it('单跳直连不受影响', async () => {
    plans.set('https://example.com/x', { status: 200, delay: 5 });
    const res = await safeNetRequest('https://example.com/x', { timeoutMs: 1000 });
    expect(res.status).toBe(200);
  });

  it('私网地址应在发起请求前被拒（SSRF 防护不因 deadline 改动而失效）', async () => {
    await expect(safeNetRequest('http://127.0.0.1:8080/x')).rejects.toThrow('invalid-url');
  });
});
