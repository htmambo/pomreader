/**
 * 规则引擎硬约束（书源 JSON 规则化 P1.4）
 *
 * 沙箱被移除后没有"超时/杀进程"的兜底，正则回溯一旦发生在渲染端主线程就**无法中断**，
 * 只能事前拦截。这些上限是"宁可误伤也不拖垮 UI"的取舍。
 *
 * ⚠️ ReDoS 检查刻意**保守**（只认两种歧义形态），宁可漏报也不误杀：P0 盘点实测发现存量
 * 合法书源普遍使用 `(?:<[^>]+>)*`、`(?:\s+|,)*` 这类"结构化内层"写法 —— 它们每次重复吃掉
 * 一个确定长度的完整单元，分割唯一，**不是** ReDoS。若用朴素的"嵌套量词即危险"规则，
 * 会把整批合法存量源判死。粗筛版本见 `scripts/audit-booksources.cjs`（同源判定）。
 */

/** 规则串长度上限 */
export const RULE_MAX_LENGTH = 512;
/** 单次源执行的墙钟预算（与现状沙箱 call 超时一致） */
export const EXEC_BUDGET_MS = 15_000;
/** 搜索结果条数上限（对齐 `JsSourceAdapter.MAX_SEARCH_RESULTS`） */
export const SEARCH_MAX_ITEMS = 100;
/** 章节数上限（防畸形源）。
 *  ⚠️ **今天不可达**：链接提取在 CSS 与正则两个分支都先被模板常量 `MAX_EXTRACT_LINKS=500`
 *  截断（`engine.ts` 的 `extractLinks` / `matchAll`），500 < 20000，这道门轮不到。
 *  保留为**冗余兜底**（将来调高提取上限时不会漏掉这道），真实生效的上限是 500。 */
export const CHAPTER_MAX_ITEMS = 20_000;
/**
 * 单章正文上限（防内存爆炸）。
 *
 * ⚠️ 口径是 **UTF-16 code unit**（`String.length`），不是 UTF-8 字节：CJK 与常用符号各占
 * 1 个 code unit，emoji（代理对）占 2。作为"内存占用"的代理量已经够用（误差 ≤ 2 倍），
 * 真按字节算要 `TextEncoder` 全量编码一次（2MB 正文多一次全量遍历），不值当。
 * 截断处落在代理对中间时由 `engine.ts` 的 `truncateText` 退一格，不会产出半个 emoji。
 */
export const CONTENT_MAX_BYTES = 2 * 1024 * 1024;

/** 已知歧义的灾难性回溯形态：重复交替（两支存在前缀重叠）+ 短原子被重复 */
const AMBIGUOUS_ALT_RE = /\(([A-Za-z0-9\\]{1,8})\|([A-Za-z0-9\\]{1,8})\)\s*(?:[+*]|\{\d+,?\d*\})/g;
const NESTED_ATOM_RE = /\(([A-Za-z0-9\\s\W]{0,4}[+*])\)\s*(?:[+*]|\{\d+,?\d*\})/g;

/**
 * 正则是否含歧义重复。
 *
 * `a === b || a.startsWith(b) || b.startsWith(a)`：`(a|ab)+` 在 "aaa…b" 上同样指数级回溯
 * （`ab` 也能被拆成 `a`+`b`），只判两支相等会漏掉；而 `(x|y)+` 两支无前缀关系 → 放行。
 * 内层含 `<` / `>` 视为结构化（自带终止符），非 ReDoS。
 *
 * ⚠️ **已知漏报（保守取舍，登记不改）**：`(\d{1,3})*` 这类"内层是**有界**重复"的形态同样
 * 歧义（"123" 可切成 1+23 / 12+3 / 1+2+3），但当前只认内层以 `+` / `*` 结尾者，故放行。
 * 放宽判据就必须连带判 `(?:\s+|,)*` 危险，而 P0 盘点实测存量源**普遍**在用后者 ——
 * 收紧即批量误杀。方案 §3.2 也只要求拦三种形态。判据重估留到 P3 用真实书库重跑 P0 之后。
 */
export function isRiskyRegex(pattern: string): boolean {
  const alt = new RegExp(AMBIGUOUS_ALT_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = alt.exec(pattern)) !== null) {
    const [a, b] = [m[1], m[2]];
    if (a === b || a.startsWith(b) || b.startsWith(a)) return true;
  }
  const nest = new RegExp(NESTED_ATOM_RE.source, 'g');
  while ((m = nest.exec(pattern)) !== null) {
    if (!m[1].includes('<') && !m[1].includes('>')) return true;
  }
  return false;
}

/** 规则串是否通过静态检查（长度 + 正则风险） */
export function checkRule(pattern: string): { ok: true } | { ok: false; reason: string } {
  if (pattern.length > RULE_MAX_LENGTH) {
    return { ok: false, reason: `规则串超长（${pattern.length} > ${RULE_MAX_LENGTH} 字符）` };
  }
  if (isRiskyRegex(pattern)) {
    return { ok: false, reason: '规则含歧义重复（可能触发指数级回溯），请改用 CSS 选择器' };
  }
  return { ok: true };
}

/**
 * 执行预算：超出即抛，让调用方转成"响亮失败"而不是继续卡住主线程
 * ⚠️ 只能在**两次 await 之间**检查（JS 单线程，无法抢占正在跑的同步正则）——
 * 这也是为什么必须**事前**用 `checkRule` 拦掉危险正则：事后中断不了。
 */
export class ExecBudget {
  private readonly startedAt = Date.now();

  constructor(private readonly limitMs: number = EXEC_BUDGET_MS) {}

  elapsed(): number {
    return Date.now() - this.startedAt;
  }

  /** 在每个 await 边界调用；超预算抛错 */
  check(): void {
    if (this.elapsed() > this.limitMs) {
      throw new Error(`源执行超时（预算 ${this.limitMs}ms）`);
    }
  }
}

/**
 * 提取结果对象：字段白名单 + null 原型，替代沙箱里的原型冻结
 * （引擎已无外部代码注入，但统一构造仍然更安全：不会把 `__proto__` 之类带进结果）
 */
export function pickFields<T extends Record<string, unknown>>(
  src: Record<string, unknown>,
  fields: readonly (keyof T)[],
): T {
  const out = Object.create(null) as Record<string, unknown>;
  for (const f of fields) {
    if (f in src) out[f as string] = src[f as string];
  }
  return out as T;
}
