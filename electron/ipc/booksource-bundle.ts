/**
 * 书源导入/导出 bundle 序列化内核（纯函数，无 Electron 依赖，可被 vitest 直接单测）
 *
 * 设计契约：docs/Architecture/2026-09-28-BOOKSOURCE_IMPORT_EXPORT_DESIGN.md §4/§5.3
 * （设计文档路径写 electron/shared/，落地改放 electron/ipc/ 与 booksource-meta.ts 同目录）
 *
 * - bundle 格式 §4.1：format 常量 + version 1 + exportedAt + app + sources[].{uuid,fileName,content}
 * - 上限：单条 content ≤ 2MB，整包 ≤ 20MB（§4.3，防手滑拖入巨型 JSON 撑爆渲染进程）
 * - uuid 口径：doc.uuid，缺省回退**带扩展名**文件名（`foo.json`，与 booksource-meta.ts 同款硬约束）
 * - diff 分类 §5.3：new / identical / update / conflict；匹配键 uuid 优先、fileName 兜底
 * - content 校验用主进程侧最小结构探针 validateBookSourceDocStructure
 *   （完整 valibot 校验在渲染端 BookSourceDocSchema；rootDir 限制不可 import src/，TS6059）
 */
import { createHash } from 'node:crypto';
import { safeJsonFileName, validateBookSourceDocStructure } from './booksource-meta';

export const BUNDLE_FORMAT = 'pomreader.booksource.bundle';
export const BUNDLE_VERSION = 1;
/** 单条 content 上限 2MB（§4.3） */
export const CONTENT_MAX_BYTES = 2 * 1024 * 1024;
/** 整包上限 20MB（§4.3） */
export const BUNDLE_MAX_BYTES = 20 * 1024 * 1024;

export interface BundleSourceInput {
  fileName: string;
  content: string;
}

export interface BundleSourceEntry {
  uuid: string;
  fileName: string;
  content: string;
}

export interface BookSourceBundle {
  format: typeof BUNDLE_FORMAT;
  version: typeof BUNDLE_VERSION;
  exportedAt: number;
  app: string;
  sources: BundleSourceEntry[];
}

export type DiffKind = 'new' | 'identical' | 'update' | 'conflict';

export interface DiffEntry {
  kind: DiffKind;
  /** incoming 源 uuid（doc.uuid ?? fileName） */
  uuid: string;
  /** incoming fileName（apply 落盘默认目标） */
  fileName: string;
  /** 本地匹配到的 fileName（new 时为 null；uuid 优先匹配命中改名源时与 fileName 不同） */
  matchedFileName: string | null;
  /** incoming content 原文（渲染端预览 + valibot 全量校验用） */
  content: string;
}

/** content（BookSourceDoc JSON 全文）的 sha256，订阅 applied 基线口径（§6.2） */
export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

/**
 * 单条 source 条目校验：fileName（safeJsonFileName）+ content 大小 + JSON 可解析 +
 * BookSourceDoc 最小结构。返回权威 uuid（doc.uuid ?? fileName）；非法即抛错。
 * parseBundle / buildBundle / apply 预校验共用同一口径。
 */
export function inspectBundleSource(fileName: string, content: string): { uuid: string } {
  const safe = safeJsonFileName(fileName);
  if (!safe) throw new Error(`非法 fileName: ${fileName}`);
  if (typeof content !== 'string') throw new Error(`content 须为字符串（${safe}）`);
  if (Buffer.byteLength(content, 'utf-8') > CONTENT_MAX_BYTES) {
    throw new Error(`content 超过 2MB 上限（${safe}）`);
  }
  let doc: unknown;
  try {
    doc = JSON.parse(content);
  } catch (err) {
    throw new Error(`content JSON 解析失败（${safe}）: ${(err as Error).message}`);
  }
  if (typeof doc !== 'object' || doc === null) {
    throw new Error(`content 不是 JSON 对象（${safe}）`);
  }
  const d = doc as Record<string, unknown>;
  // uuid/name 缺省先套回退再校验，与 scanJsonDir 同款（缺省不算 invalid）
  const uuid = typeof d.uuid === 'string' && d.uuid ? d.uuid : safe;
  const name = typeof d.name === 'string' && d.name ? d.name : safe.replace(/\.json$/i, '');
  const reason = validateBookSourceDocStructure({ ...d, uuid, name });
  if (reason) throw new Error(`content 结构非法（${safe}）: ${reason}`);
  return { uuid };
}

/**
 * 解析 + 校验 bundle 文本（§4.3）。未知 format、缺字段、单条 content 校验失败、
 * 超限一律抛错**整体拒绝**，不做部分导入。
 */
