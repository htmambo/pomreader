/**
 * BookSourceDoc 组装纯函数（方案 §3.1）：meta + rules → 可落盘的 JSON 书源文档
 *
 * 消费方：智能添加页 / legado 导入（P2），后续 P3 编辑器迁移同用。
 * 缺省口径：
 *  - uuid 缺省回退 fileName（**带扩展名**，`foo.json` —— §3.1 硬约束，不得剥扩展名，
 *    否则同一逻辑源迁移前后 uuid 不一致，Book.bookSourceUuid 静默换源失败）
 *  - name 缺省回退 rules.siteName
 *  - urls 缺省 [homepage]；显式传入时保证 homepage 在首位且不重复
 *  - 其余缺省：enabled=true / sourceType='novel' / tags=[] / minDelayMs=0 /
 *    requireUrls=[] / headers={}
 */
import { type BookSourceDoc } from '../models/book-source-doc.model';
import { type SourceRules } from '../book-source/smart-add/smart-rules';
import { type SourceType } from '../book-source/source-meta.types';

export interface BuildBookSourceDocInput {
  rules: SourceRules;
  /** 主站 origin（原 BASE_URL / @url 第一条） */
  homepage: string;
  /** 落盘文件名（含 .json 扩展名）；uuid 缺省时的回退值 */
  fileName?: string;
  /** 显式 uuid（legado 导入派生 / 迁移沿用 @uuid）；缺省 = fileName */
  uuid?: string;
  /** 缺省 = rules.siteName */
  name?: string;
  author?: string;
  description?: string;
  /** 多镜像；缺省 [homepage] */
  urls?: string[];
  enabled?: boolean;
  sourceType?: SourceType;
  sourceVersion?: string;
  updateUrl?: string;
  tags?: string[];
  minDelayMs?: number;
  requireUrls?: string[];
  headers?: Record<string, string>;
  legadoRaw?: string;
}

export function buildBookSourceDoc(input: BuildBookSourceDocInput): BookSourceDoc {
  const uuid = input.uuid ?? input.fileName;
  if (!uuid) {
    throw new Error('buildBookSourceDoc: uuid 与 fileName 至少提供一个（uuid 缺省回退 fileName）');
  }
  const homepage = input.homepage;
  const extraUrls = (input.urls ?? []).filter((u) => u && u !== homepage);
  return {
    format: 'pomreader.booksource',
    schemaVersion: 1,
    uuid,
    name: input.name ?? input.rules.siteName,
    ...(input.author !== undefined ? { author: input.author } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    homepage,
    urls: [homepage, ...extraUrls],
    enabled: input.enabled ?? true,
    sourceType: input.sourceType ?? 'novel',
    ...(input.sourceVersion !== undefined ? { sourceVersion: input.sourceVersion } : {}),
    ...(input.updateUrl !== undefined ? { updateUrl: input.updateUrl } : {}),
    tags: input.tags ?? [],
    minDelayMs: input.minDelayMs ?? 0,
    requireUrls: input.requireUrls ?? [],
    headers: input.headers ?? {},
    rules: input.rules,
    ...(input.legadoRaw !== undefined ? { legadoRaw: input.legadoRaw } : {}),
  };
}
