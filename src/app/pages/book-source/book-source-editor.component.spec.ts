import '@angular/compiler';
import { signal } from '@angular/core';
import { describe, expect, it } from 'vitest';
import { BookSourceEditorComponent } from './book-source-editor.component';
import type { SourceRules } from '../../core/book-source/smart-add/smart-rules';

/**
 * 书源编辑器 SEARCH_BODY_PARAMS 解析/写回回归测试。
 * 与项目其他 spec 一致:不走 TestBed,直接构造原型实例 + 假 panel。
 */
type EditorPriv = {
  panel: () => { setRules(rules: Partial<SourceRules>): void } | undefined;
  ruleBaseUrl: ReturnType<typeof signal<string>>;
  parseRulesFromSource(content: string): void;
  buildRuleReplacements(rules: Partial<SourceRules>): Record<string, string | { literal: string }>;
  replaceRulesInSource(
    content: string,
    rules: Record<string, string | { literal: string }>,
  ): string;
};

function makeComp() {
  let captured: Partial<SourceRules> | null = null;
  const comp = Object.create(BookSourceEditorComponent.prototype) as EditorPriv;
  comp.panel = () => ({
    setRules: (r) => {
      captured = r;
    },
  });
  comp.ruleBaseUrl = signal('');
  return { comp, captured: () => captured };
}

const PAIRS_LINE =
  'const SEARCH_BODY_PARAMS = [["type","articlename"],["s","{keyword}"],["submit",""]]';
const OBJECTS_LINE =
  'const SEARCH_BODY_PARAMS = [{"key":"type","value":"articlename"},{"key":"s","value":"{keyword}"},{"key":"submit","value":""}]';
const EXPECTED_PARAMS = [
  { key: 'type', value: 'articlename' },
  { key: 's', value: '{keyword}' },
  { key: 'submit', value: '' },
];

describe('BookSourceEditorComponent — SEARCH_BODY_PARAMS 解析/写回', () => {
  it('解析二元组数组形态(标准生成形态)', () => {
    const { comp, captured } = makeComp();
    comp.parseRulesFromSource(PAIRS_LINE);
    expect(captured()?.searchBodyParams).toEqual(EXPECTED_PARAMS);
  });

  it('解析对象数组形态(历史「应用规则到源码」曾写出的形态,第二次编辑不应丢参数)', () => {
    const { comp, captured } = makeComp();
    comp.parseRulesFromSource(OBJECTS_LINE);
    expect(captured()?.searchBodyParams).toEqual(EXPECTED_PARAMS);
  });

  it('写回统一为二元组数组字面量(与 generateSourceCode 输出一致)', () => {
    const { comp } = makeComp();
    const updates = comp.buildRuleReplacements({ searchBodyParams: EXPECTED_PARAMS });
    expect(updates['SEARCH_BODY_PARAMS']).toEqual({
      literal: '[["type","articlename"],["s","{keyword}"],["submit",""]]',
    });
  });

  it('回归:对象形态源码 → 解析 → 应用规则 → 源码被规范化为二元组形态', () => {
    const { comp, captured } = makeComp();
    comp.parseRulesFromSource(OBJECTS_LINE);
    const updates = comp.buildRuleReplacements(captured()!);
    const out = comp.replaceRulesInSource(OBJECTS_LINE, updates);
    expect(out).toContain(PAIRS_LINE);
    expect(out).not.toContain('{"key"');
  });
});
