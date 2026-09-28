/**
 * BookshelfGroup — 书架分类（对齐 legado 书架分组）
 *
 * 分类本身独立成文档（`group:{id}`，type: 'group'），书籍通过 Book.groupIds 反向持有归属，
 * 因此「一本书可同时属于多个分类」，删除分类只需清理各书的 groupIds，不需要重写 Book 文档集合。
 *
 * 排序：按 createdAt 升序（新建分类排在末尾），同毫秒创建时用 name 兜底保证稳定。
 */
export interface BookshelfGroup {
  /** UUID（crypto.randomUUID） */
  id: string;
  /** 分类名，去首尾空白后 1-12 字 */
  name: string;
  /** 创建时间（ISO 字符串） */
  createdAt: string;
}

/** 分类名长度上限（与弹窗校验一致） */
export const GROUP_NAME_MAX = 12;
