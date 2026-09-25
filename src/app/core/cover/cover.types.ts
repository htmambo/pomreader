/**
 * 封面服务类型定义（实施计划 T-008 + spec FR-3）
 *
 * 与 electron/preload.ts 中 `coverResolveCache` 的 IPC 契约对齐：
 * 请求体 = CoverRequest；返回体 = CoverResolveResult。
 */

/** 单个封面解析请求 */
export interface CoverRequest {
  url: string;
  referer?: string;
  headers?: Record<string, string>;
}

/** 封面解析结果（主进程 IPC 返回值） */
export interface CoverResolveResult {
  /** 绝对路径（renderer 仅用于诊断，不直接渲染） */
  localPath: string;
  /** "local://" + localPath；renderer 兼容引用格式 */
  localRef: string;
}

/** 缓存统计（FR-3.5 管理页 UI 入口） */
export interface CoverCacheStats {
  totalBytes: number;
  fileCount: number;
}