export function parseBundle(text: string): BookSourceBundle {
  if (Buffer.byteLength(text, 'utf-8') > BUNDLE_MAX_BYTES) {
    throw new Error('bundle 超过 20MB 上限');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`bundle JSON 解析失败: ${(err as Error).message}`);
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('bundle 不是 JSON 对象');
  }
  const b = raw as Record<string, unknown>;
  if (b.format !== BUNDLE_FORMAT) {
    throw new Error(`未知 format: ${String(b.format)}（期望 ${BUNDLE_FORMAT}）`);
  }
  if (b.version !== BUNDLE_VERSION) {
    throw new Error(`不支持的 version: ${String(b.version)}（期望 ${BUNDLE_VERSION}）`);
  }
  if (typeof b.exportedAt !== 'number' || !Number.isFinite(b.exportedAt)) {
    throw new Error('缺少 exportedAt（number ms）');
  }
  if (typeof b.app !== 'string') {
    throw new Error('缺少 app（string）');
  }
  if (!Array.isArray(b.sources)) {
    throw new Error('sources 须为数组');
  }
  const sources: BundleSourceEntry[] = [];
  for (let i = 0; i < b.sources.length; i += 1) {
    const s = b.sources[i] as unknown;
    if (typeof s !== 'object' || s === null) {
      throw new Error(`sources[${i}] 不是对象`);
    }
    const e = s as Record<string, unknown>;
    if (typeof e.fileName !== 'string' || typeof e.content !== 'string') {
      throw new Error(`sources[${i}] 缺 fileName/content`);
    }
    const { uuid } = inspectBundleSource(e.fileName, e.content);
    sources.push({ uuid, fileName: e.fileName, content: e.content });
  }
  return {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    exportedAt: b.exportedAt,
    app: b.app,
    sources,
  };
}

/** 组装 bundle（§4.3）；items 逐条过 inspectBundleSource，非法即抛错 */
export function buildBundle(
  items: BundleSourceInput[],
  options: { app?: string; exportedAt?: number } = {},
): BookSourceBundle {
  const sources = items.map(({ fileName, content }) => {
    const { uuid } = inspectBundleSource(fileName, content);
    return { uuid, fileName, content };
  });
  return {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    exportedAt: options.exportedAt ?? Date.now(),
    app: options.app ?? '',
    sources,
  };
}

/** 序列化为落盘文本（pretty print，与书源文件 JSON.stringify(doc, null, 2) 同款风格） */
export function serializeBundle(bundle: BookSourceBundle): string {
  return JSON.stringify(bundle, null, 2);
}

/**
 * diff 分类（§5.3）：匹配键 uuid 优先、fileName 兜底。
 *
 * - new：无本地匹配项
 * - identical：content 逐字节相同
 * - update：同源、content 不同、无基线或本地 content hash == applied[uuid]
 * - conflict：同源、content 不同、带 baseline 且**本地** content hash ≠ applied[uuid]
 *   （本地自上次订阅写入后被用户改过 → 不写盘，交用户；仅订阅场景传入 baseline，
 *   本地导入不传，不会产出 conflict）
 */
export function diffBundle(
  incoming: BundleSourceEntry[],
  local: BundleSourceEntry[],
  baseline?: Record<string, string>,
): DiffEntry[] {
  const byUuid = new Map<string, BundleSourceEntry>();
  const byFileName = new Map<string, BundleSourceEntry>();
  for (const l of local) {
    if (!byUuid.has(l.uuid)) byUuid.set(l.uuid, l);
    if (!byFileName.has(l.fileName)) byFileName.set(l.fileName, l);
  }
  return incoming.map((inc) => {
    const match = byUuid.get(inc.uuid) ?? byFileName.get(inc.fileName) ?? null;
    const base = {
      uuid: inc.uuid,
      fileName: inc.fileName,
      matchedFileName: match?.fileName ?? null,
      content: inc.content,
    };
    if (!match) return { kind: 'new', ...base };
    if (match.content === inc.content) return { kind: 'identical', ...base };
    const applied = baseline?.[inc.uuid];
    // 基线比较的是**本地** content hash（§6.2）：本地自上次订阅写入后未被改 →
    // update（可安全自动写入）；本地被用户改过 → conflict（不写盘，交用户）。
    // baseline 中无此 uuid → 无基线，按 update 处理（§6.2 第 4 条）。
    if (applied !== undefined && sha256(match.content) !== applied) {
      return { kind: 'conflict', ...base };
    }
    return { kind: 'update', ...base };
  });
}
