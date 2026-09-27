/**
 * Worker Pool 工厂（EV-3 现状 — Phase 4 architect/code-review 评审后正式 defer）
 *
 * 现状（2026-09-27 review）：
 * - 完整 WorkerPoolImpl（pool≤4 / pending≤8 / 30s terminate-before-reject / LRU≤50
 *   / exit-refill）已在 worker-pool.ts 实现 + 7 个 spec 覆盖
 * - 但 sandbox.service.ts 通过 worker 协议（postMessage + WorkerTask）与 worker.ts 通讯，
 *   而 factory 的 WorkerLike.run<T>(task: () => Promise<T>) 接口是 function-based，
 *   两者协议不兼容 —— 强制 wire 需重新设计 sandbox ↔ worker 抽象
 * - Phase 4 双评审（architect + code-reviewer）判定当前 ship "渐进迁移"为 50%
 * - 决策：保留 WorkerPoolImpl + tests 作为未来 P3 sprint 资产，
 *   factory 简化：默认走 SynchronousWorkerAdapter + kill-switch 仍生效
 *
 * Kill-switch 语义：
 * - localStorage['pom.workerPool'] === 'false' → 同步执行 + warn log（生产环境紧急止血）
 * - 其它值（包括 '0' / 'true' / 缺省） → 同步执行（placeholder，未来 P3 替换为 WorkerPoolImpl）
 *
 * 设计原则：
 * - SynchronousWorkerAdapter 与未来 WorkerPool 共享 WorkerLike 接口，无痛切换
 * - 同步执行不做沙箱隔离（仅做"能跑通"的最低保障）；生产仍走 sandbox.worker.ts
 * - kill-switch 通过 localStorage 读取，无需重新打包即可启用/关闭
 */
import { SandboxService } from './sandbox.service';

/** WorkerLike 抽象接口（pool 调度 / sync adapter 都实现此接口） */
export interface WorkerLike {
  /** 调度一次书源脚本编译+调用（异步） */
  run<T>(task: () => Promise<T>): Promise<T>;
  /** 终止 worker（pool 模式下清理资源） */
  terminate(): void;
}

/** 同步降级：在主线程直接执行 task，无沙箱保护（kill-switch 专用） */
export class SynchronousWorkerAdapter implements WorkerLike {
  async run<T>(task: () => Promise<T>): Promise<T> {
    return await task();
  }
  terminate(): void {
    /* no-op：同步执行无 worker 可终止 */
  }
}

/**
 * 创建 Worker Pool 工厂入口（当前简化为：始终返回 SynchronousWorkerAdapter）
 *
 * - kill-switch `localStorage['pom.workerPool'] === 'false'` → 同步执行 + warn log
 * - 默认 → 同步执行（placeholder）
 *
 * TODO(P3): 待 sandbox.service.ts 与 worker 协议重构完成后，替换为：
 * ```ts
 * import { WorkerPoolImpl } from './worker-pool';
 * return new WorkerPoolImpl({
 *   workerFactory: () => new Worker(new URL('assets/sandbox.worker.js', ...)),
 *   size: 4,
 *   pendingCap: 8,
 *   timeoutMs: 30_000,
 *   lruMax: 50,
 * });
 * ```
 */
export function createWorkerPool(_sandbox?: SandboxService): WorkerLike {
  const killSwitch =
    typeof localStorage !== 'undefined' &&
    localStorage.getItem('pom.workerPool') === 'false';

  if (killSwitch) {
     
    console.warn('[pom] WorkerPool disabled via kill-switch, using sync adapter');
  }
  return new SynchronousWorkerAdapter();
}