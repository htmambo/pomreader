/**
 * 弹窗跟随方案的颜色变量解析
 * 来源：v1.1 §7.3 + SPEC §5.3
 *
 * 在 reader-settings 弹窗里，用户可改字体色/界面背景，
 * 实时反映到弹窗本身的 --pom-modal-fg / --pom-modal-bg
 */

export type Scheme = 'light' | 'dark';

export interface SchemeColors {
  fg: string;
  bg: string;
}

const FALLBACK: Record<Scheme, SchemeColors> = {
  dark: { fg: '#666666', bg: '#161819' },
  light: { fg: '#262626', bg: '#CDC0A4' },
};

/**
 * 解析当前 scheme 下的 fg/bg（带 hex 校验）
 */
export function resolveSchemeColors(
  scheme: Scheme,
  fontColor?: string,
  screenBg?: string
): SchemeColors {
  const fallback = FALLBACK[scheme];
  const validHex = /^#[0-9a-fA-F]{3,8}$/;
  return {
    fg: validHex.test(fontColor || '') ? fontColor! : fallback.fg,
    bg: validHex.test(screenBg || '') ? screenBg! : fallback.bg,
  };
}