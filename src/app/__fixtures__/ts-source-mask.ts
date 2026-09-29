/**
 * TS 源码掩码器 —— 两个静态守卫 spec 共用（`__fixtures__` 约定：只给测试用的资产）
 *
 * ## 用途
 *
 * 把注释与字符串**内容**挖成空格（保留引号、保留长度、保留换行），得到两份等长视图：
 *
 * - `code`：注释 + 字符串内容都挖空 → 用于"结构匹配"（找 `imports: [`、找调用名、数括号配平）。
 *   在它上面做正则，结果**天然只来自代码区**，不会被注释或字符串内容带偏。
 * - `nocomment`：只挖空注释，字符串内容保留 → 用于读取字符串**数据**
 *   （`selector: 'nz-switch'`、`templateUrl: './x.html'` —— 这两样本身就是字符串，挖掉就读不到）。
 *
 * ## 为什么要一个"两个视角"的产物而不是"只挖注释"
 *
 * 只想挖注释的话，`const s = "imports: [Foo]"` 这种字符串会让 `imports: [` 被误认成真配置；
 * 只挖字符串的话，`selector: 'nz-switch'` 的内容就丢了。两个用途必须分别取景。
 *
 * ## 为什么要显式状态栈而不是"遇到反引号扫到下一个反引号"
 *
 * 模板字面量里只有 `${…}` 是**代码**，其余是字面内容。不认插值的话
 * `` `${a ? 'x' : 'y'}` `` 会在第一个引号处提前截断；而把插值当字面内容整体挖空，
 * 又会让 `imports` 的括号配平被插值里的 `[0]` 带偏。两个方向都实测过（见对应 spec）。
 */

export interface Literal {
  /** 开引号所在下标 */
  start: number;
  /** 闭引号所在下标 */
  end: number;
  quote: "'" | '"' | '`';
}

export interface MaskedSource {
  /**
   * 与原文**等长**。注释与字符串的**内容**被替换成空格（换行保留），**引号保留**。
   * 用途：结构性匹配（找 `imports: [`、找调用名、数括号配平）——在它上面做正则，
   * 结果天然只来自代码区，不会被注释或字符串内容带偏。
   */
  code: string;
  /**
   * 同样等长，但**只**挖空注释，保留字符串内容。
   * 用途：读取字符串**数据**（`selector: 'nz-switch'`、`templateUrl: './x.html'`）。
   * 这两样数据本身就是字符串，挖掉就什么也读不到。
   */
  nocomment: string;
  literals: Literal[];
}

/**
 * 把注释与字符串内容挖空，得到"只剩代码骨架"的等长掩码。
 *
 * 有了它，"找 `imports: [`"、"找 `ɵɵngDeclareNgModule(`"、"数括号配平"就自动免疫
 * 注释与字符串的干扰，不必在每个 helper 里各写一遍跳过逻辑 —— 漏一处就是一个
 * 静默误判。
 *
 * 模板字面量里的 `${…}` 插值是**代码**，不是字符串内容，所以要用显式状态栈，
 * 不能"遇到反引号就一路扫到下一个反引号"（那样 `` `${a ? 'x' : 'y'}` `` 会在
 * 引号处提前截断）。
 *
 * 反过来，插值里的 `[` `]` 也因此会留在掩码中 —— 这不是问题：只有当 `imports: [`
 * 数组内部本身含插值模板时才会有歧义，而 `imports` 数组里只有标识符。
 */
