import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Mock electron BEFORE importing handler（schema.ts 链路上的类型引用兜底；
// 本模块对 electron 仅 import type，运行时不依赖）
vi.mock('electron', () => ({
  IpcMain: class {},
  BrowserWindow: class {},
}));

const safeNetRequestMock = vi.fn();
vi.mock('./safe-net', () => ({
  safeNetRequest: (...args: unknown[]) => safeNetRequestMock(...args),
}));

import {
  isDue,
  registerBookSourceSubscriptionHandler,
  SUB_BOOT_DELAY_MS,
  SUB_TICK_MS,
  SUBSCRIPTIONS_FILE,
  SubscriptionCheckResult,
  SubscriptionItem,
} from './booksource-subscription';
import { sha256 } from './booksource-bundle';

/**
 * booksource-subscription spec — 状态文件 / 四 channel / 调度（设计 §6/§9）
 *
 * 覆盖：到期计算（null/到期/未到期/disabled）；状态文件损坏自愈（.corrupt-<ts> 备份）；
 * save/list 往返（新增生成 id、list 剥离 applied）；check 成功路径写盘 + applied 基线 +
 * 通知 payload；拉取失败只记 lastError；远端 hash 变化 + 本地被改 → conflict 不写盘；
 * 调度跳：单订阅失败不阻断同跳其他订阅、未到期跳过、无窗口跳本跳、stop 清 timer。
 */

type HandlerFn = (event: unknown, ...args: unknown[]) => unknown;

function createFakeIpcMain(): { handlers: Map<string, HandlerFn> } & Record<'handle', unknown> {
  const handlers = new Map<string, HandlerFn>();
  return {
    handlers,
    handle(channel: string, fn: HandlerFn) {
      handlers.set(channel, fn);
    },
  };
}

function makeDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: 'pomreader.booksource',
    schemaVersion: 1,
    uuid: 'uuid-1',
    name: '源一',
    homepage: 'https://example.com/',
    urls: ['https://example.com/'],
    enabled: true,
    sourceType: 'novel',
    rules: {
      siteName: '源一',
      searchPath: '/search',
      searchItemPattern: '.item',
      bookTitlePattern: '.title',
      bookAuthorPattern: '.author',
      chapterItemPattern: '.chapter',
      contentPattern: '.content',
    },
    ...overrides,
  };
}

function makeBundleText(sources: { fileName: string; doc: Record<string, unknown> }[]): string {
  return JSON.stringify({
    format: 'pomreader.booksource.bundle',
    version: 1,
    exportedAt: 1789000000000,
    app: 'test',
    sources: sources.map((s) => ({
      uuid: typeof s.doc.uuid === 'string' ? s.doc.uuid : s.fileName,
      fileName: s.fileName,
      content: JSON.stringify(s.doc),
    })),
  });
}

function mockFetchOk(body: string): void {
  safeNetRequestMock.mockResolvedValue({
    status: 200,
    headers: {},
    body,
    bytes: Buffer.from(body, 'utf-8'),
  });
}

function makeWindow(): {
  webContents: { isDestroyed: () => boolean; send: ReturnType<typeof vi.fn> };
} {
  return { webContents: { isDestroyed: () => false, send: vi.fn() } };
}

function makeSubInput(overrides: Partial<SubscriptionItem> = {}): Record<string, unknown> {
  return {
    name: '示例订阅',
    url: 'https://example.com/sources.json',
    enabled: true,
    intervalHours: 12,
    lastCheckedAt: null,
    lastError: null,
    ...overrides,
  };
}

/** fake timers 下让串行 promise 链（tick → runCheck → safeNetRequest）推进到底 */
async function flush(times = 30): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

