import { Injectable, signal, Signal, effect } from '@angular/core';
import {
  Settings,
  DEFAULT_SETTINGS,
  PAGE_WIDTHS,
  MIN_FONT_SIZE,
  MAX_FONT_SIZE,
  MIN_FONT_WEIGHT,
  MAX_FONT_WEIGHT,
  MIN_LINE_HEIGHT,
  MAX_LINE_HEIGHT,
  MIN_PARAGRAPH_SPACING,
  MAX_PARAGRAPH_SPACING,
  BOOKSHELF_SORTS,
} from '../models/settings.model';

const STORAGE_KEY = 'pom.settings';

/**
 * SettingsService — 阅读设置（主题/字号/字体/页面宽度）
 * v1.1 §3 持久化限定：仅存元数据 + 进度（不存章节正文）
 */
@Injectable({ providedIn: 'root' })
export class SettingsService {
  private readonly _settings = signal<Settings>(SettingsService.load());
  readonly settings: Signal<Settings> = this._settings.asReadonly();

  constructor() {
    effect(() => {
      this.persist(this._settings());
    });
    // 抓取 UA 持久化在渲染端（localStorage），主进程需要它发 net.request / setUserAgent ——
    // 启动时推送到主进程（IPC 不可用时静默，主进程用平台默认）
    const ua = this._settings().fetchUa;
    if (ua) {
      void window.pomAPI?.setFetchUA?.(ua).catch(() => undefined);
    }
  }

  update<K extends keyof Settings>(key: K, value: Settings[K]): void {
    this._settings.update((s) => ({ ...s, [key]: value }));
  }

  resetToDefault(): void {
    this._settings.set(DEFAULT_SETTINGS);
  }

  /** 从 localStorage 解析并白名单校验；任一字段缺失/非法回退到默认。
   *  暴露为 static 便于单元测试，无需走 effect() 的 DI 上下文。 */
  static load(): Settings {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (!stored) return DEFAULT_SETTINGS;
      const parsed = JSON.parse(stored) as Partial<Settings>;
      return SettingsService.mergeValidated(parsed);
    } catch {
      return DEFAULT_SETTINGS;
    }
  }

  /** 白名单字段 + 校验；任一字段缺失/类型错/越界回退默认 */
  static mergeValidated(parsed: Partial<Settings>): Settings {
    return {
      theme: SettingsService.validateInt(parsed.theme, 0, 6) ?? DEFAULT_SETTINGS.theme,
      fontSize:
        SettingsService.validateInt(parsed.fontSize, MIN_FONT_SIZE, MAX_FONT_SIZE) ??
        DEFAULT_SETTINGS.fontSize,
      fontFamily:
        SettingsService.validateInt(parsed.fontFamily, 1, 3) ?? DEFAULT_SETTINGS.fontFamily,
      pageWidth:
        typeof parsed.pageWidth === 'number' && PAGE_WIDTHS.includes(parsed.pageWidth)
          ? parsed.pageWidth
          : DEFAULT_SETTINGS.pageWidth,
      readMode:
        parsed.readMode === 'scroll' || parsed.readMode === 'paged'
          ? parsed.readMode
          : DEFAULT_SETTINGS.readMode,
      bookshelfSort: BOOKSHELF_SORTS.includes(parsed.bookshelfSort!)
        ? parsed.bookshelfSort!
        : DEFAULT_SETTINGS.bookshelfSort,
      fetchUa:
        typeof parsed.fetchUa === 'string' && parsed.fetchUa.length <= 300
          ? parsed.fetchUa
          : DEFAULT_SETTINGS.fetchUa,
      fontWeight:
        SettingsService.validateInt(parsed.fontWeight, MIN_FONT_WEIGHT, MAX_FONT_WEIGHT) ??
        DEFAULT_SETTINGS.fontWeight,
      fontColor:
        typeof parsed.fontColor === 'string' && parsed.fontColor.length <= 30
          ? parsed.fontColor
          : DEFAULT_SETTINGS.fontColor,
      paragraphLineHeight:
        SettingsService.validateFloat(
          parsed.paragraphLineHeight,
          MIN_LINE_HEIGHT,
          MAX_LINE_HEIGHT,
        ) ?? DEFAULT_SETTINGS.paragraphLineHeight,
      paragraphSpacing:
        SettingsService.validateFloat(
          parsed.paragraphSpacing,
          MIN_PARAGRAPH_SPACING,
          MAX_PARAGRAPH_SPACING,
        ) ?? DEFAULT_SETTINGS.paragraphSpacing,
    };
  }

  static validateInt(v: unknown, min: number, max: number): number | null {
    return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : null;
  }

  static validateFloat(v: unknown, min: number, max: number): number | null {
    return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : null;
  }

  private persist(s: Settings): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    } catch {
      /* quota */
    }
  }
}
