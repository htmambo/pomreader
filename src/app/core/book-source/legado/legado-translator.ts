/**
 * 阅读(Legado) JSON → pomreader 沙箱 JS 源 翻译器
 *
 * 策略：
 *  仅对 **CSS / regex 规则为主** 的 legado 源做自动翻译。
 *  含 java.* / source.* / book.* / cookie.* / Packages. 桥接 → 拒绝（提示走智能添加手写）。
 *  含 jsLib / loginUrl / loginUi / eventListener → 拒绝（这些机制 pomreader 沙箱无法模拟）。
 *  rule 字段为 <js>...</js> / {{...}} 模板 / $.jsonpath → 拒绝（单条字段标 untranslatable）。
 *
 * 翻译输出用 `smart-rules.generateSourceCode(url, rules, { headers })`：
 *  - 复用既有 `extractLinks / extractText / extractHtml` 工具链
 *  - legado `header` JSON 字符串注入到 `const HEADERS = ...`
 *  - 文件头加 @uuid / @tags / @type / @url 让 BookSourceMeta 解析正确
 */
import { LegadoSource, mapLegadoSourceType } from './legado-parser';
import {
  parseSelector,
  ParsedSelector,
  toRulePattern,
} from './legado-selector';
import { generateSourceCode, SourceRules } from '../smart-add/smart-rules';

const UNSUPPORTED_FEATURES = [
  'jsLib',
  'loginUrl',
  'loginUi',
  'eventListener',
] as const;

export interface TranslateResult {
  /** 始终返回 JS 字符串：成功=可执行的 search/bookInfo/chapterContent；失败=骨架 JS（含原始 JSON + 空 stub） */
  js: string;
  /** 是否为骨架（true = 不可执行，需手写） */
  isSkeleton: boolean;
  /** 失败原因（仅 isSkeleton=true 时有值；UI 直接展示） */
  error: string | null;
}

/**
 * LegadoSource → JS 源。
 *
 * 行为：
 *  - 字段全部 CSS / regex 时 → 返回可执行的 JS（isSkeleton=false），error=null
 *  - 命中 java.* / source.* 桥接 或 字段是 <js>/{{}}/$.jsonpath 或缺关键字段时
 *    → 返回"骨架 JS"：把原始 Legado JSON 嵌入为注释 + 空函数 stub 让沙箱能加载但调用时
 *      抛明确错误（用户可在书源管理页编辑补充），error 给出第一条失败原因
 *
 * 调用方永远拿到非空 js（除非 src 本身没有 bookSourceName，那也没有 fileName 没办法写盘）
 * — 这是为了让用户至少能"登记"这个源以便后续编辑。
 */
export function translateLegadoToJs(src: LegadoSource): TranslateResult {
  // 1. 硬拒绝：含 pomreader 沙箱无法模拟的高级特性（拼骨架而不是 null）
  for (const key of UNSUPPORTED_FEATURES) {
    const v = (src as unknown as Record<string, unknown>)[key];
    const isOn = typeof v === 'string' ? v.trim().length > 0 : !!v;
    if (isOn) {
      return makeSkeleton(src, `源含 ${key}（legado 安卓/JVM 桥接），无法自动转换`);
    }
  }
  if (src.enabledCookieJar) {
    return makeSkeleton(src, '源启用 cookieJar，无法自动转换');
  }

  // 2. 解析全部 rule 字段；任一字段命中 untranslatable 即跳骨架
  const parsedSearch = parseAllRules(src.ruleSearch);
  if (parsedSearch.error) {
    return makeSkeleton(src, `ruleSearch.${parsedSearch.error}`);
  }
  const parsedBookInfo = parseAllRules(src.ruleBookInfo);
  if (parsedBookInfo.error) return makeSkeleton(src, `ruleBookInfo.${parsedBookInfo.error}`);
  const parsedToc = parseAllRules(src.ruleToc);
  if (parsedToc.error) return makeSkeleton(src, `ruleToc.${parsedToc.error}`);
  const parsedContent = parseAllRules(src.ruleContent);
  if (parsedContent.error) return makeSkeleton(src, `ruleContent.${parsedContent.error}`);

  // 3. 必须有的字段
  if (!pickCssOrRegex(parsedSearch.map['bookList']) && !pickCssOrRegex(parsedSearch.map['name'])) {
    return makeSkeleton(src, 'ruleSearch 缺少 bookList / name CSS 规则');
  }
  if (!pickCssOrRegex(parsedToc.map['chapterList'])) {
    return makeSkeleton(src, 'ruleToc.chapterList 不是 CSS 规则');
  }
  const contentRule = parsedContent.map['content'];
  if (!pickCssOrRegex(contentRule)) {
    return makeSkeleton(src, 'ruleContent.content 不是 CSS 规则');
  }

  // 4. 构造 SourceRules
  const url = deriveBaseUrl(src);
  const rules: SourceRules = {
    siteName: src.bookSourceName || 'legado-imported',
    searchPath: deriveSearchPath(src, url),
    searchItemPattern:
      pickCssOrRegex(parsedSearch.map['bookList']) ||
      pickCssOrRegex(parsedSearch.map['name']) ||
      'css:a[href]',
    bookTitlePattern:
      pickCssOrRegex(parsedBookInfo.map['name']) ||
      pickCssOrRegex(parsedBookInfo.map['init']) ||
      'css:h1',
    bookAuthorPattern:
      pickCssOrRegex(parsedBookInfo.map['author']) ||
      '@?\\u4f5c\\u8005[\\uff1a:]\\s*(?:<[^>]+>)*([^<]{1,30})',
    chapterItemPattern: pickCssOrRegex(parsedToc.map['chapterList'])!,
    contentPattern: pickCssOrRegex(contentRule)!,
    bookCategoryPattern:
      pickCssOrRegex(parsedBookInfo.map['kind']) ||
      '@?\\u5206\\u7c7b[\\uff1a:]\\s*(?:<[^>]+>)*([^<]{1,20})',
  };

  // 5. header JSON 字符串 → 对象
  const headers = parseHeader(src.header);

  // 6. 生成 JS 主体
  const body = generateSourceCode(url, rules, { headers });

  // 7. 文件头覆盖：@name / @url / @tags / @type / @uuid / @description / @version / @enabled
  const overridden = rewriteHeader(body, src, headers);

  return { js: overridden, isSkeleton: false, error: null };
}

