/**
 * 书源文档构造器 —— `SourceRules` + meta → `BookSourceDoc`（书源 JSON 规则化 P2.3）
 *
 * `generateSourceCode` 的**继任者**：以前新建源是"生成一段 JS 模板字符串"，现在直接
 * 产出 JSON 文档。两者输入相同（`buildRules` 探测出的规则集），输出换了一种载体。
 *
 * ## ⚠️ 关键约束：这里**不**调用 `resolveRuleDefaults`
 *
 * 缺省回填必须留在**装载时**（`createRuleEngine` / `RuleEngineService.readDoc`），理由：
 * `searchContentType` 的缺省依赖 `searchMethod`（POST_RAW → json，其余 → form）。
 * 若在构造时把缺省**物化**进文件，用户事后把 `searchMethod` 从 GET 改成 POST_RAW、
 * 忘了同步改 `searchContentType`，就会带着一个陈旧的 form-urlencoded 跑 —— 而且
 * 一切看起来都"有值"，没有任何报错。只有"文件里没写 = 用当时的缺省"才不会踩这个坑。
 * 其余字段（`bookCategoryPattern` 等）同理：显式缺席与显式空串是两种意思，不能在写盘时抹平。
 *
 * ## 为什么 `serializeSourceDoc` 的格式必须与主进程一致
 *
 * `electron/ipc/booksource-handler.ts` 的 `convert` / `toggle` 也用
 * `JSON.stringify(doc, null, 2) + '\n'` 落盘。两边**不能共享代码**（主进程无法 import
 * `src/`，见方案 D4/D8），所以格式一致性只能靠"两侧各写一条断言同一格式的测试"来保证 ——
 * 改一处格式时，另一侧的测试会立刻红。
 */
import {
  BOOK_SOURCE_FORMAT,
  BOOK_SOURCE_SCHEMA_VERSION,
  type BookSourceDocDraft,
  type SourceType,
} from '../models/book-source-doc.model';
import { impliedSearchContentType, type SourceRules } from '../book-source/smart-add/smart-rules';

export interface BuildSourceDocInput {
  /**
   * 书源唯一 id。
   *
   * 必填且**由调用方决定**，因为命名空间连续性不是这里能算出来的：
   * ① 存量 `.js` 无 `@uuid` 时 uuid 就是**带扩展名的文件名**（`booksource-meta.ts:142`），
   *    所以"新建一个没有 uuid 的源"必须传 `fileName`，才能与迁移后的行为对上；
   * ② legado 导入已有自己的 uuid 派生规则（`legado-translator.deriveUuid`），
   *    改了它会让用户书架里 `Book.bookSourceUuid` 的指向全部落空。
   */
  uuid: string;
  name: string;
  /** 主站 origin */
  homepage: string;
  /** 多镜像；缺省 `[homepage]`（单站源不必显式写 urls） */
  urls?: string[];
  rules: SourceRules;
  headers?: Record<string, string>;
  enabled?: boolean;
  sourceType?: SourceType;
  author?: string;
  description?: string;
  tags?: string[];
  sourceVersion?: string;
  updateUrl?: string;
  minDelayMs?: number;
  requireUrls?: string[];
  /** 无法自动转换的源内嵌原始 legado JSON（骨架源专用） */
  legadoRaw?: string;
}

/**
 * 构造 `BookSourceDoc`（不落盘、不补缺省 —— 见文件头约束）
 *
 * `undefined` 值一律剔除：valibot 的 `v.optional(x, default)` 与"键存在但为 undefined"
 * 行为不同，宁可让键缺席走缺省，也不要写一个 `undefined` 进 JSON。
 */
