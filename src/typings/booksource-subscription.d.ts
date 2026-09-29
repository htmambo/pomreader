/**
 * 书源订阅自动更新（Phase 2）渲染端契约类型
 *
 * 设计：docs/Architecture/2026-09-28-BOOKSOURCE_IMPORT_EXPORT_DESIGN.md §6
 * 通道挂点：window.pomAPI（组织方式同 booksource-bundle.d.ts —— 形状集中在此，
 * `declare global Window.pomAPI` 合并在 page-fetcher.service.ts）。
 * 形状与 electron/ipc/booksource-subscription.ts 的实际返回保持一致。
 */

/** 订阅条目（booksource-subscriptions.json items[] 的渲染端镜像，设计 §6.1） */
interface BookSourceSubscription {
  /** 随机 uuid；新增时传空串，由主进程生成 */
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  /** 检查间隔（小时），默认 12 */
  intervalHours: number;
  /** 上次成功检查时间戳；null = 从未成功 */
  lastCheckedAt: number | null;
  /** 最近一次失败原因；null = 无 */
  lastError: string | null;
}

/** pom:booksource-sub-check（立即检查）返回 */
interface BookSourceSubCheckResult {
  /** 本次写入（new + update）的书源数 */
  changed: number;
  /** 远端更新但本地也改过、跳过自动写入的冲突数（本 Phase 只提示，不做冲突解决 UI） */
  conflicts: number;
  /** 拉取 / 解析整体失败原因；非 null 时 changed/conflicts 无意义 */
  error: string | null;
}

/**
 * 订阅检查有写入 / 冲突时主进程广播 pom:booksource-updated 的 payload（设计 §6.3）。
 * Phase 1 的 bundle 导入广播为 { source: 'bundle-import', count }，渲染端按 source 区分
 */
interface BookSourceSubUpdatedPayload {
  source: 'subscription';
  subscriptionId: string;
  changed: number;
  conflicts: number;
}

/** 四条订阅 IPC 在 window.pomAPI 上的挂点形状（pom:booksource-sub-list / save / delete / check） */
interface PomBookSourceSubscriptionApi {
  /** 全量订阅列表 */
  booksourceSubList?: () => Promise<BookSourceSubscription[]>;
  /** 保存 / 更新（新增时 id 传空串，主进程生成；lastCheckedAt/lastError 由主进程维护）；返回落盘后的条目 */
  booksourceSubSave?: (item: BookSourceSubscription) => Promise<BookSourceSubscription>;
  booksourceSubDelete?: (id: string) => Promise<void>;
  /** 立即检查一条订阅（不等调度），返回本次结果 */
  booksourceSubCheck?: (id: string) => Promise<BookSourceSubCheckResult>;
}
