/**
 * 书源 JS 元数据类型（spec §3.3 + 实施计划 T-001）
 *
 * 与 legado `BookSourceMeta` 字段对齐，避免用户从 legado 导入的书源显示异常。
 * parser 是纯函数，输出此结构，IPC handler / Worker 装配层再加 IO。
 */

/** 5 种 sourceType（spec §3.3）—— 非法降级 novel */
export type SourceType = 'novel' | 'comic' | 'video' | 'music' | 'webpage';

export const SOURCE_TYPES: readonly SourceType[] = [
  'novel',
  'comic',
  'video',
  'music',
  'webpage',
] as const;

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
}