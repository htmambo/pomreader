/**
 * Worker Pool — 调度器（EVO-3 完整实现）
 *
 * 规格（A12 v2 patch）：
 * - pool size ≤ 4（上限 4 个并发 worker）
 * - pending queue cap = 8（反压：超出抛 PoolFullError）
 * - 30s 超时必须先 terminate worker 再 reject（禁止 reject-without-terminate）
 * - worker exit/error 事件自动 refill（crashed worker 上的 in-flight promise reject WorkerCrashedError）
 * - LRU ≤50（modules 缓存淘汰最旧条目）
 * - kill-switch `localStorage['pom.workerPool'] === 'false'` → SynchronousWorkerAdapter
 *
 * 通信：postMessage (reqId → result)；与 sandbox.worker.ts 协议一致。
 * 调用方（sandbox.service.ts）接 WorkerLike 接口（worker-pool.factory.ts），
 * 不直接用本类（factory 负责 kill-switch 决策）。
 */

import { WorkerLike } from './worker-pool.factory';

/** PoolFullError：pending queue cap 已满，调用方应 backoff 或放弃 */
export class PoolFullError extends Error {
  constructor(public readonly cap: number) {
    super(`WorkerPool is full (cap=${cap}); retry later`);
    this.name = 'PoolFullError';
  }
}

/** WorkerCrashedError：worker 进程崩溃 / exit，in-flight task 失败 */
export class WorkerCrashedError extends Error {
  constructor(reason: string) {
    super(`Worker crashed: ${reason}`);
    this.name = 'WorkerCrashedError';
  }
}

/** 任务类型（与 sandbox.worker.ts 协议匹配） */
export type WorkerTask =
  | { type: 'load'; fileName: string; source: string; reqId: string }
  | { type: 'call'; fileName: string; fn: string; args: unknown[]; reqId: string };

/** Worker 任务结果 */
export interface WorkerResult {
  ok: boolean;
  value?: unknown;
  error?: string;
}

/** Worker 抽象接口（real Worker / mock Worker 都实现） */
export interface WorkerLikeInternal {
  postMessage(msg: unknown): void;
  terminate(): void;
  onmessage: ((e: { data: WorkerResult & { reqId: string } }) => void) | null;
  onerror: ((e: unknown) => void) | null;
  onmessageerror: ((e: unknown) => void) | null;
}

/** 调度器配置 */
export interface WorkerPoolConfig {
  size: number; // pool size ≤ 4
  pendingCap: number; // pending queue ≤ 8
  timeoutMs: number; // 30s default
  lruMax: number; // modules ≤ 50
  workerFactory: () => WorkerLikeInternal;
}

const DEFAULT_CONFIG: Omit<WorkerPoolConfig, 'workerFactory'> = {
  size: 4,
  pendingCap: 8,
  timeoutMs: 30_000,
  lruMax: 50,
};

interface PendingEntry {
  task: WorkerTask;
  resolve: (r: WorkerResult) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  workerIdx: number;
}

export class WorkerPoolImpl implements WorkerLike {
  private workers: WorkerLikeInternal[] = [];
  /** modules: fileName → 内部缓存（LRU） */
  private modules: Map<string, unknown> = new Map();
  /** 等待中的任务队列（按 worker 索引分组） */
  private pendingPerWorker: PendingEntry[][] = [];
  /** 全局 pending 总数（用于反压 PoolFullError） */
  private pendingCount = 0;
  private terminated = false;
  private readonly config: WorkerPoolConfig;

  constructor(config: Partial<WorkerPoolConfig> & Pick<WorkerPoolConfig, 'workerFactory'>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    // 预创建 size 个 worker
    for (let i = 0; i < this.config.size; i++) {
      this.spawnWorker(i);
    }
  }

  /** spawn / refill 一个 worker */
  private spawnWorker(idx: number): void {
    if (this.terminated) return;
    const w = this.config.workerFactory();
    w.onmessage = (e) => this.handleMessage(idx, e.data);
    w.onerror = (e) => this.handleError(idx, e);
    w.onmessageerror = (e) => this.handleError(idx, e);
    this.workers[idx] = w;
    this.pendingPerWorker[idx] = this.pendingPerWorker[idx] ?? [];
  }

  /** 处理 worker 消息（task result） */
  private handleMessage(workerIdx: number, msg: WorkerResult & { reqId: string }): void {
    const queue = this.pendingPerWorker[workerIdx];
    if (!queue || queue.length === 0) return;
    const entry = queue.shift()!;
    clearTimeout(entry.timer);
    this.pendingCount--;
    if (msg.ok) {
      entry.resolve(msg);
    } else {
      entry.reject(new Error(msg.error ?? 'unknown'));
    }
    // 派发队列下一任务
    this.dispatchWorker(workerIdx);
  }

