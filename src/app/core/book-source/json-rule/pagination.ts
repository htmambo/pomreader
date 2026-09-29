/**
 * 书源目录/正文分页抓取（T-1/T-2，设计 docs/Architecture/2026-09-30-BOOKSOURCE-PAGINATION-DESIGN.md §3）。
 *
 * 区域链接图遍历模型：从起始页出发，每页取 area 区域内全部 <a href>，按归一化 URL 去重，
 * 白名单（linkPattern 显式正则，或 URL 页码位推断）过滤后入队，直到队列空或撞 maxPages。
 *
 * 三件套（防逃逸/页序/资源上限）：
 *  - 白名单恒以起始页 URL 形状为基准 → 「下一章」/导航/广告链接形状不符被天然挡在门外
 *  - 页序恢复：页码位数字升序（起始页无页码值时恒最前）→ linkPattern 数字组 → DOM 发现序
 *  - maxPages（调用方给缺省：目录 100 / 正文 20）硬上限 200；页间消费 doc.minDelayMs；串行
 *
 * 单页失败（非首页）= 停在已抓部分，error 放进返回结构不 throw；首页失败直接 throw
 * （与现状单页行为一致，语义上抛由调用方定）。
 *
 * 纯 TS 模块（同 engine.ts 风格）：fetch / trace / sleep 全部注入，vitest 可打桩。
 */
import { isCssRule, matchLinkItems, pickHtml, type PaginationRule } from '../smart-add/smart-rules';
import { assertCssAllowed, assertHtmlSize, assertRegexSafe, assertRuleLength } from './guard';

/** maxPages 硬上限（schema 层 maxValue 同款，引擎侧兜底） */
export const PAGINATION_HARD_MAX_PAGES = 200;

/** 目录分页缺省最大页数 */
export const TOC_DEFAULT_MAX_PAGES = 100;

/** 正文分页缺省最大页数 */
export const CONTENT_DEFAULT_MAX_PAGES = 20;

/** 页序恢复方式（§3.3 三层） */
export type PageOrder = 'page-number' | 'link-pattern-number' | 'dom-discovery';

/** 页码位（§3.2 推断产物）：某个 path 段下标，或某个 query 键 */
export type PageNumberPosition = { kind: 'path'; index: number } | { kind: 'query'; key: string };

/** 已抓取的一页（url 为归一化后的绝对 URL） */
export interface CrawledPage {
  url: string;
  html: string;
}

export interface PaginationCrawlResult {
  /** 已抓取页（按 §3.3 页序恢复排序后） */
  pages: CrawledPage[];
  /** 撞 maxPages 上限（队列未空被迫终止） */
  truncated: boolean;
  /** 页序恢复方式（dom-discovery = 兜底，结果可能乱序） */
  order: PageOrder;
  /** 页码位推断成功时的位置（linkPattern 模式下缺省） */
  inferredPosition?: PageNumberPosition;
  /** 单页失败（非首页）的错误信息：循环终止，返回已抓部分 */
  error?: string;
}

/** 抓取过程 trace 事件（由引擎转成 RuleTrace） */
export type PaginationTraceEvent =
  /** 页码位推断失败：不跟随任何链接（等同单页），提示用户补 linkPattern */
  | { type: 'inference-failed' }
  /** 撞 maxPages 上限 */
  | { type: 'truncated'; maxPages: number };

export interface CrawlPaginatedOptions {
  /** 单页抓取（引擎注入 request：trace/预算/CF 链路都在其中） */
  fetchPage: (url: string) => Promise<string>;
  /** maxPages 缺省值（目录 TOC_DEFAULT_MAX_PAGES / 正文 CONTENT_DEFAULT_MAX_PAGES） */
  defaultMaxPages: number;
  /** 页间间隔 ms（doc.minDelayMs）；0/缺省不等待 */
  minDelayMs?: number;
  /** 抓取过程 trace 事件 */
  onTrace?: (event: PaginationTraceEvent) => void;
  /** 测试注入睡眠；缺省 setTimeout */
  sleep?: (ms: number) => Promise<void>;
}

const PURE_DIGITS = /^\d+$/;

/** URL 归一化（去重键）：绝对化在 matchLinkItems 已完成，这里去 #hash；不去 query（保守：可能携带页码） */
function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.href;
  } catch {
    return url;
  }
}

/** URL 形状：origin + path 段数组 + query 键值（形状对比与页码位推断的共同基础） */
interface UrlShape {
  origin: string;
  pathSegs: string[];
  query: Map<string, string>;
}

