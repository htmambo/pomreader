/**
 * JSON 规则引擎的执行护栏（方案 §3.2 硬性上限表）。
 *
 * 背景：JS 模板书源原本在 Web Worker 沙箱里跑，卡死/超限由 worker 兜底；
 * JSON 规则改由主线程 TS 引擎直接执行后没有这层兜底，所以把预算与上限前移到本模块：
 *  - 规则串长度 / 正则静态风险：执行前拦截（灾难性回溯在主线程无法中断，只能事前拦）
 *  - 执行预算 / HTML 上限：执行中与提取前拦截
 *  - 结果条数 / 正文长度：裁剪而非报错（对齐历史 JS 适配器的静默截断语义）
 *  - 提取结果对象：字段白名单 + null 原型中间态，替代沙箱里的原型冻结
 */
import { cssRulesEnabled, isCssRule } from '../smart-add/smart-rules';

/** 单条规则串长度上限（现有规则都是几十字符级，超长多为误填） */
export const RULE_MAX_LENGTH = 512;

/** 单次入口执行预算（对齐历史沙箱 call 的 15s 超时） */
export const EXECUTION_BUDGET_MS = 15_000;

/** 单页 HTML 上限（沿用历史沙箱 QUERY_HTML_LIMIT 同值） */
export const HTML_MAX_LENGTH = 5 * 1024 * 1024;

/** 搜索结果条数上限（沿用历史适配器的 MAX_SEARCH_RESULTS 同值） */
export const SEARCH_MAX_RESULTS = 100;

/** 章节数上限（防畸形源；模板提取层另有 500 上限，本上限是兜底） */
export const CHAPTER_MAX_ITEMS = 20_000;

/** 单章正文长度上限（防内存爆炸） */
export const CONTENT_MAX_LENGTH = 2 * 1024 * 1024;

/** 规则串长度检查：超限报错并带字段名（UI 行内定位用） */
export function assertRuleLength(field: string, rule: string): void {
  if (rule.length > RULE_MAX_LENGTH) {
    throw new Error(`规则超长：${field} 长度 ${rule.length} 超过上限 ${RULE_MAX_LENGTH}`);
  }
}

/** HTML 大小检查：进入提取前调用（文案沿用历史沙箱 proxyQuery） */
export function assertHtmlSize(html: string): void {
  if (html.length > HTML_MAX_LENGTH) {
    throw new Error(`HTML 超过 ${HTML_MAX_LENGTH / 1024 / 1024}MB 解析上限`);
  }
}

/** 单次入口预算：Promise.race 超时；到期 reject，原 Promise 结果（若之后完成）被丢弃 */
export function withBudget<T>(
  task: Promise<T>,
  ms: number = EXECUTION_BUDGET_MS,
  label = '',
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`书源规则执行超过 ${ms / 1000}s 预算${label ? `（${label}）` : ''}`)),
      ms,
    );
  });
  // finally 清定时器：正常完成时不留 dangling timer（fake timers 下尤其重要）
  return Promise.race([task, timeout]).finally(() => clearTimeout(timer));
}

/** 结果条数裁剪：超限静默截断（对齐现状适配器语义，不报错） */
export function capList<T>(items: T[], max: number): T[] {
  return items.length > max ? items.slice(0, max) : items;
}

/** 正文长度裁剪：超限静默截断（理由同 capList） */
export function capContent(text: string, max: number = CONTENT_MAX_LENGTH): string {
  return text.length > max ? text.slice(0, max) : text;
}

/**
 * 字段白名单构造提取结果：先落入 null 原型中间态（__proto__ 等键不会触发原型链写入），
 * 再以展开语法产出普通对象返回（展开用 CreateDataProperty，__proto__ 只是普通自有键）。
 * 替代沙箱里对返回对象的原型冻结。
 */
export function whitelistResult<T extends Record<string, unknown>>(fields: T): T {
  const safe: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(fields)) {
    safe[key] = fields[key];
  }
  return { ...safe } as T;
}

/** F6c 门报错文案（历史沙箱链路同款文案，差分测试期逐字锁定） */
export const CSS_RULES_DISABLED_MESSAGE = 'CSS 规则已禁用（localStorage pom.cssRules=0）';

/**
 * F6c 门：CSS 规则在 localStorage['pom.cssRules']==='0' 时响亮失败。
 * ⚠️ 不能依赖 smart-rules 函数的自带门 —— pickText/matchLinkItems 在 flag=0 时是
 * 静默回退正则，而沙箱链路是 fail；引擎与分页抓取必须在每条 CSS 路径前显式检查。
 */
export function assertCssAllowed(pattern: string): void {
  if (!cssRulesEnabled() && isCssRule(pattern)) {
    throw new Error(CSS_RULES_DISABLED_MESSAGE);
  }
}

// ── 正则静态风险检查 ─────────────────────────────────────────────────────────