/**
 * 骨架 JS：把原 Legado JSON 嵌入为 JS 注释块（便于用户编辑时参考），
 * 再加 search/bookInfo/chapterContent 三个空 stub —— 沙箱能加载，注册到 registry
 * 后调用时抛明确错误（避免静默失败误导用户）。
 * 头标 @enabled false（用户编辑 + 启用后生效）。
 */
function makeSkeleton(src: LegadoSource, error: string): TranslateResult {
  const url = (() => {
    try {
      return deriveBaseUrl(src);
    } catch {
      return '';
    }
  })();
  const headers: Record<string, string> = parseHeader(src.header);
  const headerLines = buildHeader(src, headers, true);
  const jsonText = safeJsonStringify(src);

  const body = [
    '// 由 legado 订阅源导入（未能自动转换）。失败原因：',
    `//   ${error}`,
    '//',
    '// ── 原始 Legado JSON（参考用）───────────────────────────────────────────────',
    `// ${jsonText.split('\n').join('\n// ')}`,
    '//',
    '// ── 留空待用户手写：编辑此文件实现 search / bookInfo / chapterContent ──────────',
    '//   参考：src/app/core/book-source/js-source/js-source.adapter.ts',
    '//        src/app/core/book-source/smart-add/smart-rules.ts',
    "//   或从「智能添加」生成规则后粘贴到下面。",
    '',
    `async function search(keyword, page) {`,
    `  throw new Error('此源由 legado 导入，需手写 search() — ${error}')`,
    '}',
    '',
    `async function bookInfo(bookUrl) {`,
    `  throw new Error('此源由 legado 导入，需手写 bookInfo() — ${error}')`,
    '}',
    '',
    `async function chapterList(bookUrl) {`,
    `  throw new Error('此源由 legado 导入，需手写 chapterList() — ${error}')`,
    '}',
    '',
    `async function chapterContent(chapterUrl) {`,
    `  throw new Error('此源由 legado 导入，需手写 chapterContent() — ${error}')`,
    '}',
    '',
  ].join('\n');

  return {
    js: [...headerLines, '', body].join('\n'),
    isSkeleton: true,
    error,
  };
}

/** 安全 stringify：避免循环 / 异常对象破坏骨架注释 */
function safeJsonStringify(src: LegadoSource): string {
  try {
    return JSON.stringify(src, null, 2);
  } catch {
    return '/* 原始 JSON 序列化失败，请重新导入 */';
  }
}

// ── 内部工具 ─────────────────────────────────────────────────────────────

/** 解析一个 rule 字段集合；任一字段命中 untranslatable 或不可翻译 kind → 返回 error */
function parseAllRules(rules: import('./legado-types').LegadoRules | undefined): {
  map: Record<string, ParsedSelector>;
  error: string | null;
} {
  const map: Record<string, ParsedSelector> = {};
  if (!rules) return { map, error: null };
  for (const [field, raw] of Object.entries(rules)) {
    if (!raw) continue;
    const p = parseSelector(raw);
    map[field] = p;
    if (p.usesUntranslatableBridge) {
      return { map, error: `${field} 命中 java.* / source.* 桥接 API` };
    }
    if (!isCssOrRegex(p)) {
      // <js> / {{template}} / $.jsonpath → 整源拒绝（提示用户走智能添加）
      return { map, error: `${field} 含 <js>/{{}}/$.jsonpath，非纯 CSS/regex，无法自动转换` };
    }
  }
  return { map, error: null };
}

