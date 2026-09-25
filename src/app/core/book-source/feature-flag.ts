/**
 * 书源 Feature Flag（spec §9 风险缓解 + 实施计划 §8 回滚策略）
 *
 * `enableJsSource = false` 时：
 * - APP_INITIALIZER 跳过 JS 书源加载
 * - 已注册 JS 适配器从 registry unregister（v1 仅跳过加载，后续接入 unregister）
 * - 内置适配器继续生效（不破坏现有阅读功能）
 */
export interface BookSourceFeatureFlags {
  /** false：仅内置适配器 + 启发式兜底；true：加载 JS 书源作为 BookSourceAdapter */
  enableJsSource: boolean;
}

export const BOOK_SOURCE_FEATURE_FLAGS: BookSourceFeatureFlags = {
  enableJsSource: true,
};