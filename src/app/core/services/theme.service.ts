import { Injectable, signal, computed, Signal, effect, inject } from '@angular/core';
import { ColorMode } from '../models/color-mode.model';
import { SettingsService } from './settings.service';

const MODE_KEY = 'pom.theme';

/**
 * ThemeService — 全局 light/dark 主题管理
 * v1.1 §9.3 修订：applyToHtml() 打在 <html> 上
 * v1.1 code-reviewer R2 修订：defaultTheme 由 SettingsService 单源；本 service 仅管 mode
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly settingsService = inject(SettingsService);
  private readonly _mode = signal<ColorMode>(this.loadMode());
  readonly mode: Signal<ColorMode> = this._mode.asReadonly();
  readonly effectiveMode: Signal<ColorMode> = computed(() => this._mode());

  constructor() {
    effect(() => {
      this.applyToHtml();
      this.persistMode(this._mode());
    });
  }

  toggleMode(): void {
    this._mode.update((m) => (m === 'light' ? 'dark' : 'light'));
  }

  setMode(mode: ColorMode): void {
    this._mode.set(mode);
  }

  /**
   * 把 data-color-mode / data-default-theme 写到 <html> 元素
   * v1.1 §9.3 修订：原 vendor 是 <body>，改为 <html> 避免弹窗背景闪烁
   * v1.1 code-reviewer R2 修订：defaultTheme 来自 SettingsService（单源）
   */
  applyToHtml(): void {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    root.setAttribute('data-color-mode', this._mode());
    root.setAttribute('data-default-theme', this.settingsService.settings().defaultTheme ? '1' : '0');
  }

  private loadMode(): ColorMode {
    try {
      const stored = localStorage.getItem(MODE_KEY) as ColorMode | null;
      return stored === 'dark' || stored === 'light' ? stored : 'light';
    } catch {
      return 'light';
    }
  }

  private persistMode(mode: ColorMode): void {
    try {
      localStorage.setItem(MODE_KEY, mode);
    } catch {
      /* quota / disabled */
    }
  }
}