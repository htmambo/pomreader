/**
 * 书源订阅自动更新 IPC handler + 调度器（设计 §6，Phase 2 主进程后端）
 *
 * 状态文件 <userData>/booksource-subscriptions.json（§6.1）：
 *   { version: 1, items: SubscriptionRecord[] }，applied 基线只存状态文件，
 *   pom:booksource-sub-list 返回时剥离（不暴露给渲染端）。
 *   读写走 atomicWrite；文件不存在视为空表；损坏备份为 .corrupt-<ts> 后从空表起步。
 *
 * 四个 invoke channel：
 * - pom:booksource-sub-list() → SubscriptionItem[]（剥离 applied）
 * - pom:booksource-sub-save(item) → SubscriptionItem（无 id 视为新增，主进程生成随机 id）
 * - pom:booksource-sub-delete(id) → void
 * - pom:booksource-sub-check(id) → { changed, conflicts, error }（立即检查，跑调度同款逻辑）
 *
 * 检查流程（§6.2/§6.3）：safeNetRequest 拉取（SSRF 防护与编码转换沿用）→ parseBundle
 * （失败记 lastError）→ 以状态文件 applied 为 baseline 调 diffBundle → new/update 逐条
 * atomicWrite（uuid 命中改名源时原地更新 matchedFileName）；conflict 不写盘只计数 →
 * 成功后 applied[uuid]=sha256(content)（仅本订阅写入的条目）+ lastCheckedAt + lastError=null
 * → 有写入或有冲突时逐个窗口广播 pom:booksource-updated
 *   { source: 'subscription', subscriptionId, changed, conflicts }。
 * 拉取/解析失败只记 lastError（不更新 lastCheckedAt，§6.1 null = 从未成功），等下一跳。
 *
 * 调度（§6.3）：单条 setInterval 30 分钟一跳，start 后 60 秒先跑一次；每跳只处理
 * enabled 且到期的订阅；失败不阻断同跳其他订阅；无窗口（getWindows().length===0）
 * 跳过本跳；stop 清 timer。所有检查（调度 + 立即检查）经同一 promise 链串行化，
 * 防状态文件并发写。
 */
import type { BrowserWindow, IpcMain } from 'electron';
import { randomUUID } from 'node:crypto';
import * as fs from 'fs';
import * as path from 'path';
import { atomicWrite, readLocalSources } from './booksource-meta';
import { BUNDLE_MAX_BYTES, diffBundle, parseBundle, sha256 } from './booksource-bundle';
import { safeNetRequest } from './safe-net';
import {
  safeHandleWithMeta,
  BooksourceSubCheckArgsSchema,
  BooksourceSubDeleteArgsSchema,
  BooksourceSubListArgsSchema,
  BooksourceSubSaveArgsSchema,
} from './schema';

export const SUBSCRIPTIONS_FILE = 'booksource-subscriptions.json';
/** 调度周期：30 分钟一跳（§6.3） */
export const SUB_TICK_MS = 30 * 60 * 1000;
/** 启动后 60 秒先跑一次（避开冷启动磁盘高峰，§6.3） */
export const SUB_BOOT_DELAY_MS = 60 * 1000;

const UPDATED_CHANNEL = 'pom:booksource-updated';

/** 渲染端可见的订阅条目（设计 §6.1；applied 基线不暴露） */
export interface SubscriptionItem {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  intervalHours: number;
  /** 最近一次成功检查时间（ms）；null = 从未成功 */
  lastCheckedAt: number | null;
  /** 最近一次失败原因；null = 无 */
  lastError: string | null;
}

/** 状态文件内的完整记录（含冲突判定基线 applied，§6.2） */
export interface SubscriptionRecord extends SubscriptionItem {
  /** applied[uuid] = 上次本订阅成功写入时 content（BookSourceDoc JSON 全文）的 sha256 */
  applied: Record<string, string>;
}

export interface SubscriptionCheckResult {
  changed: number;
  conflicts: number;
  error: string | null;
}

export interface SubscriptionUpdatedPayload {
  source: 'subscription';
  subscriptionId: string;
  changed: number;
  conflicts: number;
}

export interface BookSourceSubscriptionScheduler {
  start(): void;
  stop(): void;
}

/** 到期判定（§6.3）：enabled 且（从未成功 或 lastCheckedAt + intervalHours 已过） */
export function isDue(
  item: Pick<SubscriptionItem, 'enabled' | 'lastCheckedAt' | 'intervalHours'>,
  now: number,
): boolean {
  if (!item.enabled) return false;
  if (item.lastCheckedAt === null) return true;
  return item.lastCheckedAt + item.intervalHours * 3600_000 <= now;
}

function statePath(userData: string): string {
  return path.join(userData, SUBSCRIPTIONS_FILE);
}

