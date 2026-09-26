/**
 * SettingsService 新增排版字段 load 校验测试
 *
 * 覆盖：
 * - localStorage 无值时回退默认
 * - 旧 localStorage（无新字段）时新字段回退默认
 * - 合法值（fontWeight/fontColor/paragraphLineHeight/paragraphSpacing）被采纳
 * - 越界 / 类型错误回退默认
 * - validateInt / validateFloat 边界条件
 *
 * 注：SettingsService 构造函数里有 effect()，必须 DI 上下文；
 * 为避免在测试里挂起完整 Angular，本 spec 直接走 static 校验路径，
 * 与项目其他 spec 直实例化纯函数的风格一致（见 cache-settings.component.spec）。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SettingsService } from './settings.service';

const STORAGE_KEY = 'pom.settings';

describe('SettingsService 新增排版字段', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe('load() 缺省与旧数据兼容', () => {
    it('localStorage 无值时使用默认排版值', () => {
      const v = SettingsService.load();
      expect(v.fontWeight).toBe(400);
      expect(v.fontColor).toBe('');
      expect(v.paragraphLineHeight).toBe(1.8);
      expect(v.paragraphSpacing).toBe(0.2);
    });

    it('localStorage 中无新字段时新字段回退默认（旧数据兼容）', () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ fontSize: 22, theme: 3 }));
      const v = SettingsService.load();
      expect(v.fontSize).toBe(22);
      expect(v.theme).toBe(3);
      expect(v.fontWeight).toBe(400);
      expect(v.fontColor).toBe('');
      expect(v.paragraphLineHeight).toBe(1.8);
      expect(v.paragraphSpacing).toBe(0.2);
    });

    it('JSON 解析失败回退默认', () => {
      localStorage.setItem(STORAGE_KEY, '{not valid');
      const v = SettingsService.load();
      expect(v.fontWeight).toBe(400);
      expect(v.paragraphSpacing).toBe(0.2);
    });
  });

  describe('mergeValidated() 合法值', () => {
    it('合法值被采纳', () => {
      const v = SettingsService.mergeValidated({
        fontWeight: 700,
        fontColor: '#ff0000',
        paragraphLineHeight: 2.4,
        paragraphSpacing: 0.5,
      });
      expect(v.fontWeight).toBe(700);
      expect(v.fontColor).toBe('#ff0000');
      expect(v.paragraphLineHeight).toBe(2.4);
      expect(v.paragraphSpacing).toBe(0.5);
    });

    it('越界 / 类型错误回退默认', () => {
      const v = SettingsService.mergeValidated({
        fontWeight: 50,
        fontColor: 'x'.repeat(40),
        paragraphLineHeight: 'abc',
        paragraphSpacing: -1,
      });
      expect(v.fontWeight).toBe(400);
      expect(v.fontColor).toBe('');
      expect(v.paragraphLineHeight).toBe(1.8);
      expect(v.paragraphSpacing).toBe(0.2);
    });

    it('fontColor 边界：30 字符恰好合法，31 字符非法', () => {
      const ok = SettingsService.mergeValidated({ fontColor: 'x'.repeat(30) });
      const ng = SettingsService.mergeValidated({ fontColor: 'x'.repeat(31) });
      expect(ok.fontColor).toBe('x'.repeat(30));
      expect(ng.fontColor).toBe('');
    });

    it('fontWeight 边界：100 与 900 合法，99/901 非法', () => {
      const a = SettingsService.mergeValidated({ fontWeight: 100 });
      const b = SettingsService.mergeValidated({ fontWeight: 900 });
      const c = SettingsService.mergeValidated({ fontWeight: 99 });
      const d = SettingsService.mergeValidated({ fontWeight: 901 });
      expect(a.fontWeight).toBe(100);
      expect(b.fontWeight).toBe(900);
      expect(c.fontWeight).toBe(400);
      expect(d.fontWeight).toBe(400);
    });

    it('fontWeight 非整数（如 400.5）非法回退默认', () => {
      const v = SettingsService.mergeValidated({ fontWeight: 400.5 });
      expect(v.fontWeight).toBe(400);
    });

    it('paragraphLineHeight 边界：1.0/3.0 合法，0.9/3.1 非法', () => {
      const a = SettingsService.mergeValidated({ paragraphLineHeight: 1.0 });
      const b = SettingsService.mergeValidated({ paragraphLineHeight: 3.0 });
      const c = SettingsService.mergeValidated({ paragraphLineHeight: 0.9 });
      const d = SettingsService.mergeValidated({ paragraphLineHeight: 3.1 });
      expect(a.paragraphLineHeight).toBe(1.0);
      expect(b.paragraphLineHeight).toBe(3.0);
      expect(c.paragraphLineHeight).toBe(1.8);
      expect(d.paragraphLineHeight).toBe(1.8);
    });

    it('paragraphSpacing 边界：0/2 合法，-0.1/2.1 非法', () => {
      const a = SettingsService.mergeValidated({ paragraphSpacing: 0 });
      const b = SettingsService.mergeValidated({ paragraphSpacing: 2 });
      const c = SettingsService.mergeValidated({ paragraphSpacing: -0.1 });
      const d = SettingsService.mergeValidated({ paragraphSpacing: 2.1 });
      expect(a.paragraphSpacing).toBe(0);
      expect(b.paragraphSpacing).toBe(2);
      expect(c.paragraphSpacing).toBe(0.2);
      expect(d.paragraphSpacing).toBe(0.2);
    });

    it('paragraphSpacing 非有限数（NaN/Infinity）回退默认', () => {
      const v = SettingsService.mergeValidated({ paragraphSpacing: Number.NaN });
      expect(v.paragraphSpacing).toBe(0.2);
      const v2 = SettingsService.mergeValidated({ paragraphSpacing: Number.POSITIVE_INFINITY });
      expect(v2.paragraphSpacing).toBe(0.2);
    });
  });
});
