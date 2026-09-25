/**
 * 书源 JS 头部注释解析器（实施计划 T-001）
 *
 * 扫描前 100 行 `// @key value` 元数据，生成 `BookSourceMeta`。
 * 纯函数无 IO；enabled 优先级：marker 文件（IPC handler 处理，本参数传入）> 头部 @enabled > 默认 true。
 *
 * 决策（DM-T-001）：多值字段 description → \n / url → 首条主 + urls[] / tags → 中英逗号 + 去重保序 / require → urls[]；
 * 标量字段首次出现生效；uuid 缺省 → 回退 fileName；name 缺省 → fileName 去 .js；
 * @type 非法 → 降级 'novel'；@enabled 非 false/0/no → true；@minDelayMs 与 @minDelay 等价。
 */
import { BookSourceMeta, SOURCE_TYPES, SourceType } from './source-meta.types';

const HEADER_SCAN_LINES = 100;
const DEFAULT_TYPE: SourceType = 'novel';
const TAG_SEPARATORS = /[,，]/;

/** 抽 key/value：`// @key value...`，兼容前导空白与多个 `/`；非 header 行返回 null */
function parseKvLine(line: string): { key: string; value: string } | null {
  const trimmed = line.trimStart();
  if (!trimmed.startsWith('//')) return null;
  const body = trimmed.replace(/^\/+/, '').trimStart();
  if (!body.startsWith('@')) return null;
  const rest = body.slice(1);
  const sepIdx = rest.search(/\s/);
  if (sepIdx === -1) return { key: rest.trim(), value: '' };
  const key = rest.slice(0, sepIdx).trim();
  if (!key) return null;
  return { key, value: rest.slice(sepIdx + 1).trim() };
}

/** @type 枚举校验；非法 → 默认 novel */
function normalizeSourceType(raw: string): SourceType {
  return (SOURCE_TYPES as readonly string[]).includes(raw.trim()) ? (raw.trim() as SourceType) : DEFAULT_TYPE;
}

/** @enabled 解析：false/0/no → false，其他非空 → true，空 → 未声明 */
function parseEnabled(raw: string): boolean | null {
  if (raw === '') return null;
  const v = raw.trim().toLowerCase();
  return v === 'false' || v === '0' || v === 'no' ? false : true;
}

/** tag 拆：中英逗号 + 去重 + 去空 + 保序 */
function splitTags(raw: string): string[] {
  const out: string[] = [];
  for (const t of raw.split(TAG_SEPARATORS)) {
    const v = t.trim();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * 解析书源 JS 头部，生成元数据。
 * @param enabledOverride marker 文件触发的启停（null/undefined → 走头部或默认）
 */
export function parseHeaderMeta(
  content: string,
  fileName: string,
  sourceDir: string,
  fileSize: number,
  modifiedAt: number,
  enabledOverride?: boolean | null,
): BookSourceMeta {
  let name: string | undefined;
  let author: string | undefined;
  let logo: string | undefined;
  const descriptions: string[] = [];
  const urls: string[] = [];
  const tags: string[] = [];
  let version: string | undefined;
  let updateUrl: string | undefined;
  let uuid: string | undefined;
  let sourceType: SourceType | undefined;
  let headerEnabled: boolean | undefined;
  let minDelayMs = 0;
  const requireUrls: string[] = [];

  const lines = content.split(/\r?\n/);
  const scanEnd = Math.min(lines.length, HEADER_SCAN_LINES);
  for (let i = 0; i < scanEnd; i++) {
    const kv = parseKvLine(lines[i]);
    if (!kv) continue;
    const { key, value } = kv;
    // 空值不入（enabled 例外，允许无值）
    if (value === '' && key !== 'enabled') continue;
    switch (key) {
      case 'name':       if (name === undefined && value) name = value; break;
      case 'author':     if (author === undefined && value) author = value; break;
      case 'logo':       if (logo === undefined && value) logo = value; break;
      case 'description': descriptions.push(value); break;
      case 'url':        if (value) urls.push(value); break;
      case 'tags':       for (const t of splitTags(value)) if (!tags.includes(t)) tags.push(t); break;
      case 'version':    if (version === undefined && value) version = value; break;
      case 'updateUrl':  if (updateUrl === undefined && value) updateUrl = value; break;
      case 'uuid':       if (uuid === undefined && value) uuid = value; break;
      case 'type':       if (sourceType === undefined) sourceType = normalizeSourceType(value); break;
      case 'enabled': {
        const parsed = parseEnabled(value);
        if (headerEnabled === undefined && parsed !== null) headerEnabled = parsed;
        break;
      }
      case 'minDelayMs':
      case 'minDelay': {
        if (!value) break;
        const n = Number.parseInt(value, 10);
        if (Number.isFinite(n) && n >= 0) minDelayMs = n;
        break;
      }
      case 'require':    if (value) requireUrls.push(value); break;
      // 忽略未知 @key（向后兼容 legado 扩展字段）
    }
  }

  const finalUuid = uuid ?? fileName;
  return {
    sourceKey: finalUuid,
    uuid: finalUuid,
    fileName,
    name: name ?? fileName.replace(/\.js$/i, ''),
    url: urls[0] ?? '',
    urls,
    author,
    logo,
    description: descriptions.length ? descriptions.join('\n') : undefined,
    enabled: enabledOverride ?? headerEnabled ?? true,
    fileSize,
    modifiedAt,
    sourceDir,
    sourceType: sourceType ?? DEFAULT_TYPE,
    version: version ?? '',
    updateUrl,
    tags,
    minDelayMs,
    requireUrls,
  };
}