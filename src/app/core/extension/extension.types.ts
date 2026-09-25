/**
 * 扩展系统类型定义（实施计划 T-010 + spec FR-4）
 *
 * UserScript 头部元数据：扫描 `// ==UserScript==` 块（前 100 行）。
 * 字段命名与 legado `ExtensionMeta` 保持一致；list 由主进程 extension-handler 返回。
 * Renderer 端 parseUserScriptMeta 与主进程解析逻辑对齐（仅渲染层预解析时使用）。
 */

export interface ExtensionMeta {
  fileName: string;
  name: string;
  namespace: string;
  version: string;
  description: string;
  author: string;
  /** @match / @include 数组 */
  matchPatterns: string[];
  /** @grant 数组（已过滤 `none`） */
  grants: string[];
  /** @run-at 值：`document-end` / `document-start` / `document-idle` */
  runAt: string;
  /** @category 自定义分类 */
  category: string;
  enabled: boolean;
  fileSize: number;
  modifiedAt: number;
}