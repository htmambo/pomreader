/**
 * 书源元数据类型（spec §3.3 + 实施计划 T-001）
 *
 * 与 legado `BookSourceMeta` 字段对齐，避免用户从 legado 导入的书源显示异常。
 * parser 是纯函数，输出此结构，IPC handler / Worker 装配层再加 IO。
 *
 * **位置**：原在 `js-source/source-meta.types.ts`，P3.4 迁到 `core/book-source/` ——
 * 它同时描述 `.json` 规则源与 legacy 清单，留在 `js-source/` 里会让 JSON 链路
 * 反向依赖一个 P4 要整个删掉的目录。
 */

import { SOURCE_TYPES, type SourceType } from '../models/book-source-doc.model';

/** `SourceType` / `SOURCE_TYPES` 以 `book-source-doc.model.ts` 为单一出处（见该文件头 P3.4 说明） */
export { SOURCE_TYPES, type SourceType };

export interface BookSourceMeta {
  /** 内部 sourceKey = uuid（用于 registry 注册匹配） */
  sourceKey: string;
  uuid: string;
  fileName: string;
  name: string;
  /** 第一条 @url 作主；与 legado model 一致 */
  url: string;
  /** 全部 @url（多镜像轮询用，spec FR-1.3） */
  urls: string[];
  author?: string;
  logo?: string;
  /** 多条 @description 拼换行 */
  description?: string;
  enabled: boolean;
  fileSize: number;
  modifiedAt: number;
  sourceDir: string;
  sourceType: SourceType;
  version: string;
  updateUrl?: string;
  tags: string[];
  minDelayMs: number;
  requireUrls: string[];

  // ── JSON 规则源字段（`baseJsonMeta` / `parseJsonMeta`，主进程 P2.1 追加）──

  /**
   * 文件格式标记：`'json'` = 规则文档，缺席 = 旧 `.js`
   *
   * **分派依据**。刻意不用后缀猜：`.json` 源也可能残留 marker 时代的伴生文件，
   * 而 `.js` 侧永远不会有 `format` 字段。
   */
  format?: 'json';
  /**
   * 规则坏掉的原因（`parseJsonMeta` 抽取 `error` 字段），`null` = 规则可用
   *
   * 坏规则的源**仍会出现在列表里**（用户看得见、知道要修），但引擎拒绝用它匹配 ——
   * 红色标记在这里，文案由列表页展示。
   */
  rulesInvalid?: string | null;
}

/** 是否 JSON 规则源（元数据分派的唯一依据，见 `format` 字段注释） */
export function isJsonSourceMeta(meta: BookSourceMeta): boolean {
  return meta.format === 'json';
}