function parseShape(url: string): UrlShape | null {
  try {
    const u = new URL(url);
    return {
      origin: u.origin,
      pathSegs: u.pathname.split('/'),
      query: new Map(u.searchParams.entries()),
    };
  } catch {
    return null;
  }
}

function valueAt(shape: UrlShape, pos: PageNumberPosition): string | undefined {
  return pos.kind === 'path' ? shape.pathSegs[pos.index] : shape.query.get(pos.key);
}

/**
 * 形状对比：origin / path 段数 / query 键集合相同才可比（否则返回 null）；
 * 可比时返回所有取值不同的位置（path 段 或 query 值）。
 */
function diffPositions(start: UrlShape, other: UrlShape): PageNumberPosition[] | null {
  if (start.origin !== other.origin) return null;
  if (start.pathSegs.length !== other.pathSegs.length) return null;
  const startKeys = [...start.query.keys()].sort();
  const otherKeys = [...other.query.keys()].sort();
  if (startKeys.length !== otherKeys.length || startKeys.some((k, i) => k !== otherKeys[i])) {
    return null;
  }
  const diffs: PageNumberPosition[] = [];
  for (let i = 0; i < start.pathSegs.length; i++) {
    if (start.pathSegs[i] !== other.pathSegs[i]) diffs.push({ kind: 'path', index: i });
  }
  for (const key of startKeys) {
    if (start.query.get(key) !== other.query.get(key)) diffs.push({ kind: 'query', key });
  }
  return diffs;
}

/**
 * 页码位推断（§3.2，仅在起始页区域链接上做一次）：
 * 与起始页同形状、恰好一个位置不同、且差异值为纯数字的链接是候选；
 * 候选数最多的位置即页码位；无候选 → 推断失败。
 */
function inferPageNumberPosition(
  startShape: UrlShape,
  linkUrls: string[],
): PageNumberPosition | undefined {
  const counts = new Map<string, { pos: PageNumberPosition; count: number }>();
  for (const url of linkUrls) {
    const shape = parseShape(url);
    if (!shape) continue;
    const diffs = diffPositions(startShape, shape);
    if (!diffs || diffs.length !== 1) continue;
    const diff = diffs[0];
    const value = valueAt(shape, diff);
    if (value === undefined || !PURE_DIGITS.test(value)) continue;
    const id = diff.kind === 'path' ? `p:${diff.index}` : `q:${diff.key}`;
    const entry = counts.get(id);
    if (entry) entry.count++;
    else counts.set(id, { pos: diff, count: 1 });
  }
  let best: { pos: PageNumberPosition; count: number } | undefined;
  for (const entry of counts.values()) {
    if (!best || entry.count > best.count) best = entry;
  }
  return best?.pos;
}

/** 推断模式白名单：与起始页同形状、仅页码位可不同、页码位值为纯数字 */
function matchesInferredPosition(
  startShape: UrlShape,
  pos: PageNumberPosition,
  url: string,
): boolean {
  const shape = parseShape(url);
  if (!shape) return false;
  const diffs = diffPositions(startShape, shape);
  if (!diffs) return false;
  for (const d of diffs) {
    if (d.kind !== pos.kind) return false;
    if (pos.kind === 'path' && (d.kind !== 'path' || d.index !== pos.index)) return false;
    if (pos.kind === 'query' && (d.kind !== 'query' || d.key !== pos.key)) return false;
  }
  const value = valueAt(shape, pos);
  return value !== undefined && PURE_DIGITS.test(value);
}

/** linkPattern 的首个纯数字捕获组值（§3.3 规则 3 排序键）；无命中/无数字组 → undefined */
function firstNumericGroup(re: RegExp, url: string): number | undefined {
  const m = re.exec(url);
  if (!m) return undefined;
  for (let i = 1; i < m.length; i++) {
    const g = m[i];
    if (g !== undefined && PURE_DIGITS.test(g)) return Number.parseInt(g, 10);
  }
  return undefined;
}

/**
 * 稳定排序（§3.3）：有数字值按升序；起始页无数字值（bookUrl 无页码段）时恒排最前，
 * 其余无值页保持 DOM 发现序排尾。
 */
function sortPages(
  pages: CrawledPage[],
  startUrl: string,
  valueOf: (p: CrawledPage) => number | undefined,
): CrawledPage[] {
  const keyOf = (p: CrawledPage): number => {
    const v = valueOf(p);
    if (v !== undefined) return v;
    return p.url === startUrl ? -1 : Number.POSITIVE_INFINITY;
  };
  return pages
    .map((p, i) => ({ p, i, key: keyOf(p) }))
    .sort((a, b) => a.key - b.key || a.i - b.i)
    .map((x) => x.p);
}

