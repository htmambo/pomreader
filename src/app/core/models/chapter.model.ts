export interface Chapter {
  bookId: string;
  index: number;
  title: string;
  content: string;
  /** 在线导入章节的原始页面 URL（按需抓取正文入口） */
  sourceUrl?: string;
  /** 该章正文是否已抓取（在线导入按需加载） */
  loaded?: boolean;
}

export interface ImportedChapter {
  title: string;
  startLine: number;
  endLine: number;
}