/**
 * 嵌套量词启发式（保守，宁缺毋滥 —— 误拒默认规则 = 迁移直接翻车）。
 *
 * 判定规则：扫描模式中每个「括号组 + 紧随其后的 + / * / {n,}（无上限）量词」，
 * 对组体按顶层 `|` 切分后逐个分支检查，命中以下任一即拒绝：
 *  1. 存在空分支（`(a|)*`）—— 组可匹配空串，外套量词必然退化
 *  2. 分支有重复（`(a|a)+`）—— 分支互相重叠，内外层切分有歧义
 *  3. 某分支是「单原子 + 内部 +/* 量词」（`(a+)+` / `(a*)*` / `(\d+)*` / `([^"]*)+`）——
 *     组体自身是重复单元且没有锚定边界字面量，内外层重复重叠；
 *     分支为单个嵌套组时剥一层再判（拦 `((a+))+` 的一层包装绕过）
 *
 * 放行依据（对照）：
 *  - `(?:<[^>]+>)*`（DEFAULT_PATTERNS.bookAuthorPattern，P0 实测必须放行）：
 *    组体含 `<`/`>` 边界字面量（3 个原子，非单原子重复），且内外字符类不相交
 *  - `([^<]{1,30})`：组后无量词，根本不进入检查
 *  - `(a+b+)+` 这类多原子无锚定形态**放行**（已知漏检，保守策略的代价；
 *    真要拦需完整正则语义分析，误伤面太大，留给 P1.5 worker 化兜底）
 */

/** 组体单分支 = 单原子 + 内部 +/* 量词（可带懒惰后缀 ?）的判定正则 */
const SINGLE_ATOM_REPEAT = /^(?:\\.|[^\\()[\]|]|\[[^\]]*\]|\([^()]*\))[+*]\??$/;

/** 组体单分支 = 单个嵌套组（如 ((a+))+ 的外层组体 '(a+)'） */
const SINGLE_WRAPPED_GROUP = /^\([^()]*\)$/;

/** 去掉组体的类型前缀（?: ?= ?! ?<= ?<! ?<name>），得到实际内容 */
function stripGroupPrefix(body: string): string {
  const m = /^\?(?:[:=!]|<[=!]|<[^>]+>)/.exec(body);
  return m ? body.slice(m[0].length) : body;
}

/** 按顶层 | 切分组体（忽略字符类/转义/嵌套组内的 |） */
function splitTopLevelAlternatives(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inClass = false;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (inClass) {
      if (ch === ']') inClass = false;
      continue;
    }
    if (ch === '[') inClass = true;
    else if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === '|' && depth === 0) {
      out.push(body.slice(start, i));
      start = i + 1;
    }
  }
  out.push(body.slice(start));
  return out;
}

/** 组体是否命中拒绝规则 */
function isDangerousGroupBody(body: string): boolean {
  const alternatives = splitTopLevelAlternatives(stripGroupPrefix(body));
  if (alternatives.some((a) => a === '')) return true;
  if (new Set(alternatives).size !== alternatives.length) return true;
  return alternatives.some((a) => {
    if (SINGLE_ATOM_REPEAT.test(a)) return true;
    // 分支是单个嵌套组（((a+))+ 的外层组体 '(a+)'）：剥一层再判，防一层包装绕过
    if (SINGLE_WRAPPED_GROUP.test(a)) return SINGLE_ATOM_REPEAT.test(a.slice(1, -1));
    return false;
  });
}

/** 组后的量词：仅 + / * / {n,}（无上限）构成嵌套重复；? / {n,m} 有界不拦 */
function quantifierAfter(pattern: string, closeIndex: number): boolean {
  const next = pattern[closeIndex + 1];
  if (next === '+' || next === '*') return true;
  if (next === '{') {
    const m = /^\{\d+,\}/.exec(pattern.slice(closeIndex + 1));
    return m !== null;
  }
  return false;
}

/**
 * 正则静态风险检查：发现灾难性回溯形态时报错（带字段名）。
 * 只对会被当作正则编译的模式调用（CSS 选择器不要走这里，:nth-child(2n+1) 等会误伤）。
 */
export function assertRegexSafe(field: string, pattern: string): void {
  const stack: number[] = [];
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (inClass) {
      if (ch === ']') inClass = false;
      continue;
    }
    if (ch === '[') {
      inClass = true;
      continue;
    }
    if (ch === '(') {
      stack.push(i);
      continue;
    }
    if (ch === ')') {
      const open = stack.pop();
      if (open === undefined) continue; // 不配对的 ) 交给 RegExp 编译报错
      if (quantifierAfter(pattern, i) && isDangerousGroupBody(pattern.slice(open + 1, i))) {
        const summary = pattern.length > 60 ? `${pattern.slice(0, 60)}…` : pattern;
        throw new Error(`正则存在灾难性回溯风险：${field}（${summary}）`);
      }
    }
  }
}
