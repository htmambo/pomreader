import { Injectable, signal, computed, Signal, effect } from '@angular/core';
import { Settings, DEFAULT_SETTINGS } from '../models/settings.model';

const STORAGE_KEY = 'pom.settings';

/**
 * SettingsService — 阅读设置（字号/字体色/界面背景/默认主题）
 * v1.1 §3 持久化限定：仅存元数据 + 进度（不存章节正文）
 * v1.1 code-reviewer R1 修订：fontSize 已并入 Settings 单一 signal（之前独立 localStorage key）
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
      // v1.1 code-reviewer M1 缓解：白名单字段 + 校验
      const merged: Settings = {
        fontColor: this.validateHex(parsed.fontColor) ?? DEFAULT_SETTINGS.fontColor,
        screenBg: this.validateHex(parsed.screenBg) ?? DEFAULT_SETTINGS.screenBg,
        defaultTheme: typeof parsed.defaultTheme === 'boolean' ? parsed.defaultTheme : DEFAULT_SETTINGS.defaultTheme,
        colorMode: parsed.colorMode === 'dark' || parsed.colorMode === 'light' ? parsed.colorMode : DEFAULT_SETTINGS.colorMode,
        fontSize: typeof parsed.fontSize === 'number' && parsed.fontSize >= 14 && parsed.fontSize <= 28
          ? parsed.fontSize
          : DEFAULT_SETTINGS.fontSize,
      };
      return merged;
    } catch {
      return DEFAULT_SETTINGS;
    }
  }

  private validateHex(c: unknown): string | null {
    return typeof c === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(c) ? c : null;
  }

  private persist(s: Settings): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    } catch {
      /* quota */
    }
  }
}