function isCssOrRegex(p: ParsedSelector): boolean {
  return p.kind === 'css' || p.kind === 'regex' || p.kind === 'literal';
}

function pickCssOrRegex(p: ParsedSelector | undefined): string | null {
  if (!p) return null;
  if (!isCssOrRegex(p)) return null;
  return toRulePattern(p);
}

/** 解析 legado 的 header 字段（JSON 字符串）→ 对象；非法时返回空对象 */
function parseHeader(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val === 'string') out[k] = val;
      else if (typeof val === 'number' || typeof val === 'boolean') out[k] = String(val);
    }
    return out;
  } catch {
    return {};
  }
}

/** 从 searchUrl / bookSourceUrl 推导主站 origin + search path */
function deriveBaseUrl(src: LegadoSource): string {
  // legado bookSourceUrl 有时是描述字符串（如 "大灰狼融合VIP5.0"），不是 URL
  const urls = collectCandidateUrls(src);
  for (const u of urls) {
    try {
      return new URL(u).origin;
    } catch {
      continue;
    }
  }
  // fallback: 拼一个 dummy origin（让 generateSourceCode 不抛）
  return 'https://legado.invalid';
}

function deriveSearchPath(src: LegadoSource, baseUrl: string): string {
  const raw = (src.searchUrl ?? '').trim();
  if (!raw) {
    // 默认 /search?keyword={keyword}
    return '/search?keyword={keyword}';
  }
  // 含 <js>...</js> → 不能直传（沙箱会执行整个文件，但 searchUrl 必须是字面量模板）
  if (/^<js>/i.test(raw)) {
    return '/search?keyword={keyword}';
  }
  // 剥 baseUrl 前缀（避免 //host/search 双 host）
  let path = raw;
  try {
    if (path.startsWith(baseUrl)) path = path.slice(baseUrl.length);
  } catch {
    /* ignore */
  }
  // 兼容 legado 的 {key} 占位符 → 现有模板用 {keyword}
  path = path.replace(/\{key\}/g, '{keyword}');
  return path;
}

/** 从所有可能是 URL 的字段里收集候选（bookSourceUrl / searchUrl / exploreUrl / bookUrlPattern 之外不强取） */
function collectCandidateUrls(src: LegadoSource): string[] {
  const out: string[] = [];
  if (src.searchUrl && /^https?:\/\//i.test(src.searchUrl)) out.push(src.searchUrl);
  if (src.exploreUrl && /^https?:\/\//i.test(src.exploreUrl)) out.push(src.exploreUrl);
  if (src.bookSourceUrl && /^https?:\/\//i.test(src.bookSourceUrl)) out.push(src.bookSourceUrl);
  return out;
}

/** 覆盖文件头部：把 legado 的元数据写到 // @xxx 注释，让 BookSourceMeta.parseHeaderMeta 读到 */
function rewriteHeader(body: string, src: LegadoSource, headers: Record<string, string>): string {
  const lines = body.split('\n');
  // 找注释头结束位置（第一个非 // 开头的行）
  let headerEnd = 0;
  while (headerEnd < lines.length && lines[headerEnd].trimStart().startsWith('//')) headerEnd++;

  const headerLines = buildHeader(src, headers, false);
  return [...headerLines, ...lines.slice(headerEnd)].join('\n');
}

function buildHeader(
  src: LegadoSource,
  headers: Record<string, string>,
  forceDisabled: boolean,
): string[] {
  const name = src.bookSourceName || 'legado-imported';
  const url = (() => {
    try {
      return deriveBaseUrl(src);
    } catch {
      return '';
    }
  })();
  const type = mapLegadoSourceType(src.bookSourceType);
  const tags = ['legado-import'];
  if (src.bookSourceGroup) tags.push(src.bookSourceGroup);
  const uuid = deriveUuid(src);
  const enabled = forceDisabled ? false : src.enabled !== false;
  const desc = src.bookSourceComment
    ? `由 legado JSON 导入：${src.bookSourceComment.split('\n')[0].slice(0, 80)}`
    : `由 legado JSON 导入${headers && Object.keys(headers).length ? '（含自定义 HTTP header）' : ''}`;

  const lines: string[] = [
    `// @name        ${name}`,
    `// @version     1.0.0`,
    `// @author      legado-import`,
    `// @url         ${url}`,
    `// @enabled     ${enabled ? 'true' : 'false'}`,
    `// @tags        ${tags.join(',')}`,
    `// @type        ${type}`,
    `// @uuid        ${uuid}`,
    `// @description ${desc}`,
  ];
  return lines;
}

/** 用 bookSourceName 派生稳定 uuid（保证同名重复导入不会换 uuid，覆盖式更新） */
function deriveUuid(src: LegadoSource): string {
  const seed = src.bookSourceName || src.bookSourceUrl || 'legado';
  // 简单 FNV-1a 32-bit → hex（不依赖 crypto；浏览器/Node 都可用）
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `legado-${(h >>> 0).toString(16).padStart(8, '0')}`;
}
