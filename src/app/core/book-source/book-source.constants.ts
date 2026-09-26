/**
 * 书源锚定标识常量（项目 Book.bookSourceUuid 字段用）
 *
 * - JsSourceAdapter 来源：写 meta.uuid（legado 协议字段，每个书源全局唯一）
 * - 万能搜索 / 启发式兜底：写 UNIVERSAL_BOOK_SOURCE_UUID（非具体书源标识）
 * - 未填：历史数据 / 本地导入
 *
 * 用法：所有涉及 'universal' 的代码必须 import 此常量，禁止裸字符串字面量，
 * 避免拼写错误破坏 invariant。
 */

/** 万能搜索 / 启发式兜底锚定标识（非具体书源） */
export const UNIVERSAL_BOOK_SOURCE_UUID = 'universal' as const;

/**
 * Book.bookSourceUuid 的合法类型 —— 任何非空字符串 + UNIVERSAL 标识
 * （空字符串等价于 undefined，consumer 用 `?? UNIVERSAL_BOOK_SOURCE_UUID` 兜底）
 */
export type BookSourceUuid = string;
