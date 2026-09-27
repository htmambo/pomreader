import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createSettingsStore, SettingsStore } from './settings-store';
import { DEFAULT_SETTINGS } from '../models/settings.model';

describe('SettingsStore', () => {
  let store: SettingsStore;

  beforeEach(() => {
    // 重置 localStorage
    localStorage.clear();
    store = createSettingsStore();
  });

  afterEach(() => {
    localStorage.clear();
  });

  describe('初始状态', () => {
    it('无 localStorage 数据时应使用 DEFAULT_SETTINGS', () => {
      expect(store.settings()).toEqual(DEFAULT_SETTINGS);
    });
  });

  describe('update', () => {
    it('应能更新单个字段', () => {
      store.update('fontSize', 20);
      expect(store.settings().fontSize).toBe(20);
    });

    it('应保留其它字段不变', () => {
      const before = store.settings();
      store.update('fontSize', 22);
      expect(store.settings().theme).toBe(before.theme);
      expect(store.settings().fontFamily).toBe(before.fontFamily);
    });

    it('应能连续多次更新', () => {
      store.update('fontSize', 18);
      store.update('theme', 3);
      store.update('readMode', 'paged');
      expect(store.settings().fontSize).toBe(18);
      expect(store.settings().theme).toBe(3);
      expect(store.settings().readMode).toBe('paged');
    });
  });

  describe('resetToDefault', () => {
    it('应重置为 DEFAULT_SETTINGS', () => {
      store.update('fontSize', 99);
      store.resetToDefault();
      expect(store.settings()).toEqual(DEFAULT_SETTINGS);
    });
  });

  describe('mergeValidated 静态方法', () => {
    it('合法值应被采纳', () => {
      const result = SettingsStore.mergeValidated({
        fontSize: 20,
        fontFamily: 2,
        theme: 5,
      });
      expect(result.fontSize).toBe(20);
      expect(result.fontFamily).toBe(2);
      expect(result.theme).toBe(5);
    });

    it('越界值应回退默认', () => {
      const result = SettingsStore.mergeValidated({ fontSize: 999 });
      expect(result.fontSize).toBe(DEFAULT_SETTINGS.fontSize);
    });

    it('负值应回退默认', () => {
      const result = SettingsStore.mergeValidated({ fontSize: -5 });
      expect(result.fontSize).toBe(DEFAULT_SETTINGS.fontSize);
    });

    it('非数值应回退默认', () => {
      const result = SettingsStore.mergeValidated({ fontSize: 'big' as unknown as number });
      expect(result.fontSize).toBe(DEFAULT_SETTINGS.fontSize);
    });

    it('readMode 非法值应回退默认', () => {
      const result = SettingsStore.mergeValidated({ readMode: 'foo' as 'scroll' | 'paged' });
      expect(result.readMode).toBe(DEFAULT_SETTINGS.readMode);
    });

    it('bookshelfSort 非法值应回退默认', () => {
      const result = SettingsStore.mergeValidated({ bookshelfSort: 'invalid' as 'recent' });
      expect(result.bookshelfSort).toBe(DEFAULT_SETTINGS.bookshelfSort);
    });

    it('fetchUa 超长应回退默认', () => {
      const longUa = 'x'.repeat(400);
      const result = SettingsStore.mergeValidated({ fetchUa: longUa });
      expect(result.fetchUa).toBe(DEFAULT_SETTINGS.fetchUa);
    });

    it('convertMode 合法值应被采纳', () => {
      expect(SettingsStore.mergeValidated({ convertMode: 's2t' }).convertMode).toBe('s2t');
      expect(SettingsStore.mergeValidated({ convertMode: 't2s' }).convertMode).toBe('t2s');
    });

    it('convertMode 非法值/缺失应回退默认', () => {
      expect(
        SettingsStore.mergeValidated({ convertMode: 's2tw' as 's2t' }).convertMode
      ).toBe(DEFAULT_SETTINGS.convertMode);
      expect(SettingsStore.mergeValidated({}).convertMode).toBe(DEFAULT_SETTINGS.convertMode);
    });
  });

  describe('validateInt', () => {
    it('合法整数应返回该值', () => {
      expect(SettingsStore.validateInt(5, 0, 10)).toBe(5);
    });

    it('边界值应合法', () => {
      expect(SettingsStore.validateInt(0, 0, 10)).toBe(0);
      expect(SettingsStore.validateInt(10, 0, 10)).toBe(10);
    });

    it('越界应返回 null', () => {
      expect(SettingsStore.validateInt(-1, 0, 10)).toBeNull();
      expect(SettingsStore.validateInt(11, 0, 10)).toBeNull();
    });

    it('非整数应返回 null', () => {
      expect(SettingsStore.validateInt(5.5, 0, 10)).toBeNull();
    });

    it('非 number 应返回 null', () => {
      expect(SettingsStore.validateInt('5' as unknown as number, 0, 10)).toBeNull();
    });
  });

  describe('validateFloat', () => {
    it('合法浮点数应返回该值', () => {
      expect(SettingsStore.validateFloat(1.5, 0, 3)).toBe(1.5);
    });

    it('边界值应合法', () => {
      expect(SettingsStore.validateFloat(0, 0, 3)).toBe(0);
      expect(SettingsStore.validateFloat(3, 0, 3)).toBe(3);
    });

    it('越界应返回 null', () => {
      expect(SettingsStore.validateFloat(-0.1, 0, 3)).toBeNull();
      expect(SettingsStore.validateFloat(3.1, 0, 3)).toBeNull();
    });

    it('NaN/Infinity 应返回 null', () => {
      expect(SettingsStore.validateFloat(NaN, 0, 3)).toBeNull();
      expect(SettingsStore.validateFloat(Infinity, 0, 3)).toBeNull();
    });
  });

  describe('load 静态方法', () => {
    it('localStorage 无数据应返回 DEFAULT_SETTINGS', () => {
      localStorage.clear();
      expect(SettingsStore.load()).toEqual(DEFAULT_SETTINGS);
    });

    it('localStorage 有 corrupt JSON 应回退默认', () => {
      localStorage.setItem('pom.settings', '{invalid json');
      expect(SettingsStore.load()).toEqual(DEFAULT_SETTINGS);
    });

    it('localStorage 有合法 JSON 应被解析', () => {
      const stored = JSON.stringify({ fontSize: 24, theme: 4 });
      localStorage.setItem('pom.settings', stored);
      const result = SettingsStore.load();
      expect(result.fontSize).toBe(24);
      expect(result.theme).toBe(4);
      // 其它字段走默认
      expect(result.fontFamily).toBe(DEFAULT_SETTINGS.fontFamily);
    });

    it('localStorage 有非法值应被校验回退', () => {
      localStorage.setItem('pom.settings', JSON.stringify({ fontSize: 9999 }));
      expect(SettingsStore.load().fontSize).toBe(DEFAULT_SETTINGS.fontSize);
    });
  });

  describe('persist 静态方法', () => {
    it('应能把 settings 写入 localStorage', () => {
      SettingsStore.persist({ ...DEFAULT_SETTINGS, fontSize: 22 });
      const stored = localStorage.getItem('pom.settings');
      expect(stored).not.toBeNull();
      expect(JSON.parse(stored!).fontSize).toBe(22);
    });

    it('write 失败应静默（quota）', () => {
      // mock localStorage.setItem 抛错
      const orig = localStorage.setItem;
      localStorage.setItem = vi.fn(() => {
        throw new Error('quota');
      }) as typeof localStorage.setItem;
      expect(() => SettingsStore.persist(DEFAULT_SETTINGS)).not.toThrow();
      localStorage.setItem = orig;
    });
  });
});