/**
 * guard 单测（书源 JSON 规则化 P1.4）
 *
 * 守卫是**唯一**的一道防线（引擎跑在主线程，没有沙箱可以 terminate），所以这里既测
 * "该拦的拦住了"，也测"不该拦的别误杀"——后者同等重要：误杀会让存量合法书源集体失效。
 */
import { describe, it, expect } from 'vitest';
import {
  CHAPTER_MAX_ITEMS,
  CONTENT_MAX_BYTES,
  EXEC_BUDGET_MS,
  RULE_MAX_LENGTH,
  SEARCH_MAX_ITEMS,
  ExecBudget,
  checkRule,
  isRiskyRegex,
  pickFields,
} from './guard';

describe('checkRule —— 长度上限', () => {
  it('恰好等于上限放行', () => {
    expect(checkRule('a'.repeat(RULE_MAX_LENGTH)).ok).toBe(true);
  });

  it('超 1 字符即拦', () => {
    const r = checkRule('a'.repeat(RULE_MAX_LENGTH + 1));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('超长');
  });

  it('放行不误伤：中英混排的正常规则串（按字符数而非字节数算）', () => {
    expect(checkRule('css:div.content > p:nth-child(2)').ok).toBe(true);
  });
});

describe('isRiskyRegex —— 必须拦的歧义重复', () => {
  it.each([
    ['(a+)+', '短原子被重复'],
    ['(a*)*', '星号版本'],
    ['(a|a)+', '两支全等'],
    ['(a|ab)+', '前缀重叠（ab 可拆成 a+b）'],
    ['(ab|a)+', '前缀重叠（反向）'],
    ['(\\d+)*', '字符类量词被重复'],
  ])('%s → 危险', (pattern) => {
    expect(isRiskyRegex(pattern)).toBe(true);
  });
});

describe('isRiskyRegex —— 已知漏报（保守取舍的代价，登记不改）', () => {
  /**
   * `(\d{1,3})*` 这类「内层是**有界**重复」确实是歧义的（"123" 可切成 1+23 / 12+3 / 1+2+3），
   * 当前检测器只认内层以 `+` / `*` 结尾的形态，故漏报。
   *
   * 不修的理由：把判据放宽到"内层任意变长量词"就必须同时判 `(?:\s+|,)*` 危险，而 P0 盘点
   * 实测存量源**普遍**在用后者 —— 收紧即批量误杀。方案 §3.2 也只要求拦三种形态。
   * 判据重估留到 P3 在真实书库重跑 P0 之后（见任务文档「已知局限」）。
   */
  it('(\\d{1,3})* 目前放行（已知漏报，不在承诺范围内）', () => {
    expect(isRiskyRegex('(\\d{1,3})*')).toBe(false);
  });
});

describe('isRiskyRegex —— 必须放行的存量合法写法', () => {
  // P0 盘点实测：存量源普遍使用下面这些形态。误杀它们 = 整批书源在迁移后失效。
  it.each([
    ['(?:<[^>]+>)*', '结构化内层，自带终止符，每次重复吃掉确定长度'],
    ['(?:\\s+|,)*', '两种定长分隔符交替，无歧义'],
    ['<a[^>]+href="([^"]+)"[^>]*>([^<]{2,40})<\\/a>', 'DEFAULT_PATTERNS.searchItemPattern'],
    ['<h1[^>]*>([\\s\\S]*?)<\\/h1>', 'DEFAULT_PATTERNS.bookTitlePattern'],
    ['作者[：:]\\s*(?:<[^>]+>)*([^<]{1,30})', 'DEFAULT_PATTERNS.bookAuthorPattern'],
    ['(x|y)+', '两支首字符不同，无前缀重叠'],
    ['(\\d+|\\w+)+', '两支字符类不重叠'],
  ])('%s → 安全', (pattern) => {
    expect(isRiskyRegex(pattern)).toBe(false);
  });
});

describe('isRiskyRegex —— 不依赖全局 lastIndex 状态', () => {
  it('同一实例连续判定结果稳定（reg 带 /g，必须每次重建）', () => {
    const p = '(a|ab)+';
    expect(isRiskyRegex(p)).toBe(true);
    expect(isRiskyRegex(p)).toBe(true);
    expect(isRiskyRegex(p)).toBe(true);
  });

  it('安全规则连续判定同样稳定', () => {
    const p = '(?:<[^>]+>)*';
    expect(isRiskyRegex(p)).toBe(false);
    expect(isRiskyRegex(p)).toBe(false);
  });
});

describe('checkRule —— 危险正则的拒绝文案可读', () => {
  it('指向"改用 CSS 选择器"这个可执行的出路', () => {
    const r = checkRule('(a+)+');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('CSS');
  });
});

describe('ExecBudget', () => {
  it('预算内不抛', () => {
    const b = new ExecBudget(1000);
    expect(() => b.check()).not.toThrow();
  });

  it('超预算抛错，文案带预算值', () => {
    const b = new ExecBudget(0);
    b.check(); // elapsed 可能还是 0，容忍这一次
    // 明确推进时间：用 -1 预算保证第一次 check 就越界
    const b2 = new ExecBudget(-1);
    expect(() => b2.check()).toThrow(/预算/);
  });

  it('elapsed 随时间增长', async () => {
    const b = new ExecBudget(10_000);
    const t0 = b.elapsed();
    await new Promise((r) => setTimeout(r, 5));
    expect(b.elapsed()).toBeGreaterThanOrEqual(t0);
  });

  it('默认预算是 15s（与现状沙箱 call 超时一致）', () => {
    expect(EXEC_BUDGET_MS).toBe(15_000);
  });
});

describe('pickFields —— 替代沙箱的原型冻结', () => {
  it('只取白名单字段', () => {
    const src = { a: 1, b: 2, evil: 3 };
    expect(pickFields(src, ['a', 'b'])).toEqual({ a: 1, b: 2 });
  });

  it('缺席字段不补 undefined（避免"看起来有这个键"）', () => {
    const out = pickFields({ a: 1 } as Record<string, unknown>, ['a', 'zzz']);
    expect('zzz' in out).toBe(false);
  });

  it('结果原型为 null，不会被 __proto__ 污染', () => {
    const out = pickFields({} as Record<string, unknown>, ['a']);
    expect(Object.getPrototypeOf(out)).toBeNull();
  });
});

describe('上限常量与方案 §3.2 guard 表一致', () => {
  it('SEARCH_MAX_ITEMS = 100（对齐 JsSourceAdapter.MAX_SEARCH_RESULTS）', () => {
    expect(SEARCH_MAX_ITEMS).toBe(100);
  });

  it('CHAPTER_MAX_ITEMS = 20000', () => {
    expect(CHAPTER_MAX_ITEMS).toBe(20_000);
  });

  it('CONTENT_MAX_BYTES = 2MB', () => {
    expect(CONTENT_MAX_BYTES).toBe(2 * 1024 * 1024);
  });
});
