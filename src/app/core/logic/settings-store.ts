import { signal, type Signal, type WritableSignal } from '@angular/core';
import {
  type Settings,
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
  CONVERT_MODES,
} from '../models/settings.model';

const STORAGE_KEY = 'pom.settings';

/**
 * SettingsStore — 阅读设置纯逻辑层（EVO-12）
 *
 * 抽离 SettingsService 的 signal 状态 + 校验 + 持久化到 core/logic/，
 * 便于脱离 DI 上下文单测（无 @Injectable、无 effect）。
 *
 * 持久化（localStorage）由 SettingsService 监听 settings() signal 触发；
 * 本模块只暴露数据层。
 */
export interface SettingsStore {
  readonly settings: Signal<Settings>;
  update<K extends keyof Settings>(key: K, value: Settings[K]): void;
  resetToDefault(): void;
  /** 强制覆盖整个 settings（如从 localStorage load） */
  set(settings: Settings): void;
}

export function createSettingsStore(): SettingsStore {
  const _settings: WritableSignal<Settings> = signal<Settings>(SettingsStore.load());
  return {
    settings: _settings.asReadonly(),
    update<K extends keyof Settings>(key: K, value: Settings[K]): void {
      _settings.update((s) => ({ ...s, [key]: value }));
    },
    resetToDefault(): void {
      _settings.set(DEFAULT_SETTINGS);
    },
    set(settings: Settings): void {
      _settings.set(settings);
    },
  };
}

export namespace SettingsStore {
  /** 从 localStorage 解析并白名单校验；任一字段缺失/非法回退到默认。 */
  export function load(): Settings {
    try {
      const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
      if (!stored) return DEFAULT_SETTINGS;
      const parsed = JSON.parse(stored) as Partial<Settings>;
      return mergeValidated(parsed);
    } catch {
      return DEFAULT_SETTINGS;
    }
  }

  /** 持久化到 localStorage（SettingsService effect 内调用） */
  export function persist(s: Settings): void {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
      }
    } catch {
      /* quota */
    }
  }

  /** 白名单字段 + 校验；任一字段缺失/类型错/越界回退默认 */
  export function mergeValidated(parsed: Partial<Settings>): Settings {
    return {
      theme: validateInt(parsed.theme, 0, 6) ?? DEFAULT_SETTINGS.theme,
      fontSize:
        validateInt(parsed.fontSize, MIN_FONT_SIZE, MAX_FONT_SIZE) ?? DEFAULT_SETTINGS.fontSize,
      fontFamily: validateInt(parsed.fontFamily, 1, 3) ?? DEFAULT_SETTINGS.fontFamily,
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
        validateInt(parsed.fontWeight, MIN_FONT_WEIGHT, MAX_FONT_WEIGHT) ??
        DEFAULT_SETTINGS.fontWeight,
      fontColor:
        typeof parsed.fontColor === 'string' && parsed.fontColor.length <= 30
          ? parsed.fontColor
          : DEFAULT_SETTINGS.fontColor,
      paragraphLineHeight:
        validateFloat(parsed.paragraphLineHeight, MIN_LINE_HEIGHT, MAX_LINE_HEIGHT) ??
        DEFAULT_SETTINGS.paragraphLineHeight,
      paragraphSpacing:
        validateFloat(parsed.paragraphSpacing, MIN_PARAGRAPH_SPACING, MAX_PARAGRAPH_SPACING) ??
        DEFAULT_SETTINGS.paragraphSpacing,
      convertMode: CONVERT_MODES.includes(parsed.convertMode!)
        ? parsed.convertMode!
        : DEFAULT_SETTINGS.convertMode,
    };
  }

  export function validateInt(v: unknown, min: number, max: number): number | null {
    return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : null;
  }

  export function validateFloat(v: unknown, min: number, max: number): number | null {
    return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : null;
  }
}
