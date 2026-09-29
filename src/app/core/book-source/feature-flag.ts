/**
 * 书源 Feature Flag（spec §9 风险缓解 + 实施计划 §8 回滚策略）
 *
 * 两层开关，**刻意分层**：
 * 1. `BOOK_SOURCE_FEATURE_FLAGS.enableJsSource` —— **编译期**总闸，源码里就写死。
 *    改它要重新打包，是灾难级回滚的最后一道（"把整条 JS 链路彻底关掉"）。
 * 2. `pom.bookSource.engine` —— **运行时**开关，localStorage，调试期不重启就能切。
 *    过渡期（P1~P3）两条链路并存，这层是日常排障与灰度的主战场；P4 连同 JS 链路一起删。
 */

/** 编译期总闸：`false` 时 JS 书源链路一律不装载（含运行时开关选了 'js'/'both'） */
export interface BookSourceFeatureFlags {
  enableJsSource: boolean;
}

export const BOOK_SOURCE_FEATURE_FLAGS: BookSourceFeatureFlags = {
  enableJsSource: true,
};

// ── 运行时开关（P1.7）──

/** localStorage 键名（与 `pom.cssRules`、`pom.settings` 同前缀风格） */
export const BOOK_SOURCE_ENGINE_KEY = 'pom.bookSource.engine';

/**
 * 运行时链路选择：
 * - `rule`：只用 JSON 规则引擎
 * - `js`：只用旧沙箱链路（存量源的应急回退通道，**必须一直能用**，直到 P4）
 * - `both`：并存，同 uuid 时 JSON 胜出（方案 §3.3）
 */
export const BOOK_SOURCE_ENGINES = ['rule', 'js', 'both'] as const;
export type BookSourceEngine = (typeof BOOK_SOURCE_ENGINES)[number];

/** 缺省 'rule'（方案 §3.3） */
export const DEFAULT_BOOK_SOURCE_ENGINE: BookSourceEngine = 'rule';

/** 读运行时开关；未设置 / 值非法（含旧版本遗留的乱值）→ 缺省 'rule'，不抛 */
export function readBookSourceEngine(): BookSourceEngine {
  const raw = readStorage(BOOK_SOURCE_ENGINE_KEY);
  return BOOK_SOURCE_ENGINES.includes(raw as BookSourceEngine)
    ? (raw as BookSourceEngine)
    : DEFAULT_BOOK_SOURCE_ENGINE;
}

/** 写运行时开关；非法值直接忽略（不给"写进去一个拼错的值然后链路静默失效"留机会） */
export function writeBookSourceEngine(engine: BookSourceEngine): void {
  if (!BOOK_SOURCE_ENGINES.includes(engine)) {
    console.warn(`[feature-flag] 忽略非法的 bookSourceEngine 值：${String(engine)}`);
    return;
  }
  try {
    localStorage.setItem(BOOK_SOURCE_ENGINE_KEY, engine);
  } catch (e) {
    // 隐私模式 / 配额满：开关写不进去不该让应用崩，降级为"本次会话用缺省值"
    console.warn('[feature-flag] 写 bookSourceEngine 失败，沿用缺省值', e);
  }
}

/** 本次会话要不要装载 JSON 规则适配器 / JS 沙箱适配器 */
export interface EngineMode {
  useRule: boolean;
  useJs: boolean;
}

/**
 * 把「开关值 + 编译期总闸 + 当前是否已有 JSON 规则源」解析成实际的装载策略
 *
 * ## `hasRuleDocs` 这条 fail-open 兜底 —— P3 接上规则适配器后**仍然保留**（D12）
 *
 * 缺省是 `'rule'`。若机械照搬 `'rule' → 不装 JS`，用户升级后打开应用会发现
 * **所有书源凭空消失** —— 开关自己关掉了自己唯一的实现。故规则是：
 * **选了 `rule` 且一个 JSON 规则源都没有时，仍然装载 JS 链路**。
 *
 * 原判断是"P3 接上 `registerRuleAdapters` 后 `hasRuleDocs` 恒为真，这条兜底自然失效"。
 * **这个推断是错的**：`hasRuleDocs` 恒为真的前提是"每个用户都成功迁移了"。而迁移
 * 失败是常规场景而非边缘情况 —— `booksources/` 不可写、盘满、外部目录无权限，
 * 都会让全部源留在 `.js`。那时删掉兜底的结果正是它当初要防的事故：书源整体消失。
 * 兜底的前提是**用户磁盘上的实际状态**，不是代码进度，所以它不随阶段失效。
 *
 * 真正的删除时机是 P4（`js-source/` 整目录删除、`.js` 不再是可加载格式），
 * 届时 `useJs` 整个概念一起消失。过渡期宁好多装一条链路。
 *
 * `enableJsSource === false`（编译期总闸）优先级最高：它一旦关，JS 一律不装。
 */
export function resolveEngineMode(engine: BookSourceEngine, hasRuleDocs: boolean): EngineMode {
  if (!BOOK_SOURCE_FEATURE_FLAGS.enableJsSource) {
    return { useRule: engine !== 'js', useJs: false };
  }
  if (engine === 'js') return { useRule: false, useJs: true };
  if (engine === 'both') return { useRule: true, useJs: true };
  // engine === 'rule'
  return { useRule: true, useJs: !hasRuleDocs };
}

/** localStorage 读取：非浏览器环境 / 抛错一律当"没设过" */
function readStorage(key: string): string | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}
