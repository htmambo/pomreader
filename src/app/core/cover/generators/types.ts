/**
 * 内置封面生成器类型定义（迁移自 legado src/utils/coverGenerators/types.ts）
 * 字段对齐 pomreader Book 模型（title/author + 可选 kind）
 */

/** 生成器需要的最小书籍信息（与 pomreader Book 兼容） */
export interface CoverBookInput {
  title: string;
  author: string;
  /** 题材/类型；缺省时各 generator 用自己的 fallback 文案 */
  kind?: string;
}

export interface BuiltinCoverGeneratorDefinition {
  id: string;
  name: string;
  description: string;
  /** 返回 data:image/svg+xml URL */
  generate: (book: CoverBookInput) => string;
}
