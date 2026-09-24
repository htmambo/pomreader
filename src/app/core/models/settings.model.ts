import { ColorMode } from './color-mode.model';

/** 页面宽度档位（参考阅读模板 reader_config[4]） */
export const PAGE_WIDTHS = [640, 800, 900, 1280];
export const MIN_FONT_SIZE = 14;
export const MAX_FONT_SIZE = 28;

export interface Settings {
  theme: number;              // 阅读主题 0-6：默认/牛皮纸/淡绿/淡蓝/淡粉/灰/黑
  fontSize: number;           // 阅读字号 14-28
  fontFamily: number;         // 正文字体：1 雅黑 / 2 宋体 / 3 楷书
  pageWidth: number;          // 页面宽度 640/800/900/1280
  colorMode: ColorMode;
  defaultTheme: boolean;      // 是否跟随默认主题
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 0,
  fontSize: 18,
  fontFamily: 1,
  pageWidth: 800,
  colorMode: 'light',
  defaultTheme: true,
};
