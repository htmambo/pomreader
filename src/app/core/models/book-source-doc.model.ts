/**
 * 书源 JSON 规则文档（方案 v2.1 §3.1：书源的唯一载体，规则 + meta 合一）
 *
 * 落盘形态：`<userData>/booksources/<name>.json`（atomicWrite）。
 * valibot schema 与本接口同文件导出 —— 渲染端 rule-engine.service 与主进程
 * booksource-handler 都需要 parse，故不放 electron/ipc/schema.ts（渲染端不可达 electron/）。
 *
 * `rules` 直接复用 smart-rules 的 SourceRules（16 字段 = 7 必填 + 9 可选），
 * 字段名一字不改：转换层越薄越好，rules-panel / buildRules / detect* 全部原样复用。
 */
import * as v from 'valibot';
import type { SourceRules } from '../book-source/smart-add/smart-rules';
import type { SourceType } from '../book-source/source-meta.types';

export interface BookSourceDoc {
  /** 固定标记 'pomreader.booksource'（导入导出/文件识别用） */
  format: 'pomreader.booksource';
  /** schema 版本；将来改结构时靠它做迁移分支（v1 恒为 1） */
  schemaVersion: 1;
  /**
   * 书源唯一 id —— 迁移时必须沿用历史 .js 的 @uuid（缺省回退 fileName，与现状一致），
   * Book.bookSourceUuid 指向它。
   * ⚠️ 回退值与现状同构：带扩展名的文件名（`foo.json`），不得剥扩展名 —— 否则同一逻辑源
   * 迁移前后拿到两个 uuid，Book.bookSourceUuid 匹配不上且不报错（静默换源失败）。
   * 对照：`name` 回退恰好相反（剥扩展名），两者不可互相佐证（booksource-meta.ts:142 vs :150）。
   */
  uuid: string;
  name: string;
  author?: string;
  logo?: string;
  description?: string;
  /** 主站 origin（原 BASE_URL / @url 第一条） */
  homepage: string;
  /**
   * 多镜像（原多条 @url）；v1 仅取 [0] 构造 hostPattern，不做 failover（D7），
   * 顺序原样保留仅为二期留位。
   */
  urls: string[];
  /** 原 .enabled/.disabled marker 文件内联进文档 */
  enabled: boolean;
  sourceType: SourceType;
  /** 原 @version；命名避开与 schemaVersion 撞车 */
  sourceVersion?: string;
  updateUrl?: string;
  tags: string[];
  /** 默认 0；v1 仅镜像间限流（F9），主链路不强制 */
  minDelayMs: number;
  /** 前置依赖源（原 @require） */
  requireUrls: string[];
  /** 自定义请求头（legado header 导入产物，原 HEADERS 常量, F7） */
  headers: Record<string, string>;
  /** 16 字段原样平移（7 必填 + 9 可选，F3），字段名一字不改 */
  rules: SourceRules;
  /** 可选：legado 骨架源内嵌原始 JSON（F8） */
  legadoRaw?: string;
}

/* ── valibot schema ─────────────────────────────────────────────────────── */

const SearchBodyParamSchema = v.object({
  key: v.string(),
  value: v.string(),
});

const ContentReplaceRuleSchema = v.object({
  rule: v.string(),
  replace: v.string(),
});

/**
 * SourceRules schema：7 必填 + 9 可选（F3）。
 * ⚠️ searchMethod 可选、缺省 'GET' —— 必须 optional() + default，不可设 required（E3）。
 */
export const SourceRulesSchema = v.object({
  siteName: v.pipe(v.string(), v.minLength(1, 'siteName 必填')),
  searchPath: v.pipe(v.string(), v.minLength(1, 'searchPath 必填')),
  searchMethod: v.optional(v.picklist(['GET', 'POST', 'POST_RAW']), 'GET'),
  searchBodyParams: v.optional(v.array(SearchBodyParamSchema)),
  searchContentType: v.optional(v.string()),
  searchRawBody: v.optional(v.string()),
  searchItemPattern: v.pipe(v.string(), v.minLength(1, 'searchItemPattern 必填')),
  searchAuthorPattern: v.optional(v.string()),
  searchCategoryPattern: v.optional(v.string()),
  bookTitlePattern: v.pipe(v.string(), v.minLength(1, 'bookTitlePattern 必填')),
  bookAuthorPattern: v.pipe(v.string(), v.minLength(1, 'bookAuthorPattern 必填')),
  chapterItemPattern: v.pipe(v.string(), v.minLength(1, 'chapterItemPattern 必填')),
  contentPattern: v.pipe(v.string(), v.minLength(1, 'contentPattern 必填')),
  contentReplaceRules: v.optional(v.array(ContentReplaceRuleSchema)),
  bookCategoryPattern: v.optional(v.string()),
  coverUrlPattern: v.optional(v.string()),
});

export const BookSourceDocSchema = v.object({
  format: v.literal('pomreader.booksource'),
  schemaVersion: v.literal(1),
  uuid: v.pipe(v.string(), v.minLength(1, 'uuid 必填')),
  name: v.pipe(v.string(), v.minLength(1, 'name 必填')),
  author: v.optional(v.string()),
  logo: v.optional(v.string()),
  description: v.optional(v.string()),
  homepage: v.pipe(v.string(), v.minLength(1, 'homepage 必填')),
  urls: v.array(v.string()),
  enabled: v.boolean(),
  sourceType: v.picklist(['novel', 'comic', 'video', 'music', 'webpage']),
  sourceVersion: v.optional(v.string()),
  updateUrl: v.optional(v.string()),
  tags: v.array(v.string()),
  minDelayMs: v.number(),
  requireUrls: v.array(v.string()),
  headers: v.record(v.string(), v.string()),
  rules: SourceRulesSchema,
  legadoRaw: v.optional(v.string()),
});

/** 文件识别：宽松探针（只看 format 标记，用于导入时分辨书源 JSON 与其他 JSON） */
export function isBookSourceDocLike(value: unknown): value is { format: 'pomreader.booksource' } {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { format?: unknown }).format === 'pomreader.booksource'
  );
}