function asStringRecord(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

/** 单条记录归一化；缺 id/url 的条目不可恢复，丢弃（不触发整表损坏备份） */
function normalizeItem(raw: unknown): SubscriptionRecord | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !r.id) return null;
  if (typeof r.url !== 'string' || !r.url) return null;
  return {
    id: r.id,
    name: typeof r.name === 'string' && r.name ? r.name : r.url,
    url: r.url,
    enabled: r.enabled === true,
    intervalHours:
      typeof r.intervalHours === 'number' &&
      Number.isFinite(r.intervalHours) &&
      r.intervalHours >= 1
        ? r.intervalHours
        : 12,
    lastCheckedAt: typeof r.lastCheckedAt === 'number' ? r.lastCheckedAt : null,
    lastError: typeof r.lastError === 'string' ? r.lastError : null,
    applied: asStringRecord(r.applied),
  };
}

function backupCorrupt(file: string): void {
  try {
    fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
  } catch {
    /* 备份失败不阻断：仍从空表起步 */
  }
}

/**
 * 读状态文件。文件不存在 → 空表；JSON 解析失败 / 顶层形状非法 → 备份为
 * .corrupt-<ts> 后从空表起步（防启动崩）；单条畸形记录丢弃，其余保留。
 */
export function loadSubscriptions(userData: string): SubscriptionRecord[] {
  const file = statePath(userData);
  if (!fs.existsSync(file)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    backupCorrupt(file);
    return [];
  }
  if (
    typeof raw !== 'object' ||
    raw === null ||
    !Array.isArray((raw as { items?: unknown }).items)
  ) {
    backupCorrupt(file);
    return [];
  }
  return (raw as { items: unknown[] }).items
    .map(normalizeItem)
    .filter((i): i is SubscriptionRecord => i !== null);
}

function saveSubscriptions(userData: string, items: SubscriptionRecord[]): void {
  atomicWrite(statePath(userData), JSON.stringify({ version: 1, items }, null, 2));
}

/** 剥离 applied 基线（不暴露给渲染端，§6.1 / 任务契约） */
function toPublicItem(item: SubscriptionRecord): SubscriptionItem {
  const { id, name, url, enabled, intervalHours, lastCheckedAt, lastError } = item;
  return { id, name, url, enabled, intervalHours, lastCheckedAt, lastError };
}

function broadcast(getWindows: () => BrowserWindow[], payload: SubscriptionUpdatedPayload): void {
  for (const win of getWindows()) {
    const wc = win.webContents;
    if (!wc || wc.isDestroyed()) continue;
    try {
      wc.send(UPDATED_CHANNEL, payload);
    } catch {
      /* 窗口已销毁 */
    }
  }
}

/**
 * 单订阅检查（调度与立即检查共用同一套拉取/diff/写盘逻辑）。
 * 除状态文件写盘异常外不抛错：失败路径记 lastError 并落盘后返回 error。
 */
async function runCheck(
  item: SubscriptionRecord,
  items: SubscriptionRecord[],
  userData: string,
  getWindows: () => BrowserWindow[],
): Promise<SubscriptionCheckResult> {
  const fail = (error: string): SubscriptionCheckResult => {
    item.lastError = error;
    // 失败不更新 lastCheckedAt（§6.1 null = 从未成功）：等下一跳自然重试，不重试风暴
    saveSubscriptions(userData, items);
    return { changed: 0, conflicts: 0, error };
  };

  let text: string;
  try {
    const resp = await safeNetRequest(item.url, {
      accept: 'application/json',
      maxBytes: BUNDLE_MAX_BYTES,
    });
    if (resp.status < 200 || resp.status >= 300) {
      return fail(`拉取失败: HTTP ${resp.status}`);
    }
    text = resp.body;
  } catch (err) {
    return fail(`拉取失败: ${(err as Error).message}`);
  }

  let sources: ReturnType<typeof parseBundle>['sources'];
  try {
    sources = parseBundle(text).sources;
  } catch (err) {
    return fail(`解析失败: ${(err as Error).message}`);
  }

  const dir = path.join(userData, 'booksources');
  const entries = diffBundle(sources, readLocalSources(dir), item.applied);
  fs.mkdirSync(dir, { recursive: true });
  let changed = 0;
  let conflicts = 0;
  const writeErrors: string[] = [];
  for (const entry of entries) {
    if (entry.kind === 'identical') continue;
    if (entry.kind === 'conflict') {
      // 本地在上次订阅写入后被改过：不写盘，计数进通知，交由用户裁决（§6.2）
      conflicts += 1;
      continue;
    }
    // new / update：uuid 优先匹配命中改名源时原地更新（matchedFileName），避免重复落盘
    const target = entry.matchedFileName ?? entry.fileName;
    try {
      atomicWrite(path.join(dir, target), entry.content);
      // applied 基线只记本订阅写入的条目（§6.2）
      item.applied[entry.uuid] = sha256(entry.content);
      changed += 1;
    } catch (err) {
      // 批量不原子（§8 取舍 1）：单条失败收集后报告，不回滚已写项
      writeErrors.push(`${target}: ${(err as Error).message}`);
    }
  }
  item.lastCheckedAt = Date.now();
  item.lastError = writeErrors.length > 0 ? `写入失败: ${writeErrors.join('; ')}` : null;
  saveSubscriptions(userData, items);
  if (changed > 0 || conflicts > 0) {
    broadcast(getWindows, {
      source: 'subscription',
      subscriptionId: item.id,
      changed,
      conflicts,
    });
  }
  return { changed, conflicts, error: item.lastError };
}

