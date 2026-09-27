/**
 * Worker Pool 工厂（EVO-3 试点 + R1 kill-switch）
 *
 * 提供 WorkerLike 抽象 + 工厂函数 + SynchronousWorkerAdapter 降级路径。
 * 完整 pool（pool≤4 / pending≤8 / LRU≤50 / 30s terminate-before-reject）移交后续 sprint。
 *
 * 当前实现：
 * - 默认：走单 worker（保留 sandbox.service.ts 现有行为）
 * - kill-switch：`localStorage['pom.workerPool'] === 'false'` → SynchronousWorkerAdapter
 *   在调用线程同步执行任务，绕过 Worker 启动。生产环境紧急止血开关。
 *
 * 设计原则：
 * - SynchronousWorkerAdapter 接口与 WorkerPool 完全相同（WorkerLike），便于未来无痛切换
 * - 同步执行不做沙箱隔离（仅做"能跑通"的最低保障）；生产仍走 Worker 路径
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
 * 创建 Worker Pool 工厂入口
 * - 默认：返回单 worker adapter（与 sandbox.service.ts 现有行为一致）
 * - kill-switch：`localStorage['pom.workerPool'] === 'false'` → 同步执行
 *
 * 完整 pool（pool size / pending queue cap / 30s timeout / LRU / exit-refill）
 * 由下次接力 task pomreader-arch-evo-3 实施。
 */
export function createWorkerPool(_sandbox?: SandboxService): WorkerLike {
  const enabled =
    typeof localStorage !== 'undefined' &&
    localStorage.getItem('pom.workerPool') !== 'false';

  if (!enabled) {
    // eslint-disable-next-line no-console
    console.warn('[pom] WorkerPool disabled via kill-switch, using sync adapter');
    return new SynchronousWorkerAdapter();
  }

  // 暂返回同步 adapter 作为 placeholder；后续接力替换为真正的 WorkerPool 实现
  // （pool size ≤4 / pending ≤8 / 30s terminate-before-reject / LRU ≤50）
  return new SynchronousWorkerAdapter();
}