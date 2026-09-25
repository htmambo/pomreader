export type BookSource = 'local-txt' | 'online' | 'mock';

/** 阅读进度（持久化到 PouchDB Book 文档的 progress 字段） */
export interface BookProgress {
  chapterIndex: number;
  scrollOffset?: number;
  updatedAt: string;
}

export interface Book {
  id: string;
  title: string;
  author: string;
  /** 题材/类型（可选；用于封面生成器的 kind 文案，如"玄幻"/"言情"/"科幻"） */
  kind?: string;
  coverColor: string;
  /** 封面图片 URL（可选）；为空时 book-card 用 SVG + 底色 fallback */
  coverImageUrl?: string;
  chapterCount: number;
  totalChars: number;
  importedAt: string;
  source: BookSource;
  sourceUrl?: string;
  /** 阅读进度（嵌入 Book 文档） */
  progress?: BookProgress;
}