/** 页序恢复（§3.3 三层规则） */
function orderPages(
  pages: CrawledPage[],
  startUrl: string,
  position: PageNumberPosition | undefined,
  linkRe: RegExp | undefined,
): { pages: CrawledPage[]; order: PageOrder } {
  if (position) {
    const valueOf = (p: CrawledPage): number | undefined => {
      const shape = parseShape(p.url);
      if (!shape) return undefined;
      const v = valueAt(shape, position);
      return v !== undefined && PURE_DIGITS.test(v) ? Number.parseInt(v, 10) : undefined;
    };
    return { pages: sortPages(pages, startUrl, valueOf), order: 'page-number' };
  }
  if (linkRe) {
    const valueOf = (p: CrawledPage) => firstNumericGroup(linkRe, p.url);
    if (pages.some((p) => valueOf(p) !== undefined)) {
      return { pages: sortPages(pages, startUrl, valueOf), order: 'link-pattern-number' };
    }
  }
  return { pages, order: 'dom-discovery' };
}

/**
 * 分页链接图遍历抓取（§3 主流程）。
 * 首页 fetch 失败直接 throw；后续页失败终止循环、返回已抓部分（error 字段携带错误）。
 */
export async function crawlPaginatedPages(
  startUrl: string,
  pagination: PaginationRule,
  options: CrawlPaginatedOptions,
): Promise<PaginationCrawlResult> {
  const { fetchPage, defaultMaxPages, minDelayMs = 0, onTrace } = options;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const maxPages = Math.min(pagination.maxPages ?? defaultMaxPages, PAGINATION_HARD_MAX_PAGES);

  // 区域规则护栏：长度 + 正则静态风险 + F6c 门（与引擎单值/列表规则同款检查）
  assertRuleLength('pagination.area', pagination.area);
  if (!isCssRule(pagination.area)) assertRegexSafe('pagination.area', pagination.area);
  assertCssAllowed(pagination.area);
  let linkRe: RegExp | undefined;
  const linkPattern = pagination.linkPattern?.trim();
  if (linkPattern) {
    assertRuleLength('pagination.linkPattern', linkPattern);
    assertRegexSafe('pagination.linkPattern', linkPattern);
    linkRe = new RegExp(linkPattern);
  }

  const startNorm = normalizeUrl(startUrl);
  const startShape = parseShape(startNorm);
  const queue: string[] = [startNorm];
  const seen = new Set<string>([startNorm]);
  const pages: CrawledPage[] = [];
  let position: PageNumberPosition | undefined;
  let inferenceFailed = false;
  let error: string | undefined;

  while (queue.length > 0 && pages.length < maxPages) {
    const url = queue.shift()!;
    if (pages.length > 0 && minDelayMs > 0) await sleep(minDelayMs);
    let html: string;
    try {
      html = await fetchPage(url);
      assertHtmlSize(html);
    } catch (e) {
      // 首页失败直接抛（与现状单页行为一致）；单页失败 = 停在已抓部分（§5 取舍 1）
      if (pages.length === 0) throw e;
      error = (e as Error).message;
      break;
    }
    pages.push({ url, html });

    const areaHtml = pickHtml(pagination.area, html);
    if (!areaHtml) continue; // 无分页区域 = 单页
    const links = matchLinkItems('a', areaHtml, url).map((l) => normalizeUrl(l.url));

    // 页码位推断：仅在起始页区域链接上做一次，锁定后全次抓取复用
    if (!linkRe && !position && !inferenceFailed) {
      position = startShape ? inferPageNumberPosition(startShape, links) : undefined;
      if (!position) {
        inferenceFailed = true;
        onTrace?.({ type: 'inference-failed' });
      }
    }

    for (const norm of links) {
      if (!norm || seen.has(norm)) continue;
      if (linkRe) {
        if (!linkRe.test(norm)) continue;
      } else {
        if (!position || !startShape) continue;
        if (!matchesInferredPosition(startShape, position, norm)) continue;
      }
      seen.add(norm);
      queue.push(norm);
    }
  }

  const truncated = queue.length > 0;
  if (truncated) onTrace?.({ type: 'truncated', maxPages });

  const ordered = orderPages(pages, startNorm, position, linkRe);
  return {
    pages: ordered.pages,
    truncated,
    order: ordered.order,
    ...(position ? { inferredPosition: position } : {}),
    ...(error ? { error } : {}),
  };
}