export function buildSourceDoc(input: BuildSourceDocInput): BookSourceDocDraft {
  const urls = input.urls && input.urls.length > 0 ? input.urls.filter(Boolean) : [input.homepage];
  return {
    format: BOOK_SOURCE_FORMAT,
    schemaVersion: BOOK_SOURCE_SCHEMA_VERSION,
    uuid: input.uuid,
    name: input.name,
    homepage: input.homepage,
    urls,
    // enabled / sourceType **必写**（不走 omitUndefined）：它们在 schema 里是必填而非
    // "有缺省的可选"，省略会让文档校验直接失败。tags / headers 之类才是"可省略"。
    enabled: input.enabled !== false,
    sourceType: input.sourceType ?? 'novel',
    rules: dropRedundantContentType(input.rules),
    ...omitUndefined({
      author: input.author,
      description: input.description,
      tags: input.tags && input.tags.length > 0 ? input.tags : undefined,
      sourceVersion: input.sourceVersion,
      updateUrl: input.updateUrl,
      minDelayMs: input.minDelayMs && input.minDelayMs > 0 ? input.minDelayMs : undefined,
      requireUrls:
        input.requireUrls && input.requireUrls.length > 0 ? input.requireUrls : undefined,
      headers: input.headers && Object.keys(input.headers).length > 0 ? input.headers : undefined,
      legadoRaw: input.legadoRaw,
    }),
  };
}

/**
 * 剔除**恰好等于推导缺省**的 `searchContentType`
 *
 * 探测器（`buildRules`）会显式写 `searchContentType: 'application/x-www-form-urlencoded'`。
 * 写进文件的那一刻它是对的，可一旦用户事后把 `searchMethod` 改成 `POST_RAW` 却没同步改它，
 * 引擎的 `??` 链会拿这个**陈旧值**当答案 → 明明该发 JSON 却发成 form。
 * 而留着它又不增加任何信息：装载时 `resolveRuleDefaults` 推出来的就是同一个值。
 *
 * 判定用「与当前 method 的推导缺省相等」，所以：
 * ① 用户特意指定的非缺省值（GET + `text/plain`）照写；
 * ② 恰好等于缺省的值一律不写 —— 行为完全相同，只是把后门拆了。
 */
function dropRedundantContentType(rules: SourceRules): BookSourceDocDraft['rules'] {
  const ct = rules.searchContentType;
  if (ct === undefined || ct === impliedSearchContentType(rules.searchMethod)) {
    return omitUndefined({ ...rules, searchContentType: undefined });
  }
  return omitUndefined(rules);
}

/** 落盘文本：与主进程 `booksource-handler` 的 convert / toggle 逐字节同格式 */
export function serializeSourceDoc(doc: BookSourceDocDraft): string {
  return JSON.stringify(doc, null, 2) + '\n';
}

/**
 * 文件名：`<host 去点>` + `.json`
 *
 * 沿用智能添加既有的 `${host.replace(/\./g,'_')}.js` 形态，只换后缀 ——
 * 存量用户书架里按文件名建的分组/书签不会因为换后缀而看起来像换了个源。
 */
export function sourceDocFileName(url: string): string {
  const host = hostOf(url);
  // 顺带把非白名单字符换掉：IPv6 字面量（`[::1]`）的 hostname 含 `[` `:` `]`，
  // 直接用会生成一个**自己都过不了** `isValidSourceDocFileName` 的文件名，
  // 用户只看到"文件名需为…"却不知道为什么。输出恒合法是这里该保证的。
  const slug = host.replace(/\./g, '_').replace(/[^a-zA-Z0-9_-]/g, '_') || 'book_source';
  return `${slug}.json`;
}

/** 文件名合法性（与智能添加页的提示文案同口径） */
export function isValidSourceDocFileName(fileName: string): boolean {
  return /^[a-zA-Z0-9_\-一-龥]+\.json$/.test(fileName);
}

/** 取 host（去 `www.`）；非法 URL 返回空串而不是抛 —— 调用方自己决定怎么处理 */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * 剔除 undefined 值（保持插入顺序，其余键不动）
 *
 * 约束用 `object` 而非 `Record<string, unknown>`：接口（`SourceRules`）没有索引签名，
 * 传进来会因「Index signature is missing」而通不过后者。
 * 外部评审 R1 指出原先 `compact` 与 `stripUndefined` 是同一个函数（后者只多一个类型断言），
 * 已合并为一个，按调用点做类型断言。
 */
function omitUndefined<T extends object>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (v !== undefined) out[k] = v;
  }
  return out as T;
}