  /** 处理 worker error / exit / message-error：terminate + reject in-flight + refill */
  private handleError(workerIdx: number, e: unknown): void {
    const w = this.workers[workerIdx];
    // 1. terminate 当前 worker（释放资源）
    if (w) {
      try {
        w.terminate();
      } catch {
        /* ignore */
      }
    }
    // 2. reject 该 worker 上所有 in-flight tasks（WorkerCrashedError）
    const queue = this.pendingPerWorker[workerIdx] ?? [];
    const crashedTasks = queue.splice(0);
    for (const entry of crashedTasks) {
      clearTimeout(entry.timer);
      this.pendingCount--;
      const reason = (e as { message?: string })?.message ?? 'unknown';
      entry.reject(new WorkerCrashedError(reason));
    }
    // 3. refill 新 worker（如果未 terminated）
    if (!this.terminated) {
      this.spawnWorker(workerIdx);
    }
  }

  /** 派发一个任务到指定 worker（worker 串行处理队列） */
  private dispatchWorker(workerIdx: number): void {
    const queue = this.pendingPerWorker[workerIdx];
    if (!queue || queue.length === 0) return;
    const entry = queue[0];
    const w = this.workers[workerIdx];
    if (!w) return;
    w.postMessage(entry.task);
  }

  /** 公共调度入口：把 task 加到 pending 队列；超出 cap 抛 PoolFullError */
  schedule(task: WorkerTask): Promise<WorkerResult> {
    if (this.terminated) {
      return Promise.reject(new Error('WorkerPool terminated'));
    }
    if (this.pendingCount >= this.config.pendingCap) {
      return Promise.reject(new PoolFullError(this.config.pendingCap));
    }
    // 选择队列最短的 worker（空闲优先；平衡各 worker 负载）
    let workerIdx = 0;
    let minLen = this.pendingPerWorker[0]?.length ?? 0;
    for (let i = 1; i < this.config.size; i++) {
      const len = this.pendingPerWorker[i]?.length ?? 0;
      if (len < minLen) {
        minLen = len;
        workerIdx = i;
      }
    }
    return new Promise<WorkerResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        // 30s 超时：必须 terminate worker before reject（防止僵尸 worker 持续吃 CPU）
        const w = this.workers[workerIdx];
        if (w) {
          try {
            w.terminate();
          } catch {
            /* ignore */
          }
        }
        // 从队列移除
        const queue = this.pendingPerWorker[workerIdx];
        const idx = queue.findIndex((p) => p === entry);
        if (idx >= 0) queue.splice(idx, 1);
        this.pendingCount--;
        // refill 新 worker
        if (!this.terminated) this.spawnWorker(workerIdx);
        reject(new Error(`WorkerPool timeout after ${this.config.timeoutMs}ms`));
      }, this.config.timeoutMs);
      const entry: PendingEntry = { task, resolve, reject, timer, workerIdx };
      this.pendingPerWorker[workerIdx].push(entry);
      this.pendingCount++;
      // 立即派发（如果队列之前为空）
      if (this.pendingPerWorker[workerIdx].length === 1) {
        this.dispatchWorker(workerIdx);
      }
    });
  }

  /** LRU 缓存 modules（fileName → 模块函数表） */
  cacheModule(fileName: string, module: unknown): void {
    if (this.modules.has(fileName)) {
      // 命中：移到末尾（LRU）
      this.modules.delete(fileName);
      this.modules.set(fileName, module);
      return;
    }
    if (this.modules.size >= this.config.lruMax) {
      // 淘汰最旧（Map 保留插入顺序）
      const oldest = this.modules.keys().next().value;
      if (oldest !== undefined) this.modules.delete(oldest);
    }
    this.modules.set(fileName, module);
  }

  /** 查询缓存（命中则移到末尾） */
  getCachedModule<T = unknown>(fileName: string): T | undefined {
    const m = this.modules.get(fileName) as T | undefined;
    if (m !== undefined) {
      this.modules.delete(fileName);
      this.modules.set(fileName, m);
    }
    return m;
  }

  /** 终止所有 worker（pool 关闭） */
  terminate(): void {
    this.terminated = true;
    for (const w of this.workers) {
      try {
        w.terminate();
      } catch {
        /* ignore */
      }
    }
    // reject 所有 pending
    for (const queue of this.pendingPerWorker) {
      for (const entry of queue) {
        clearTimeout(entry.timer);
        entry.reject(new Error('WorkerPool terminated'));
      }
    }
    this.pendingCount = 0;
    this.pendingPerWorker = [];
    this.workers = [];
  }
}