export function registerBookSourceSubscriptionHandler(
  ipcMain: IpcMain,
  userData: string,
  getWindows: () => BrowserWindow[],
): BookSourceSubscriptionScheduler {
  // 所有检查（调度跳 + 立即检查）经同一 promise 链串行化：防状态文件并发写、
  // 防同一订阅并发拉取。chain 自身吸收 rejection，永不中断后续任务。
  let chain: Promise<unknown> = Promise.resolve();
  const serialize = <T>(job: () => Promise<T>): Promise<T> => {
    const result = chain.then(job);
    chain = result.catch(() => {});
    return result;
  };

  const checkOne = (id: string): Promise<SubscriptionCheckResult> =>
    serialize(async () => {
      const items = loadSubscriptions(userData);
      const item = items.find((i) => i.id === id);
      if (!item) throw new Error(`订阅不存在: ${id}`);
      return runCheck(item, items, userData, getWindows);
    });

  safeHandleWithMeta(
    ipcMain,
    'pom:booksource-sub-list',
    'BooksourceSubListArgs',
    BooksourceSubListArgsSchema,
    () => loadSubscriptions(userData).map(toPublicItem),
  );

  safeHandleWithMeta(
    ipcMain,
    'pom:booksource-sub-save',
    'BooksourceSubSaveArgs',
    BooksourceSubSaveArgsSchema,
    (_e, [input]) => {
      const items = loadSubscriptions(userData);
      const existing = input.id ? items.find((i) => i.id === input.id) : undefined;
      const record: SubscriptionRecord = {
        // 无 id 视为新增，主进程生成随机 id；applied 基线仅已存在条目保留
        id: existing?.id ?? input.id ?? randomUUID(),
        name: input.name,
        url: input.url,
        enabled: input.enabled,
        intervalHours: input.intervalHours,
        lastCheckedAt: input.lastCheckedAt ?? null,
        lastError: input.lastError ?? null,
        applied: existing?.applied ?? {},
      };
      const idx = items.findIndex((i) => i.id === record.id);
      if (idx >= 0) items[idx] = record;
      else items.push(record);
      saveSubscriptions(userData, items);
      return toPublicItem(record);
    },
  );

  safeHandleWithMeta(
    ipcMain,
    'pom:booksource-sub-delete',
    'BooksourceSubDeleteArgs',
    BooksourceSubDeleteArgsSchema,
    (_e, [id]) => {
      const items = loadSubscriptions(userData);
      const next = items.filter((i) => i.id !== id);
      if (next.length !== items.length) saveSubscriptions(userData, next);
    },
  );

  safeHandleWithMeta(
    ipcMain,
    'pom:booksource-sub-check',
    'BooksourceSubCheckArgs',
    BooksourceSubCheckArgsSchema,
    (_e, [id]) => checkOne(id),
  );

  const tick = (): Promise<void> =>
    serialize(async () => {
      if (getWindows().length === 0) return; // 无窗口跳过本跳（§6.3）
      const items = loadSubscriptions(userData);
      const now = Date.now();
      for (const item of items) {
        if (!isDue(item, now)) continue;
        // runCheck 失败只记 lastError，不抛错 → 不阻断同跳其他订阅（§6.3）
        await runCheck(item, items, userData, getWindows);
      }
    });

  let bootTimer: ReturnType<typeof setTimeout> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  return {
    start() {
      if (timer) return;
      bootTimer = setTimeout(() => {
        void tick().catch((err) => console.warn('[booksource-subscription] tick 失败:', err));
      }, SUB_BOOT_DELAY_MS);
      bootTimer.unref?.();
      timer = setInterval(() => {
        void tick().catch((err) => console.warn('[booksource-subscription] tick 失败:', err));
      }, SUB_TICK_MS);
      timer.unref?.();
    },
    stop() {
      if (bootTimer) clearTimeout(bootTimer);
      if (timer) clearInterval(timer);
      bootTimer = null;
      timer = null;
    },
  };
}
