/**
 * 阅读(Legado) 订阅源 JSON 解析
 *
 * 输入形式有 3 种（legado 社区里都会出现）：
 *  1. 单源 JSON 对象 `{...}`
 *  2. 订阅列表 JSON 数组 `[{...}, {...}]`
 *  3. base64 编码的上述任一种（订阅 URL 返回时常这么干；可能含 `base64,` 前缀）
 *
 * 解析策略：
 *  - trim 后看首字符；`[` / `{` 直接 JSON.parse；其它先当 base64 解码再嗅探一次
 *  - 解码后非空且是数组 → 返回数组；是对象 → 包成数组
 *  - 字段缺失给空字符串 / 0 兜底（保证下游 translator 拿到的 shape 完整）
 *  - 解析失败抛 Error，message 含失败原因 + 原始片段（便于 UI 弹错）
 */
import { LegadoSource, LEGADO_SOURCE_TYPE_MAP } from './legado-types';
export type { LegadoSource, LegadoSourceType } from './legado-types';

/** 解析后的统一数组（单源也包成数组） */
export function parseLegadoText(raw: string): LegadoSource[] {
  const text = (raw ?? '').trim();
  if (!text) throw new Error('Legado 文本为空');

  // 1. 直接 JSON 路径
  const direct = tryParseJsonArrayOrObject(text);
  if (direct) return normalizeMany(direct);

  // 2. base64 路径（订阅 URL 常见）
  const decoded = tryDecodeBase64(text);
  if (decoded) {
    const fromBase64 = tryParseJsonArrayOrObject(decoded);
    if (fromBase64) return normalizeMany(fromBase64);
  }

  throw new Error(
    `Legado 文本既不是合法 JSON 也不是 base64 JSON：${text.slice(0, 60)}…`,
  );
}

/** 浏览器/Electron 通用：拉 URL 拿文本再 parse；非 2xx 抛 */
export async function fetchAndParseLegadoUrl(url: string): Promise<LegadoSource[]> {
  const u = (url ?? '').trim();
  if (!u) throw new Error('URL 为空');
  let resp: Response;
  try {
    resp = await fetch(u, { method: 'GET' });
  } catch (e) {
    throw new Error(`拉订阅源失败：${(e as Error).message ?? e}`);
  }
  if (!resp.ok) throw new Error(`订阅源 HTTP ${resp.status}`);
  const text = await resp.text();
  return parseLegadoText(text);
}

/** 内部：JSON.parse 一次，识别为对象数组 → 原样返回；对象 → 单元素数组；其它 null */
function tryParseJsonArrayOrObject(text: string): unknown[] | null {
  try {
    const v = JSON.parse(text);
    if (Array.isArray(v)) return v;
    if (v && typeof v === 'object') return [v];
    return null;
  } catch {
    return null;
  }
}

/** 内部：base64 → utf-8 字符串；剥 `base64,` dataURL 前缀；容忍 padding 缺失。
 *  解码失败或结果非 JSON 起步返回 null（不抛 — 让上层走"既不是 JSON 也不是 base64"路径给明确错误）。
 */
function tryDecodeBase64(text: string): string | null {
  // 剥 dataURL 前缀
  const stripped = text.replace(/^data:[^;]+;base64,/, '').trim();
  // 补齐 padding
  const pad = stripped.length % 4;
  const padded = pad ? stripped + '='.repeat(4 - pad) : stripped;
  try {
    if (typeof atob !== 'function') return null;
    const binary = atob(padded);
    // 用 TextDecoder 兼容 utf-8（legado 订阅源常用中文）
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const decoded = new TextDecoder('utf-8').decode(bytes);
    // 解码成功后再嗅探一次；只有再次嗅探成功才认账，避免把 base64 失败吞成空字符串
    return decoded;
  } catch {
    return null;
  }
}

/** 把 unknown[] 规整为 LegadoSource[]；任何字段缺失给空字符串 / 0 兜底 */
function normalizeMany(arr: unknown[]): LegadoSource[] {
  const out: LegadoSource[] = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    out.push(normalizeOne(item as Record<string, unknown>));
  }
  return out;
}

function normalizeOne(o: Record<string, unknown>): LegadoSource {
  const s: LegadoSource = {
    bookSourceName: strOrEmpty(o['bookSourceName']),
    bookSourceUrl: strOrEmpty(o['bookSourceUrl']),
    bookSourceType: numOrZero(o['bookSourceType']),
  };
  // 其余可选字段按需拷贝（避免把 `null` 写进结构；缺则不写）
  copyOpt(o, 'bookSourceGroup', (v) => (s.bookSourceGroup = strOrEmpty(v)));
  copyOpt(o, 'bookSourceComment', (v) => (s.bookSourceComment = strOrEmpty(v)));
  copyOpt(o, 'customOrder', (v) => (s.customOrder = numOrZero(v)));
  copyOpt(o, 'enabled', (v) => (s.enabled = !!v));
  copyOpt(o, 'enabledExplore', (v) => (s.enabledExplore = !!v));
  copyOpt(o, 'enabledCookieJar', (v) => (s.enabledCookieJar = !!v));
  copyOpt(o, 'eventListener', (v) => (s.eventListener = !!v));
  copyOpt(o, 'bookUrlPattern', (v) => (s.bookUrlPattern = strOrEmpty(v)));
  copyOpt(o, 'searchUrl', (v) => (s.searchUrl = strOrEmpty(v)));
  copyOpt(o, 'exploreUrl', (v) => (s.exploreUrl = strOrEmpty(v)));
  copyOpt(o, 'loginUrl', (v) => (s.loginUrl = strOrEmpty(v)));
  copyOpt(o, 'loginUi', (v) => (s.loginUi = strOrEmpty(v)));
  copyOpt(o, 'header', (v) => (s.header = strOrEmpty(v)));
  copyOpt(o, 'jsLib', (v) => (s.jsLib = strOrEmpty(v)));
  copyOpt(o, 'ruleSearch', (v) => (s.ruleSearch = asRules(v)));
  copyOpt(o, 'ruleExplore', (v) => (s.ruleExplore = asRules(v)));
  copyOpt(o, 'ruleBookInfo', (v) => (s.ruleBookInfo = asRules(v)));
  copyOpt(o, 'ruleToc', (v) => (s.ruleToc = asRules(v)));
  copyOpt(o, 'ruleContent', (v) => (s.ruleContent = asRules(v)));
  copyOpt(o, 'lastUpdateTime', (v) => (s.lastUpdateTime = numOrZero(v)));
  copyOpt(o, 'respondTime', (v) => (s.respondTime = numOrZero(v)));
  copyOpt(o, 'weight', (v) => (s.weight = numOrZero(v)));
  copyOpt(o, 'updateUrl', (v) => (s.updateUrl = strOrEmpty(v)));
  return s;
}

function strOrEmpty(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function numOrZero(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function copyOpt(o: Record<string, unknown>, key: string, apply: (v: unknown) => void): void {
  if (key in o && o[key] !== undefined && o[key] !== null) apply(o[key]);
}

function asRules(v: unknown): import('./legado-types').LegadoRules | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out: import('./legado-types').LegadoRules = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === 'string' && val) out[k] = val;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** legado sourceType → pomreader SourceType；未知 / 0 → 'novel' */
export function mapLegadoSourceType(t: number | undefined): import('../js-source/source-meta.types').SourceType {
  if (typeof t !== 'number') return 'novel';
  return LEGADO_SOURCE_TYPE_MAP[t] ?? 'novel';
}
