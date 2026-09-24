import { Injectable, signal, computed, effect, Signal } from '@angular/core';
import { ColorMode } from '../models/color-mode.model';

const STORAGE_KEY = 'pom.theme';
const DEFAULT_KEY = 'pom.default-theme';

/**
 * ThemeService — 全局 light/dark 主题管理
 * v1.1 §9.3 修订：applyToHtml() 打在 <html> 上（确保 ng-zorro 覆盖层继承 CSS var）
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly _mode = signal<ColorMode>(this.loadMode());
  private readonly _defaultTheme = signal<boolean>(this.loadDefault());
  readonly mode: Signal<ColorMode> = this._mode.asReadonly();
  readonly defaultTheme: Signal<boolean> = this._defaultTheme.asReadonly();
  readonly effectiveMode: Signal<ColorMode> = computed(() => this._mode());

  constructor() {
    effect(() => {
      this.applyToHtml();
      this.persistMode(this._mode());
    });
    effect(() => {
      this.persistDefault(this._defaultTheme());
    });
  }

  toggleMode(): void {
    this._mode.update((m) => (m === 'light' ? 'dark' : 'light'));
  }

  setMode(mode: ColorMode): void {
    this._mode.set(mode);
  }

  toggleDefaultTheme(): void {
    this._defaultTheme.update((v) => !v);
  }

  /**
   * 把 data-color-mode / data-default-theme 写到 <html> 元素
   * v1.1 §9.3 修订：原 vendor 是 <body>，改为 <html> 避免弹窗背景闪烁
   */
  applyToHtml(): void {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    root.setAttribute('data-color-mode', this._mode());
    root.setAttribute('data-default-theme', this._defaultTheme() ? '1' : '0');
  }

  private loadMode(): ColorMode {
    try {
      const stored = localStorage.getItem(STORAGE_KEY) as ColorMode | null;
      return stored === 'dark' || stored === 'light' ? stored : 'light';
    } catch {
      return 'light';
    }
  }

  private loadDefault(): boolean {
    try {
      const stored = localStorage.getItem(DEFAULT_KEY);
      return stored === null ? true : stored === '1';
    } catch {
      return true;
    }
  }

  private persistMode(mode: ColorMode): void {
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      /* quota / disabled */
    }
  }

  private persistDefault(v: boolean): void {
    try {
      localStorage.setItem(DEFAULT_KEY, v ? '1' : '0');
    } catch {
      /* quota / disabled */
    }
  }
}