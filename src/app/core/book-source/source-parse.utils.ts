/**
 * 书源结果规范化共用 helper（JSON 规则书源链路用；历史上曾与 JS 链路共用）
 *
 * 抽共用的理由（替代复制）：pickString fallback 链与 toRawSearchItem 的字段命名约定
 * 是 legado 兼容契约（RawSearchItem 的 legado 标准在前、兼容在后），两条 adapter 链路
 * 必须永远一致 —— 复制会随书源字段兼容演进漂移，独一份实现 + 两处引用更安全。
 *
 * 自历史 JS 适配器原样迁出（行为不变）：toRawSearchItem 的 console.debug tag
 * 为中性的 '[SourceParse]'（纯调试日志，无行为语义）。
 */
import { type RawSearchItem } from './book-source.adapter';

/**
 * 单书源 search() 返回结果上限（legado 普遍 10-50 条；100 是宽限兜底，
 * 防止畸形返回拖垮前端渲染 / 污染聚合去重 key 池）。
 */
export const MAX_SEARCH_RESULTS = 100;

/**
 * legado search 返回项 → RawSearchItem 规范化（与 fetchCatalog 同一套 fallback 约定）：
 * - 标准在前：name / author / url / intro
 * - 兼容在后：title / bookUrl / description + 各类常见命名（by/bookAuthor/novelType 等）
 * 非 plain object 一律丢弃；name/url 都为空（即 `[{}]` / `[{name: ""}]`）也丢弃，
 * 避免污染聚合去重 key 池与前端渲染幽灵条目。
 *
 * 调试日志：首次调用时 console.debug 打印原始对象的 keys，便于排查书源
 * 实际使用的字段名（如果所有 fallback 都没命中，按 console 输出收紧 fallback 链）。
 */
let toRawSearchItemLogged = false;
export function toRawSearchItem(raw: unknown): RawSearchItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (!toRawSearchItemLogged) {
    toRawSearchItemLogged = true;
    console.debug('[SourceParse] 调试：search() 第一条原始数据 keys =', Object.keys(obj));
  }
  const name = pickString(obj, 'name', 'title');
  const url = pickString(obj, 'url', 'bookUrl', 'link', 'href');
  if (!name && !url) return null;
  return {
    name,
    author: pickString(obj, 'author', 'writer', 'creator', 'by', 'bookAuthor', 'authorName'),
    kind: pickString(
      obj,
      'kind',
      'genre',
      'category',
      'class',
      'type',
      'sort',
      'tag',
      'classify',
      'bookType',
      'novelType',
    ),
    url,
    intro: pickString(obj, 'intro', 'description', 'summary', 'desc', 'brief'),
  };
}

/**
 * 按序取首个非空字符串（trim 后空字符串也算无值）。fallback 链统一规范：
 * - 入参 it 接受任意对象（含 null/undefined）；内部防御，非 plain object 返回 undefined
 * - caller 不用预先做 cast 或 null 检查
 */
export function pickString(it: unknown, ...keys: string[]): string | undefined {
  if (!it || typeof it !== 'object') return undefined;
  const rec = it as Record<string, unknown>;
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === 'string') {
      const trimmed = v.trim();
      if (trimmed) return trimmed;
    }
  }
  return undefined;
}

/** 主机名 → 正则（剥 www.，转义点号；与 base-source.adapter.ts 思路一致） */
export function buildHostPattern(mainUrl: string): RegExp | null {
  if (!mainUrl) return null;
  try {
    const u = new URL(mainUrl);
    const host = u.hostname.replace(/^www\./, '').replace(/\./g, '\\.');
    return new RegExp(`^https?://([^/]+\\.)?${host}(/|$)`);
  } catch {
    return null;
  }
}
