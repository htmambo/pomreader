/**
 * Legado 选择器语法识别测试
 *
 * 覆盖 5 种语法 + untranslatable bridge 检测 + 空串/纯文本兜底
 */
import { describe, it, expect } from 'vitest';
import {
  parseSelector,
  isCssOrRegexKind,
  toRulePattern,
} from './legado-selector';

describe('parseSelector', () => {
  it('<js>...</js> 块 → js kind + jsCode', () => {
    const p = parseSelector('<js>\nresult + " suffix"\n</js>');
    expect(p.kind).toBe('js');
    expect(p.jsCode).toBe('\nresult + " suffix"\n');
    expect(p.usesUntranslatableBridge).toBe(false);
  });

  it('<js> 含 java. → 标记 untranslatable', () => {
    const p = parseSelector('<js>\njava.ajax(url)\n</js>');
    expect(p.kind).toBe('js');
    expect(p.usesUntranslatableBridge).toBe(true);
  });

  it('<js> 含 source. → 标记 untranslatable', () => {
    const p = parseSelector('<js>\nsource.getVariable()\n</js>');
    expect(p.usesUntranslatableBridge).toBe(true);
  });

  it('<js> 含 Packages. → 标记 untranslatable', () => {
    const p = parseSelector('<js>\nnew Packages.io.legato.X()\n</js>');
    expect(p.usesUntranslatableBridge).toBe(true);
  });

  it('{{template}} → template kind + hasTemplate', () => {
    const p = parseSelector('{{$.name}} {{$.id}}');
    expect(p.kind).toBe('template');
    expect(p.hasTemplate).toBe(true);
  });

  it('$.foo.bar JSONPath → jsonpath kind', () => {
    const p = parseSelector('$.author');
    expect(p.kind).toBe('jsonpath');
    expect(p.css).toBeNull();
  });

  it('@Regex:... → regex kind + regex 字段', () => {
    const p = parseSelector('@Regex:第(\\d+)章');
    expect(p.kind).toBe('regex');
    expect(p.regex).toBe('第(\\d+)章');
  });

  it('css:.foo → css kind + css 字段', () => {
    const p = parseSelector('css:.title');
    expect(p.kind).toBe('css');
    expect(p.css).toBe('.title');
  });

  it('纯 CSS 选择器（无前缀） → literal kind + css 字段', () => {
    const p = parseSelector('#content .title');
    expect(p.kind).toBe('literal');
    expect(p.css).toBe('#content .title');
    expect(isCssOrRegexKind(p)).toBe(true);
  });

  it('空串 → literal kind css=null', () => {
    const p = parseSelector('');
    expect(p.kind).toBe('literal');
    expect(p.css).toBeNull();
    expect(isCssOrRegexKind(p)).toBe(true);
  });

  it('非 <js> 但含 java. 字符串 → 标记 untranslatable（防御性）', () => {
    const p = parseSelector('java.log("x")');
    expect(p.usesUntranslatableBridge).toBe(true);
  });
});

describe('isCssOrRegexKind', () => {
  it('css / regex / literal → true', () => {
    expect(isCssOrRegexKind(parseSelector('.a'))).toBe(true);
    expect(isCssOrRegexKind(parseSelector('css:.a'))).toBe(true);
    expect(isCssOrRegexKind(parseSelector('@Regex:\\d+'))).toBe(true);
  });

  it('js / jsonpath / template → false', () => {
    expect(isCssOrRegexKind(parseSelector('<js>x</js>'))).toBe(false);
    expect(isCssOrRegexKind(parseSelector('$.a'))).toBe(false);
    expect(isCssOrRegexKind(parseSelector('{{$.a}}'))).toBe(false);
  });
});

describe('toRulePattern', () => {
  it('css → 返回 css 字符串', () => {
    expect(toRulePattern(parseSelector('css:.a'))).toBe('.a');
  });
  it('regex → 返回 regex 字符串', () => {
    expect(toRulePattern(parseSelector('@Regex:\\d+'))).toBe('\\d+');
  });
  it('literal → 返回 css 字符串', () => {
    expect(toRulePattern(parseSelector('#x'))).toBe('#x');
  });
  it('js / template → null', () => {
    expect(toRulePattern(parseSelector('<js>x</js>'))).toBeNull();
    expect(toRulePattern(parseSelector('{{$.a}}'))).toBeNull();
    expect(toRulePattern(parseSelector('$.a'))).toBeNull();
  });
});
