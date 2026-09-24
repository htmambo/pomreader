import { ColorMode } from './color-mode.model';

export interface Settings {
  fontColor: string;            // #RRGGBB
  screenBg: string;             // #RRGGBB
  defaultTheme: boolean;        // 是否跟随默认主题
  colorMode: ColorMode;
  fontSize: number;             // 阅读字号（v1.1 code-reviewer R1 修订：reactive）
}

export const DEFAULT_SETTINGS: Settings = {
  fontColor: '#262626',
  screenBg: '#CDC0A4',
  defaultTheme: true,
  colorMode: 'light',
  fontSize: 16,
};