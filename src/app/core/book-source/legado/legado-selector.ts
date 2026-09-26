/**
 * 阅读(Legado) 规则字段语法识别
 *
 * legado 一个 rule* 字段值可以是 5 种语法的混合：
 *  - 纯文本 / CSS 选择器 / JSONPath（`$.foo.bar`）
 *  - `@css:.foo` 显式 CSS 前缀
 *  - `@Regex:第(\d+)章` 显式正则
 *  - `<js>\nresult + ' suffix'\n</js>` 内嵌 JS（沙箱本身可执行）
 *  - `{{$.name}} {{$.id}}` 模板字符串
 *
 * 本模块只做"识别 + untranslatable 检测"，不做完整选择器求值；
 * Level 1+2 翻译器只接受 css / regex / literal 三种 kind，
 * 其余 (js / jsonpath / template) 即便代码可写也不在自动翻译范围内——
 * 见 legado-translator.ts 的 translatable 检查。
 *
 * 命中以下任一关键字视为"用了 untranslatable 桥接" → 整源拒绝自动翻译：
 *   java.  / source.  / book.  / cookie.  / Packages.
 *   getArguments / setArguments（legado 沙箱全局函数）
 */

export type SelectorKind = 'css' | 'regex' | 'js' | 'jsonpath' | 'template' | 'literal';

export interface ParsedSelector {
  kind: SelectorKind;
  /** CSS 选择器（剥 `@css:` 前缀） */
  css: string | null;
  /** 正则源串（剥 `@Regex:` 前缀） */
  regex: string | null;
  /** `<js>...</js>` 内部代码；命中 js 才有值 */
  jsCode: string | null;
  /** 是否含 `{{...}}` 模板片段 */
  hasTemplate: boolean;
  /** 是否命中 java.* / source.* / Packages. 等不可翻译桥接 */
  usesUntranslatableBridge: boolean;
}

const UNTRANSLATABLE_RE = /\b(java\.|source\.|book\.|cookie\.|Packages\.|getArguments\b|setArguments\b)/;

/** 规则字符串 → ParsedSelector；空串返回 literal css=null 的占位（让 translator 报错）。 */
export function parseSelector(rule: string): ParsedSelector {
  const text = (rule ?? '').trim();
  const usesUntranslatableBridge = UNTRANSLATABLE_RE.test(text);
  const hasTemplate = /\{\{[\s\S]*?\}\}/.test(text);

  // 1. <js>...</js> 块（整段是 JS，无其它语法混在内部；忽略 @css:/@Regex:/{{ }} 检测）
  const jsMatch = /^<js>([\s\S]*)<\/js>$/i.exec(text);
  if (jsMatch) {
    return {
      kind: 'js',
      css: null,
      regex: null,
      jsCode: jsMatch[1],
      hasTemplate: false,
      usesUntranslatableBridge,
    };
  }

  // 2. {{...}} 模板（即使里面只是 css/regex，整段也不能当 css 注入，必须模板求值）
  if (hasTemplate) {
    return {
      kind: 'template',
      css: null,
      regex: null,
      jsCode: null,
      hasTemplate: true,
      usesUntranslatableBridge,
    };
  }

  // 3. $.foo.bar JSONPath
  if (/^\$\./.test(text)) {
    return {
      kind: 'jsonpath',
      css: null,
      regex: null,
      jsCode: null,
      hasTemplate: false,
      usesUntranslatableBridge,
    };
  }

  // 4. @Regex:... 显式正则
  const regexMatch = /^@Regex:(.*)$/is.exec(text);
  if (regexMatch) {
    return {
      kind: 'regex',
      css: null,
      regex: regexMatch[1],
      jsCode: null,
      hasTemplate: false,
      usesUntranslatableBridge,
    };
  }

  // 5. @css:... 显式 CSS
  const cssPrefix = /^css:(.*)$/is.exec(text);
  if (cssPrefix) {
    return {
      kind: 'css',
      css: cssPrefix[1].trim(),
      regex: null,
      jsCode: null,
      hasTemplate: false,
      usesUntranslatableBridge,
    };
  }

  // 6. 兜底 literal：原样当 CSS 选择器（用户纯手写 CSS 选择器最常见）
  return {
    kind: 'literal',
    css: text || null,
    regex: null,
    jsCode: null,
    hasTemplate: false,
    usesUntranslatableBridge,
  };
}

/** 选择器是否可翻译为 CSS/regex 规则串（注入到 generateSourceCode 的 const XXX_RULE 字段） */
export function isCssOrRegexKind(p: ParsedSelector): boolean {
  return p.kind === 'css' || p.kind === 'regex' || p.kind === 'literal';
}

/** 给 translator 用的"取 CSS/regex 串"：css 优先；regex 走 css 模式但用 css: 前缀强制 CSS 失败时走 regex
 *  —— 实际是用 smart-rules 的 `isCssRule`：css 直接当 CSS；regex 含正则特征字符自动走正则分支。
 */
export function toRulePattern(p: ParsedSelector): string | null {
  if (p.css !== null) return p.css;
  if (p.regex !== null) return p.regex;
  return null;
}