describe('booksource-subscription', () => {
  let tmpUserData: string;
  let handlers: Map<string, HandlerFn>;
  let windows: ReturnType<typeof makeWindow>[];
  let scheduler: { start(): void; stop(): void };

  const call = (channel: string, ...args: unknown[]): Promise<unknown> =>
    Promise.resolve(handlers.get(channel)!({}, ...args));

  const stateFile = (): string => path.join(tmpUserData, SUBSCRIPTIONS_FILE);
  const readState = (): { version: number; items: Record<string, unknown>[] } =>
    JSON.parse(fs.readFileSync(stateFile(), 'utf-8'));

  beforeEach(() => {
    tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'booksource-sub-test-'));
    windows = [makeWindow()];
    const fake = createFakeIpcMain();
    scheduler = registerBookSourceSubscriptionHandler(
      fake as any,
      tmpUserData,
      () => windows as any,
    );
    handlers = fake.handlers;
    safeNetRequestMock.mockReset();
  });

  afterEach(() => {
    scheduler.stop();
    fs.rmSync(tmpUserData, { recursive: true, force: true });
  });

  it('应注册 4 个订阅 channel 并返回调度器句柄', () => {
    for (const ch of [
      'pom:booksource-sub-list',
      'pom:booksource-sub-save',
      'pom:booksource-sub-delete',
      'pom:booksource-sub-check',
    ]) {
      expect(handlers.has(ch), ch).toBe(true);
    }
    expect(typeof scheduler.start).toBe('function');
    expect(typeof scheduler.stop).toBe('function');
  });

  /* ── 到期计算（§6.3 / §9） ── */

  it('isDue：null 视为到期；到期/未到期按 lastCheckedAt + intervalHours 判定', () => {
    const now = 1_800_000_000_000;
    expect(isDue({ enabled: true, lastCheckedAt: null, intervalHours: 12 }, now)).toBe(true);
    expect(
      isDue({ enabled: true, lastCheckedAt: now - 12 * 3600_000, intervalHours: 12 }, now),
    ).toBe(true);
    expect(
      isDue({ enabled: true, lastCheckedAt: now - 11 * 3600_000, intervalHours: 12 }, now),
    ).toBe(false);
    // disabled 永不到期
    expect(isDue({ enabled: false, lastCheckedAt: null, intervalHours: 12 }, now)).toBe(false);
  });

  /* ── 状态文件 ── */

  it('list：状态文件不存在视为空表', async () => {
    expect(await call('pom:booksource-sub-list')).toEqual([]);
  });

  it('list：状态文件损坏 → 备份 .corrupt-<ts> 并从空表起步（不抛错）', async () => {
    fs.writeFileSync(stateFile(), '{ 这不是 JSON');
    expect(await call('pom:booksource-sub-list')).toEqual([]);
    const siblings = fs.readdirSync(tmpUserData);
    expect(siblings.some((f) => f.startsWith(`${SUBSCRIPTIONS_FILE}.corrupt-`))).toBe(true);
    expect(fs.existsSync(stateFile())).toBe(false);
    // 自愈后可正常 save
    await call('pom:booksource-sub-save', makeSubInput());
    expect(readState().items).toHaveLength(1);
  });

  /* ── save / list / delete ── */

  it('save：无 id 视为新增并生成随机 id；list 剥离 applied 基线', async () => {
    const saved = (await call('pom:booksource-sub-save', makeSubInput())) as SubscriptionItem;
    expect(saved.id).toBeTruthy();
    expect(saved).not.toHaveProperty('applied');

    const list = (await call('pom:booksource-sub-list')) as Record<string, unknown>[];
    expect(list).toHaveLength(1);
    expect(list[0]).not.toHaveProperty('applied');
    expect(list[0].id).toBe(saved.id);
    // 状态文件内含 applied（空基线起步）
    expect(readState().items[0].applied).toEqual({});
  });

  it('save：带已有 id 更新字段并保留 applied 基线', async () => {
    const saved = (await call('pom:booksource-sub-save', makeSubInput())) as SubscriptionItem;
    // 人为写入 applied 基线（模拟一次成功 check 后）
    const state = readState();
    state.items[0].applied = { 'uuid-1': 'abc' };
    fs.writeFileSync(stateFile(), JSON.stringify(state));

    const updated = (await call(
      'pom:booksource-sub-save',
      makeSubInput({ id: saved.id, name: '改名', enabled: false }),
    )) as SubscriptionItem;
    expect(updated.name).toBe('改名');
    expect(updated.enabled).toBe(false);
    expect(readState().items[0].applied).toEqual({ 'uuid-1': 'abc' });
  });

  it('delete：删除后 list 不再返回', async () => {
    const saved = (await call('pom:booksource-sub-save', makeSubInput())) as SubscriptionItem;
    await call('pom:booksource-sub-delete', saved.id);
    expect(await call('pom:booksource-sub-list')).toEqual([]);
    expect(readState().items).toEqual([]);
  });

  /* ── check（立即检查，与调度同款逻辑） ── */

  it('check：成功路径写盘 + applied[uuid]=sha256(content) + 广播通知 payload', async () => {
    const saved = (await call('pom:booksource-sub-save', makeSubInput())) as SubscriptionItem;
    const doc = makeDoc({ uuid: 'u-1' });
    const content = JSON.stringify(doc);
    mockFetchOk(makeBundleText([{ fileName: 'a.json', doc }]));

    const r = (await call('pom:booksource-sub-check', saved.id)) as SubscriptionCheckResult;
    expect(r).toEqual({ changed: 1, conflicts: 0, error: null });

    // 书源落盘
    const written = path.join(tmpUserData, 'booksources', 'a.json');
    expect(fs.readFileSync(written, 'utf-8')).toBe(content);

    // 状态：applied 基线 + lastCheckedAt + lastError=null
    const item = readState().items[0];
    expect(item.applied).toEqual({ 'u-1': sha256(content) });
    expect(typeof item.lastCheckedAt).toBe('number');
    expect(item.lastError).toBeNull();

    // 广播 pom:booksource-updated
    expect(windows[0].webContents.send).toHaveBeenCalledWith('pom:booksource-updated', {
      source: 'subscription',
      subscriptionId: saved.id,
      changed: 1,
      conflicts: 0,
    });
  });

  it('check：拉取失败只记 lastError，不写盘不广播，lastCheckedAt 不更新', async () => {
    const saved = (await call('pom:booksource-sub-save', makeSubInput())) as SubscriptionItem;
    safeNetRequestMock.mockRejectedValue(new Error('net::ERR_NAME_NOT_RESOLVED'));

    const r = (await call('pom:booksource-sub-check', saved.id)) as SubscriptionCheckResult;
    expect(r.changed).toBe(0);
    expect(r.error).toMatch(/拉取失败/);

    const item = readState().items[0];
    expect(item.lastError).toMatch(/ERR_NAME_NOT_RESOLVED/);
    expect(item.lastCheckedAt).toBeNull();
    expect(fs.existsSync(path.join(tmpUserData, 'booksources'))).toBe(false);
    expect(windows[0].webContents.send).not.toHaveBeenCalled();
  });

  it('check：bundle 解析失败记 lastError（parseBundle 整体拒绝口径）', async () => {
    const saved = (await call('pom:booksource-sub-save', makeSubInput())) as SubscriptionItem;
    mockFetchOk(JSON.stringify({ format: 'other.bundle' }));

    const r = (await call('pom:booksource-sub-check', saved.id)) as SubscriptionCheckResult;
    expect(r.error).toMatch(/解析失败/);
    expect(readState().items[0].lastError).toMatch(/未知 format/);
  });

  it('check：不存在的 id 抛错', async () => {
    await expect(call('pom:booksource-sub-check', 'ghost')).rejects.toThrow(/订阅不存在/);
  });

  it('check：订阅写入一次后上游真实更新 → 本地未改判 update，自动落盘并推进 applied', async () => {
    const saved = (await call('pom:booksource-sub-save', makeSubInput())) as SubscriptionItem;
    // 第一次 check：new 写入 content1，applied[u-1]=sha256(content1)
    const doc1 = makeDoc({ uuid: 'u-1', name: '版本一' });
    const content1 = JSON.stringify(doc1);
    mockFetchOk(makeBundleText([{ fileName: 'a.json', doc: doc1 }]));
    await call('pom:booksource-sub-check', saved.id);
    expect(readState().items[0].applied).toEqual({ 'u-1': sha256(content1) });

    // 上游发布新版本，本地未被用户改动 → update（不再误判 conflict）
    const doc2 = makeDoc({ uuid: 'u-1', name: '版本二' });
    const content2 = JSON.stringify(doc2);
    mockFetchOk(makeBundleText([{ fileName: 'a.json', doc: doc2 }]));

    const r = (await call('pom:booksource-sub-check', saved.id)) as SubscriptionCheckResult;
    expect(r).toEqual({ changed: 1, conflicts: 0, error: null });
    expect(fs.readFileSync(path.join(tmpUserData, 'booksources', 'a.json'), 'utf-8')).toBe(
      content2,
    );
    expect(readState().items[0].applied).toEqual({ 'u-1': sha256(content2) });
    expect(windows[0].webContents.send).toHaveBeenLastCalledWith('pom:booksource-updated', {
      source: 'subscription',
      subscriptionId: saved.id,
      changed: 1,
      conflicts: 0,
    });
  });

  it('check：远端 hash 变化 + 本地被改 → conflict 不写盘，计数进通知', async () => {
    const saved = (await call('pom:booksource-sub-save', makeSubInput())) as SubscriptionItem;
    // 第一次 check：new 写入，applied[u-1]=sha256(content1)
    const doc1 = makeDoc({ uuid: 'u-1', name: '版本一' });
    mockFetchOk(makeBundleText([{ fileName: 'a.json', doc: doc1 }]));
    await call('pom:booksource-sub-check', saved.id);
    expect(readState().items[0].applied).toEqual({ 'u-1': sha256(JSON.stringify(doc1)) });

    // 用户本地改动该源 + 远端发布新版本（hash 变化）
    const localEdit = JSON.stringify(makeDoc({ uuid: 'u-1', name: '用户本地改' }));
    fs.writeFileSync(path.join(tmpUserData, 'booksources', 'a.json'), localEdit);
    const doc2 = makeDoc({ uuid: 'u-1', name: '版本二' });
    mockFetchOk(makeBundleText([{ fileName: 'a.json', doc: doc2 }]));

    const r = (await call('pom:booksource-sub-check', saved.id)) as SubscriptionCheckResult;
    expect(r).toEqual({ changed: 0, conflicts: 1, error: null });

    // 本地用户改动不被覆盖；applied 基线不动
    expect(fs.readFileSync(path.join(tmpUserData, 'booksources', 'a.json'), 'utf-8')).toBe(
      localEdit,
    );
    expect(readState().items[0].applied).toEqual({ 'u-1': sha256(JSON.stringify(doc1)) });
    expect(windows[0].webContents.send).toHaveBeenLastCalledWith('pom:booksource-updated', {
      source: 'subscription',
      subscriptionId: saved.id,
      changed: 0,
      conflicts: 1,
    });
  });

  it('check：identical 跳过（无写入不广播）', async () => {
    const saved = (await call('pom:booksource-sub-save', makeSubInput())) as SubscriptionItem;
    const doc = makeDoc({ uuid: 'u-1' });
    const content = JSON.stringify(doc);
    fs.mkdirSync(path.join(tmpUserData, 'booksources'), { recursive: true });
    fs.writeFileSync(path.join(tmpUserData, 'booksources', 'a.json'), content);
    mockFetchOk(makeBundleText([{ fileName: 'a.json', doc }]));

    const r = (await call('pom:booksource-sub-check', saved.id)) as SubscriptionCheckResult;
    expect(r).toEqual({ changed: 0, conflicts: 0, error: null });
    expect(windows[0].webContents.send).not.toHaveBeenCalled();
  });

  /* ── 调度（§6.3，fake timers） ── */

  describe('调度器', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(1_800_000_000_000);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('start 后 60 秒先跑一次；到期订阅被处理，未到期跳过', async () => {
      const now = Date.now();
      // 到期（从未成功）+ 未到期（1 小时前查过，间隔 12h）+ disabled
      await call(
        'pom:booksource-sub-save',
        makeSubInput({ name: '到期', url: 'https://a.com/x.json' }),
      );
      await call(
        'pom:booksource-sub-save',
        makeSubInput({
          name: '未到期',
          url: 'https://b.com/x.json',
          lastCheckedAt: now - 1 * 3600_000,
        }),
      );
      await call(
        'pom:booksource-sub-save',
        makeSubInput({ name: '停用', url: 'https://c.com/x.json', enabled: false }),
      );
      mockFetchOk(makeBundleText([{ fileName: 'a.json', doc: makeDoc({ uuid: 'u-due' }) }]));

      scheduler.start();
      await vi.advanceTimersByTimeAsync(SUB_BOOT_DELAY_MS);
      await flush();

      // 只拉了到期那一条
      expect(safeNetRequestMock).toHaveBeenCalledTimes(1);
      expect(safeNetRequestMock.mock.calls[0][0]).toBe('https://a.com/x.json');

      // 每 30 分钟一跳：再推进一跳，到期订阅 lastCheckedAt 已更新为 now → 本跳无人到期
      await vi.advanceTimersByTimeAsync(SUB_TICK_MS);
      await flush();
      expect(safeNetRequestMock).toHaveBeenCalledTimes(1);
    });

    it('单订阅失败不阻断同跳其他订阅', async () => {
      await call(
        'pom:booksource-sub-save',
        makeSubInput({ name: '会失败', url: 'https://fail.com/x.json' }),
      );
      await call(
        'pom:booksource-sub-save',
        makeSubInput({ name: '会成功', url: 'https://ok.com/x.json' }),
      );
      safeNetRequestMock.mockImplementation((url: string) => {
        if (url.includes('fail.com')) return Promise.reject(new Error('timeout'));
        const body = makeBundleText([{ fileName: 'ok.json', doc: makeDoc({ uuid: 'u-ok' }) }]);
        return Promise.resolve({ status: 200, headers: {}, body, bytes: Buffer.from(body) });
      });

      scheduler.start();
      await vi.advanceTimersByTimeAsync(SUB_BOOT_DELAY_MS);
      await flush();

      expect(safeNetRequestMock).toHaveBeenCalledTimes(2);
      // 成功的订阅写盘 + applied 基线
      expect(fs.existsSync(path.join(tmpUserData, 'booksources', 'ok.json'))).toBe(true);
      const items = readState().items as {
        url: string;
        lastError: string | null;
        lastCheckedAt: number | null;
        applied: Record<string, string>;
      }[];
      const failed = items.find((i) => i.url.includes('fail.com'))!;
      const ok = items.find((i) => i.url.includes('ok.com'))!;
      expect(failed.lastError).toMatch(/timeout/);
      expect(failed.lastCheckedAt).toBeNull();
      expect(ok.lastError).toBeNull();
      expect(ok.lastCheckedAt).not.toBeNull();
      expect(Object.keys(ok.applied)).toEqual(['u-ok']);
    });

    it('无窗口（getWindows 为空）跳过本跳', async () => {
      windows.length = 0;
      await call('pom:booksource-sub-save', makeSubInput());

      scheduler.start();
      await vi.advanceTimersByTimeAsync(SUB_BOOT_DELAY_MS + SUB_TICK_MS);
      await flush();

      expect(safeNetRequestMock).not.toHaveBeenCalled();
    });

    it('stop 清 timer：推进时间不再触发', async () => {
      await call('pom:booksource-sub-save', makeSubInput());
      scheduler.start();
      scheduler.stop();
      await vi.advanceTimersByTimeAsync(SUB_BOOT_DELAY_MS + SUB_TICK_MS * 2);
      await flush();
      expect(safeNetRequestMock).not.toHaveBeenCalled();
    });
  });
});
