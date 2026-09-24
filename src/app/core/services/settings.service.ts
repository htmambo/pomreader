import { Injectable, signal, Signal, effect } from '@angular/core';
import {
  Settings,
  DEFAULT_SETTINGS,
  PAGE_WIDTHS,
  MIN_FONT_SIZE,
  MAX_FONT_SIZE,
} from '../models/settings.model';

const STORAGE_KEY = 'pom.settings';

/**
 * SettingsService — 阅读设置（主题/字号/字体/页面宽度）
 * v1.1 §3 持久化限定：仅存元数据 + 进度（不存章节正文）
 */
@Injectable({ providedIn: 'root' })
export class SettingsService {
  private readonly _settings = signal<Settings>(this.load());
  readonly settings: Signal<Settings> = this._settings.asReadonly();

  constructor() {
    effect(() => {
      this.persist(this._settings());
    });
  }

  update<K extends keyof Settings>(key: K, value: Settings[K]): void {
    this._settings.update((s) => ({ ...s, [key]: value }));
  }

  resetToDefault(): void {
    this._settings.set(DEFAULT_SETTINGS);
  }

  private load(): Settings {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (!stored) return DEFAULT_SETTINGS;
      const parsed = JSON.parse(stored) as Partial<Settings>;
      // 白名单字段 + 校验
      const merged: Settings = {
        theme: this.validateInt(parsed.theme, 0, 6) ?? DEFAULT_SETTINGS.theme,
        fontSize:
          this.validateInt(parsed.fontSize, MIN_FONT_SIZE, MAX_FONT_SIZE) ??
          DEFAULT_SETTINGS.fontSize,
        fontFamily: this.validateInt(parsed.fontFamily, 1, 3) ?? DEFAULT_SETTINGS.fontFamily,
        pageWidth:
          typeof parsed.pageWidth === 'number' && PAGE_WIDTHS.includes(parsed.pageWidth)
            ? parsed.pageWidth
            : DEFAULT_SETTINGS.pageWidth,
        readMode:
          parsed.readMode === 'scroll' || parsed.readMode === 'paged'
            ? parsed.readMode
            : DEFAULT_SETTINGS.readMode,
      };
      return merged;
    } catch {
      return DEFAULT_SETTINGS;
    }
  }

  private validateInt(v: unknown, min: number, max: number): number | null {
    return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : null;
  }

  private persist(s: Settings): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    } catch {
      /* quota */
    }
  }
}
