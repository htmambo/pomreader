/** 页面宽度档位（参考阅读模板 reader_config[4]） */
export const PAGE_WIDTHS = [640, 800, 900, 1280, 1440, 1680, 1840];
export const MIN_FONT_SIZE = 14;
export const MAX_FONT_SIZE = 28;

export const MIN_FONT_WEIGHT = 100;
export const MAX_FONT_WEIGHT = 900;
export const FONT_WEIGHT_STEP = 100;

export const MIN_LINE_HEIGHT = 1.0;
export const MAX_LINE_HEIGHT = 3.0;
export const LINE_HEIGHT_STEP = 0.1;

export const MIN_PARAGRAPH_SPACING = 0;
export const MAX_PARAGRAPH_SPACING = 2.0;
export const PARAGRAPH_SPACING_STEP = 0.1;

/** 阅读模式：scroll 整章滚动 / paged 章内分页（左右翻页） */
export type ReadMode = 'scroll' | 'paged';

/** 书架排序：imported 入库顺序（新→旧）/ lastRead 最近阅读（新→旧，未读排后）/ title 书名（拼音升序） */
export type BookshelfSort = 'imported' | 'lastRead' | 'title';

export const BOOKSHELF_SORTS: BookshelfSort[] = ['imported', 'lastRead', 'title'];

export interface Settings {
  theme: number;              // 阅读主题 0-6：默认/牛皮纸/淡绿/淡蓝/淡粉/灰/黑
  fontSize: number;           // 阅读字号 14-28
  fontFamily: number;         // 正文字体：1 雅黑 / 2 宋体 / 3 楷书
  pageWidth: number;          // 页面宽度 640/800/900/1280/1440/1680/1840
  readMode: ReadMode;         // 阅读模式：滚动 / 翻页
  bookshelfSort: BookshelfSort; // 书架排序规则
  fetchUa: string;            // 抓取 User-Agent（'' = 平台默认 Chrome UA；主进程经 IPC 应用）
  fontWeight: number;         // 字体粗细 100-900（步长 100）
  fontColor: string;          // 字体颜色：CSS 颜色字符串，'' = 沿用主题 --r-text
  paragraphLineHeight: number; // 段落行高 1.0-3.0（步长 0.1）
  paragraphSpacing: number;   // 段落间距 0-2.0 em（步长 0.1）
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 0,
  fontSize: 18,
  fontFamily: 1,
  pageWidth: 800,
  readMode: 'paged',
  bookshelfSort: 'imported',
  fetchUa: '',
  fontWeight: 400,
  fontColor: '',
  paragraphLineHeight: 1.8,
  paragraphSpacing: 0.2,
};