export function maskNonCode(src: string): MaskedSource {
  const code = src.split('');
  const nocomment = src.split('');
  const literals: Literal[] = [];
  // str 帧持有 Literal **本身**（不是副本），闭合时回填 end 才会同步到 literals。
  type Frame =
    | { kind: 'line' }
    | { kind: 'block' }
    | { kind: 'interp'; depth: number }
    | { kind: 'str'; lit: Literal };
  const stack: Frame[] = [];
  /**
   * 挖空**字符串内容**：只动 `code`。
   * `nocomment` 保留字符串内容（selector / templateUrl 路径就是字符串数据），
   * 读数据靠它；`code` 挖掉，才能保证"匹配到的 `template: [` / `ɵɵɵxxModule(` 在代码区"。
   */
  const blankString = (from: number, to: number): void => {
    for (let k = from; k < to; k++) if (code[k] !== '\n') code[k] = ' ';
  };
  /** 挖空**注释**：两份都动（注释在任何视角下都不是有效内容） */
  const blankComment = (from: number, to: number): void => {
    for (let k = from; k < to; k++) {
      if (code[k] !== '\n') code[k] = ' ';
      if (nocomment[k] !== '\n') nocomment[k] = ' ';
    }
  };
  const top = (): Frame | undefined => stack[stack.length - 1];

  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    const next = src[i + 1];
    const t = top();

    // —— 行注释 ——
    if (t?.kind === 'line') {
      if (ch === '\n') stack.pop();
      else blankComment(i, i + 1);
      i++;
      continue;
    }
    // —— 块注释 ——
    if (t?.kind === 'block') {
      if (ch === '*' && next === '/') {
        blankComment(i, i + 2);
        stack.pop();
        i += 2;
      } else {
        blankComment(i, i + 1);
        i++;
      }
      continue;
    }
    // —— 字符串 / 模板字面量内部 ——
    if (t?.kind === 'str') {
      if (ch === '\\') {
        blankString(i, i + 2);
        i += 2;
        continue;
      }
      if (t.lit.quote === '`') {
        // 模板字面量里只有 ${…} 是代码，其余都是字面内容
        if (ch === '`') {
          t.lit.end = i;
          stack.pop();
          i++;
          continue;
        }
        if (ch === '$' && next === '{') {
          blankString(i, i + 2);
          stack.push({ kind: 'interp', depth: 1 });
          i += 2;
          continue;
        }
        blankString(i, i + 1);
        i++;
        continue;
      }
      if (ch === t.lit.quote) {
        t.lit.end = i;
        stack.pop();
        i++;
        continue;
      }
      blankString(i, i + 1);
      i++;
      continue;
    }
    // —— ${…} 内部：仍是代码，只多一层花括号配平 ——
    if (t?.kind === 'interp') {
      if (ch === '{') t.depth++;
      else if (ch === '}') {
        t.depth--;
        if (t.depth === 0) {
          stack.pop();
          i++;
          continue;
        }
      }
    }

    // —— 代码区 ——
    if (ch === '/' && next === '/') {
      blankComment(i, i + 2);
      stack.push({ kind: 'line' });
      i += 2;
      continue;
    }
    if (ch === '/' && next === '*') {
      blankComment(i, i + 2);
      stack.push({ kind: 'block' });
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const lit: Literal = { start: i, end: -1, quote: ch };
      literals.push(lit);
      stack.push({ kind: 'str', lit });
      i++;
      continue;
    }
    i++;
  }
  // 收尾：没闭合的字面量内容截到文末，保证调用方不会拿到 -1 下标
  for (const f of stack) if (f.kind === 'str' && f.lit.end < 0) f.lit.end = src.length;
  return { code: code.join(''), nocomment: nocomment.join(''), literals };
}

/**
 * 括号配平扫描：`mask[open]` 处的括号，闭括号在哪个下标。
 * 配平只在**代码区**计数（掩码已把注释/字符串挖空），故不会数到 `']'` 这种字符。
 * 没配平时返回 -1。
 */
export function balancedEnd(mask: string, open: number, openCh: string, closeCh: string): number {
  let depth = 0;
  for (let i = open; i < mask.length; i++) {
    const ch = mask[i]!;
    if (ch === openCh) depth++;
    else if (ch === closeCh) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 从 `quoteIdx`（开引号位）读出引号内的内容（selector / templateUrl 路径等） */
export function readQuoted(text: string, quoteIdx: number): string | null {
  const quote = text[quoteIdx];
  if (quote !== "'" && quote !== '"' && quote !== '`') return null;
  let j = quoteIdx + 1;
  while (j < text.length) {
    if (text[j] === '\\') {
      j += 2;
      continue;
    }
    if (text[j] === quote) return text.slice(quoteIdx + 1, j);
    j++;
  }
  return null;
}

