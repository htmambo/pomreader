import { ColorMode } from './color-mode.model';

export interface Settings {
  fontColor: string;            // #RRGGBB
  screenBg: string;             // #RRGGBB
  defaultTheme: boolean;        // 是否跟随默认主题
  colorMode: ColorMode;
}

export const DEFAULT_SETTINGS: Settings = {
  fontColor: '#262626',
  screenBg: '#CDC0A4',
  defaultTheme: true,
  colorMode: 'light',
};