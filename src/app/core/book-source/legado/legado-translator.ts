/**
 * 阅读(Legado) JSON → pomreader 书源 JSON 文档 翻译器
 *
 * 策略：
 *  仅对 **CSS / regex 规则为主** 的 legado 源做自动翻译。
 *  含 java.* / source.* / book.* / cookie.* / Packages. 桥接 → 拒绝（提示走智能添加手写）。
 *  含 jsLib / loginUrl / loginUi / eventListener → 拒绝（这些机制 pomreader 无法模拟）。
 *  rule 字段为 <js>...</js> / {{...}} 模板 / $.jsonpath → 拒绝（单条字段标 untranslatable）。
 *
 * 翻译输出用 `smart-rules` 的规则集 → `core/logic/source-doc-build.buildSourceDoc`：
 *  - 复用既有 `extractLinks / extractText / extractHtml` 工具链的同一套规则串
 *  - legado `header` JSON 字符串 → 文档 `headers` 字段
 *  - 源元数据（name / url / tags / type / uuid / description）进文档对应字段
 *
 * 📌 书源 JSON 规则化 P2.3：以前这里产出的是 JS 模板字符串（`generateSourceCode`），
 * 现在直出 `BookSourceDoc`。uuid 派生规则**刻意保持不变**（`deriveUuid`）—— 书架里
 * `Book.bookSourceUuid` 已指向旧 uuid，改派生规则会让所有已导入源集体失联。
 */
import { type LegadoSource, mapLegadoSourceType } from './legado-parser';
import { parseSelector, type ParsedSelector, toRulePattern } from './legado-selector';
import { type SourceRules } from '../smart-add/smart-rules';
import { buildSourceDoc } from '../../logic/source-doc-build';
import { type BookSourceDocDraft } from '../../models/book-source-doc.model';

const UNSUPPORTED_FEATURES = ['jsLib', 'loginUrl', 'loginUi', 'eventListener'] as const;

/** 骨架源（无法自动转换）的占位规则：让文档结构合法、且启用后也只是"抓不到"而非崩溃 */
const SKELETON_RULES: SourceRules = {
  siteName: 'legado-imported',
  searchPath: '/search?keyword={keyword}',
  searchItemPattern: 'css:a[href]',
  bookTitlePattern: 'css:h1',
  bookAuthorPattern: 'css:.author',
  chapterItemPattern: 'css:a[href]',
  contentPattern: 'css:body',
};

export interface TranslateResult {
  /** 始终返回可写盘的文档：成功=可执行规则；失败=骨架文档（enabled:false + legadoRaw） */
  doc: BookSourceDocDraft;
  /** 是否为骨架（true = 不可执行，需手写） */
  isSkeleton: boolean;
  /** 失败原因（仅 isSkeleton=true 时有值；UI 直接展示） */
  error: string | null;
}

/**
 * LegadoSource → 书源 JSON 文档。
 *
 * 行为：
 *  - 字段全部 CSS / regex 时 → 返回可执行文档（isSkeleton=false），error=null
 *  - 命中 java.* / source.* 桥接 或 字段是 <js>/{{}}/$.jsonpath 或缺关键字段时
 *    → 返回"骨架文档"：`enabled: false` + `legadoRaw` 内嵌原始 JSON，error 给出第一条失败原因。
 *      骨架源**不进 registry**（`registerRuleAdapters` 跳过 `enabled === false`），
 *      用户在管理页补完规则并启用后才生效。
 *
 * 调用方永远拿到非空 doc（除非 src 本身没有 bookSourceName，那也没有 fileName 没办法写盘）
 * — 这是为了让用户至少能"登记"这个源以便后续编辑。
 */
export function translateLegadoToDoc(src: LegadoSource): TranslateResult {
  // 1. 硬拒绝：含 pomreader 无法模拟的高级特性（拼骨架而不是 null）
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
  // ruleSearch.author / ruleSearch.kind 在 legado 里同样是「bookList 条目内部」的规则 → 直接映射为
  // 搜索结果增强规则(可选;源没写就不给值,不用启发式猜测,避免污染搜索结果)
  const searchAuthorRule = pickCssOrRegex(parsedSearch.map['author']);
  const searchCategoryRule = pickCssOrRegex(parsedSearch.map['kind']);
  const rules: SourceRules = {
    siteName: src.bookSourceName || 'legado-imported',
    searchPath: deriveSearchPath(src, url),
    searchItemPattern:
      pickCssOrRegex(parsedSearch.map['bookList']) ||
      pickCssOrRegex(parsedSearch.map['name']) ||
      'css:a[href]',
    ...(searchAuthorRule ? { searchAuthorPattern: searchAuthorRule } : {}),
    ...(searchCategoryRule ? { searchCategoryPattern: searchCategoryRule } : {}),
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

  // 6. 组装文档：uuid 沿用既有派生规则（书架里的 bookSourceUuid 已指向它）
  const doc = buildSourceDoc({
    uuid: deriveUuid(src),
    name: src.bookSourceName || 'legado-imported',
    homepage: url,
    urls: collectCandidateUrls(src).filter((u) => safeOrigin(u) === url),
    rules,
    headers,
    enabled: src.enabled !== false,
    sourceType: mapLegadoSourceType(src.bookSourceType),
    author: 'legado-import',
    description: buildDescription(src, headers),
    tags: ['legado-import', ...(src.bookSourceGroup ? [src.bookSourceGroup] : [])],
    sourceVersion: '1.0.0',
  });

  return { doc, isSkeleton: false, error: null };
}

/** 取 URL 的 origin；非法返回空串 */
function safeOrigin(raw: string): string {
  try {
    return new URL(raw).origin;
  } catch {
    return '';
  }
}

/** 描述文案：与旧文件头 `@description` 同一套措辞，别让用户看到"换了个说法" */
function buildDescription(src: LegadoSource, headers: Record<string, string>): string {
  if (src.bookSourceComment) {
    return `由 legado JSON 导入：${src.bookSourceComment.split('\n')[0].slice(0, 80)}`;
  }
  return `由 legado JSON 导入${headers && Object.keys(headers).length ? '（含自定义 HTTP header）' : ''}`;
}

/**
 * 骨架文档：`enabled: false` + `legadoRaw` 内嵌原始 JSON
 *
 * 与旧"骨架 JS"的等价物：旧版靠空 stub 函数在被调用时抛错来避免静默失败；
 * JSON 侧靠 `enabled: false` 让它**根本不被注册**，效果更彻底（也少一次运行时抛错）。
 * `legadoRaw` 让用户在管理页仍能看到原始配置并据此补规则。
 */
function makeSkeleton(src: LegadoSource, error: string): TranslateResult {
  const headers = parseHeader(src.header);
  const doc = buildSourceDoc({
    uuid: deriveUuid(src),
    name: src.bookSourceName || 'legado-imported',
    homepage: deriveBaseUrl(src),
    rules: SKELETON_RULES,
    headers,
    // 骨架一律禁用：填完规则由用户显式启用，绝不"导入即可用"的错觉
    enabled: false,
    sourceType: mapLegadoSourceType(src.bookSourceType),
    author: 'legado-import',
    description: `${buildDescription(src, headers)}（未转换：${error}）`,
    tags: ['legado-import', 'needs-manual', ...(src.bookSourceGroup ? [src.bookSourceGroup] : [])],
    sourceVersion: '1.0.0',
    legadoRaw: safeJsonStringify(src),
  });
  return { doc, isSkeleton: true, error };
}

/** 安全 stringify：避免循环 / 异常对象破坏 `legadoRaw` */
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
