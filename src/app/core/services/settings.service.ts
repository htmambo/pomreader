import { Injectable, signal, computed, Signal, effect } from '@angular/core';
import { Settings, DEFAULT_SETTINGS } from '../models/settings.model';

const STORAGE_KEY = 'pom.settings';

/**
 * SettingsService — 阅读设置（字号/字体色/界面背景/默认主题）
 * v1.1 §3 持久化限定：仅存元数据 + 进度（不存章节正文）
 */
@Injectable({ providedIn: 'root' })
export class SettingsService {
  private readonly _settings = signal<Settings>(this.load());
  readonly settings: Signal<Settings> = this._settings.asReadonly();
  readonly readerFontSize: Signal<number> = computed(
    () => parseInt(localStorage.getItem('pom.font-size') || '16', 10) || 16
  );

  constructor() {
    effect(() => {
      this.persist(this._settings());
    });
  }

  update<K extends keyof Settings>(key: K, value: Settings[K]): void {
    this._settings.update((s) => ({ ...s, [key]: value }));
  }

  updateReaderFontSize(size: number): void {
    try {
      localStorage.setItem('pom.font-size', String(size));
    } catch {
      /* */
    }
  }

  resetToDefault(): void {
    this._settings.set(DEFAULT_SETTINGS);
  }

  private load(): Settings {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (!stored) return DEFAULT_SETTINGS;
      const parsed = JSON.parse(stored) as Partial<Settings>;
      return { ...DEFAULT_SETTINGS, ...parsed };
    } catch {
      return DEFAULT_SETTINGS;
    }
  }

  private persist(s: Settings): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    } catch {
      /* quota */
    }
  }
}