/**
 * guard 单元测试：硬性上限 + 嵌套量词启发式（放行/拒绝清单固定于此，防误拒默认规则回归）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertHtmlSize,
  assertRegexSafe,
  assertRuleLength,
  capContent,
  capList,
  CONTENT_MAX_LENGTH,
  EXECUTION_BUDGET_MS,
  HTML_MAX_LENGTH,
  RULE_MAX_LENGTH,
  SEARCH_MAX_RESULTS,
  whitelistResult,
  withBudget,
} from './guard';
import { DEFAULT_PATTERNS } from '../smart-add/smart-rules';

describe('assertRuleLength', () => {
  it('超长拒绝，报错含字段名与实际上限', () => {
    expect(() => assertRuleLength('searchItemPattern', 'x'.repeat(RULE_MAX_LENGTH + 1))).toThrow(
      /searchItemPattern/,
    );
    expect(() => assertRuleLength('searchItemPattern', 'x'.repeat(RULE_MAX_LENGTH + 1))).toThrow(
      /512/,
    );
  });
  it('恰好 512 字符放行', () => {
    expect(() => assertRuleLength('f', 'x'.repeat(RULE_MAX_LENGTH))).not.toThrow();
  });
});

describe('assertRegexSafe — 嵌套量词启发式', () => {
  it.each(['(a+)+', '(a*)*', '(a|a)+'])('拒绝灾难性回溯形态：%s', (pattern) => {
    expect(() => assertRegexSafe('f', pattern)).toThrow(/灾难性回溯风险：f/);
  });

  it.each([
    '(a+){2,}', // 无上限区间量词等价于 +
    '((a+))+', // 嵌套组单原子重复
    '(\\d+)*', // 转义类单原子
    '([^"]*)+', // 字符类单原子
    '(a|)*', // 空分支：组可匹配空串
  ])('拒绝其它危险形态：%s', (pattern) => {
    expect(() => assertRegexSafe('f', pattern)).toThrow(/灾难性回溯/);
  });

  it.each([
    '(?:<[^>]+>)*', // P0 实测必须放行：默认规则就有（组体含 </> 边界字面量，内外不相交）
    '([^<]{1,30})', // 组后无量词，不进检查
    '(ab|cd)+', // 多字面量分支不重叠
    '作者[：:]\\s*(?:<[^>]+)*([^<]{1,30})', // bookAuthorPattern 形态
    '<a[^>]+href="([^"]+)"[^>]*>([^<]{2,40})</a>', // searchItemPattern 形态
  ])('放行安全形态：%s', (pattern) => {
    expect(() => assertRegexSafe('f', pattern)).not.toThrow();
  });

  it('DEFAULT_PATTERNS 全部正则规则都放行（误拒默认规则 = 迁移翻车）', () => {
    for (const [field, pattern] of Object.entries(DEFAULT_PATTERNS)) {
      if (pattern.startsWith('css:')) continue; // CSS 规则不做正则检查
      expect(() => assertRegexSafe(field, pattern), field).not.toThrow();
    }
  });
});

describe('assertHtmlSize', () => {
  it('5MB 边界：恰好上限放行，超 1 字符拒绝（沙箱同款 > 判定与文案）', () => {
    expect(() => assertHtmlSize('x'.repeat(HTML_MAX_LENGTH))).not.toThrow();
    expect(() => assertHtmlSize('x'.repeat(HTML_MAX_LENGTH + 1))).toThrow('HTML 超过 5MB 解析上限');
  });
});

describe('withBudget — 15s 执行预算', () => {
  afterEach(() => vi.useRealTimers());

  it('任务按时完成返回结果', async () => {
    await expect(withBudget(Promise.resolve(42), 1000)).resolves.toBe(42);
  });

  it('默认 15s 预算到期 reject（fake timers，不真等 15s）', async () => {
    vi.useFakeTimers();
    const never = new Promise<string>(() => {});
    const p = withBudget(never, EXECUTION_BUDGET_MS, 'search');
    const assertion = expect(p).rejects.toThrow(/超过 15s 预算（search）/);
    await vi.advanceTimersByTimeAsync(EXECUTION_BUDGET_MS);
    await assertion;
  });

  it('到期前完成则不触发超时', async () => {
    vi.useFakeTimers();
    const slow = new Promise<string>((resolve) => setTimeout(() => resolve('ok'), 500));
    const p = withBudget(slow, 1000);
    await vi.advanceTimersByTimeAsync(500);
    await expect(p).resolves.toBe('ok');
  });
});

describe('结果裁剪（静默截断而非报错）', () => {
  it('capList：101 条搜索 → 100', () => {
    const items = Array.from({ length: SEARCH_MAX_RESULTS + 1 }, (_, i) => i);
    expect(capList(items, SEARCH_MAX_RESULTS)).toHaveLength(SEARCH_MAX_RESULTS);
  });
  it('capList：未超限原样返回', () => {
    expect(capList([1, 2], SEARCH_MAX_RESULTS)).toEqual([1, 2]);
  });
  it('capContent：超过 2MB 截断', () => {
    const text = 'x'.repeat(CONTENT_MAX_LENGTH + 10);
    expect(capContent(text)).toHaveLength(CONTENT_MAX_LENGTH);
  });
});

describe('whitelistResult — 原型污染防御', () => {
  it('__proto__ 键只落为自有数据属性，不污染 Object.prototype', () => {
    const fields = JSON.parse('{"__proto__":{"polluted":true},"name":"庆余年"}') as Record<
      string,
      unknown
    >;
    const result = whitelistResult(fields);
    expect(result['name']).toBe('庆余年');
    // 中间态是 null 原型对象，Object.assign 语义下 __proto__ 是普通键；展开同样只产自有键
    expect(Object.prototype.hasOwnProperty.call(result, '__proto__')).toBe(true);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
  it('返回普通对象（原型是 Object.prototype），字段白名单原样保留', () => {
    const result = whitelistResult({ name: 'n', author: '', kind: '', bookUrl: 'u' });
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(result).toEqual({ name: 'n', author: '', kind: '', bookUrl: 'u' });
  });
});
