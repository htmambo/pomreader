/**
 * BookSourceDoc — 书源 JSON 规则文档（书源 JSON 规则化改造 P1）
 *
 * 书源的唯一载体不再是 JS 文件，而是这份 JSON。meta（原先的 `// @key` 头）
 * 与 rules（原先的 19 个 JS 常量）合并为一份文档，rules 字段**直接复用**现有
 * `SourceRules`，字段名一字不改 —— 刻意的：转换层越薄越好，`rules-panel` 与
 * `buildRules` / `detect*` 可原样复用。
 *
 * 为什么不放 `electron/ipc/schema.ts`：渲染端 `rule-engine.service.ts` 要做运行时校验，
 * 而渲染端从不 import `electron/`（`tsconfig.app.json` 的 `types` 为空），跨边界不可达。
 * 故 schema 定义在此，`electron/ipc/` 只放 IPC 入参 schema。
 *
 * P3.4 迁出 `source-meta.types.ts` 时，`SourceType` / `SOURCE_TYPES` 以本文件为
 * 唯一出处，那边改为 re-export，禁止两处各定义一份。
 */
import * as v from 'valibot';
import { DEFAULT_PATTERNS } from '../book-source/smart-add/smart-rules';

/** 文件格式标记：导入导出 / 文件识别用 */
export const BOOK_SOURCE_FORMAT = 'pomreader.booksource';
/** schema 版本。v1 恒为 1；将来改结构时按原始值分支迁移（见 R6），故此处用 literal 而非 number */
export const BOOK_SOURCE_SCHEMA_VERSION = 1;

/** 5 种 sourceType（与既有 `source-meta.types.ts` 同值，见文件头 P3.4 说明） */
export const SOURCE_TYPES = ['novel', 'comic', 'video', 'music', 'webpage'] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

/** 搜索请求方式：GET 走 searchPath；POST 走 searchBodyParams；POST_RAW 走 searchRawBody */
export const SEARCH_METHODS = ['GET', 'POST', 'POST_RAW'] as const;
export type SearchMethod = (typeof SEARCH_METHODS)[number];

/** 单条表单参数（POST form-urlencoded） */
export const SearchBodyParamSchema = v.object({
  key: v.string(),
  value: v.string(),
});

/** 单条正文净化规则：rule 为正则（全局替换），replace 为替换内容（留空 = 删除匹配） */
export const ContentReplaceRuleSchema = v.object({
  rule: v.string(),
  replace: v.string(),
});

/**
 * SourceRules 的运行时 schema —— 必须与 `smart-rules.ts` 的 `SourceRules` 接口逐字段对齐。
 *
 * 必填 7 项：siteName / searchPath / searchItemPattern / bookTitlePattern /
 *           bookAuthorPattern / chapterItemPattern / contentPattern
 * 可选 9 项：其余；`searchMethod` 可选且**缺省 GET**（**不可设 required** —— 存量
 *           v1.1.0 模板产物连 `SEARCH_AUTHOR_RULE` / `SEARCH_CATEGORY_RULE` 都没有，
 *           设 required 会把合法存量源全部误杀）。
 *
 * ⚠️ `searchContentType` **刻意不给默认值**：`smart-rules.ts:483-485` 的缺省依赖
 * `searchMethod`（`POST_RAW` → `application/json`，其余 → form-urlencoded），
 * schema 无法表达这种条件缺省。强行给 form-urlencoded 会让 POST_RAW 源行为漂移 ——
 * 这正是编辑器反解析里的既有缺陷，迁移层不能继承。缺省回填由 `rule-parse.ts` 按方法推导。
 */
export const SourceRulesSchema = v.object({
  siteName: v.string(),
  searchPath: v.string(),
  searchMethod: v.optional(v.picklist(SEARCH_METHODS), 'GET'),
  searchBodyParams: v.optional(v.array(SearchBodyParamSchema), []),
  searchContentType: v.optional(v.string()),
  searchRawBody: v.optional(v.string(), ''),
  searchItemPattern: v.string(),
  searchAuthorPattern: v.optional(v.string(), ''),
  searchCategoryPattern: v.optional(v.string(), ''),
  bookTitlePattern: v.string(),
  bookAuthorPattern: v.string(),
  chapterItemPattern: v.string(),
  contentPattern: v.string(),
  contentReplaceRules: v.optional(v.array(ContentReplaceRuleSchema), []),
  // 这两项的模板缺省是 `DEFAULT_PATTERNS.*` 而不是空串（`smart-rules.ts:497/499`），
  // 缺省写 '' 会让「没填」与「显式留空」混淆：前者模板会回填默认选择器，后者才是"不提取"。
  bookCategoryPattern: v.optional(v.string(), DEFAULT_PATTERNS.bookCategoryPattern),
  coverUrlPattern: v.optional(v.string(), DEFAULT_PATTERNS.coverUrlPattern),
});

export type ParsedSourceRules = v.InferOutput<typeof SourceRulesSchema>;

/** 书源文档的运行时 schema */
export const BookSourceDocSchema = v.object({
  /** 固定标记 'pomreader.booksource' */
  format: v.literal(BOOK_SOURCE_FORMAT),
  /** schema 版本。**先按原始值分支再解析**（v.literal(1) 会让 v2 文档解析失败，这是有意的） */
  schemaVersion: v.literal(BOOK_SOURCE_SCHEMA_VERSION),
  /**
   * 书源唯一 id —— `Book.bookSourceUuid` 指向它。
   * 命名空间必须与现状同构：历史 `.js` 无 `@uuid` 时回退为**带扩展名的文件名**
   * （`electron/ipc/booksource-meta.ts:142` 的 `uuid || fileName`，**不剥** `.js`）。
   * 新建 JSON 源同样回退为带扩展名的文件名（`foo.json`），**不得剥扩展名** ——
   * 剥了会让同一逻辑源在迁移前后拿到两个 uuid，匹配不上且**不报错**（只是静默换源失败）。
   * ⚠️ 与之相反：`name` 的回退是**剥**扩展名（`:150` 的 `fileName.replace(/\.js$/i,'')`）。
   * 两者方向相反，不可互相佐证。
   */
  uuid: v.string(),
  name: v.string(),
  author: v.optional(v.string()),
  logo: v.optional(v.string()),
  description: v.optional(v.string()),
  /** 主站 origin（原 `BASE_URL` / 第一条 `@url`） */
  homepage: v.string(),
  /**
   * 多镜像（原多条 `@url`）。**v1 仅取 `[0]` 构造 hostPattern，不做 failover**，
   * 顺序原样保留仅为二期留位 —— 不要按"轮询优先级"实现，那等于偷偷引入 v1 未做的行为。
   */
  urls: v.array(v.string()),
  /** 启停状态（原先靠 `<name>.js.enabled` / `.disabled` marker 文件内联进文档） */
  enabled: v.boolean(),
  sourceType: v.picklist(SOURCE_TYPES),
  /** 书源自带版本号（原 `@version`）。命名避开 schemaVersion */
  sourceVersion: v.optional(v.string()),
  updateUrl: v.optional(v.string()),
  /**
   * ⚠️ valibot 里「缺省值」只能走 `v.optional(schema, default)`：
   * `v.array(schema, [])` 的第二参是**校验函数（pipe）**不是缺省值，会让该键变成必填。
   * 下面 tags / requireUrls / headers 三处曾因此报 `Invalid key: Expected "tags"`，已修正。
   */
  tags: v.optional(v.array(v.string()), []),
  /**
   * 镜像间限流（v1 仅镜像间生效，主抓取链路不强制；缺省 0）
   * ⚠️ 缺省值必须与注释一致：早期写成 `v.number()`（必填）而注释写着"默认 0"，
   * 不带该字段的文档会解析失败而不是取 0。
   */
  minDelayMs: v.optional(v.number(), 0),

  requireUrls: v.optional(v.array(v.string()), []),
  /** 自定义请求头（原先烘焙进生成代码的 `HEADERS` 常量） */
  headers: v.optional(v.record(v.string(), v.string()), {}),
  rules: SourceRulesSchema,
  /**
   * 无法自动转换的源内嵌的原始 legado JSON（骨架源专用）
   *
   * ⚠️ **可能含敏感信息**：`header` 字段里常带 Cookie / Authorization / token。
   * 这与旧版"骨架 JS 把原始 JSON 塞进注释"是同一份数据、同一份暴露面（不是新增风险），
   * 但将来若做导出 / 分享功能，必须先脱敏 —— 记在这里以免那一步被漏掉。
   */
  legadoRaw: v.optional(v.string()),
});

/**
 * 书源文档类型由 schema 反推，而非手写 interface ——
 * schema 与类型同源，避免校验规则与类型声明各改一处而漂移。
 * 与 `SourceRules` 的结构一致性由 `book-source-doc.model.spec.ts` 的编译期断言守门。
 */
export type BookSourceDoc = v.InferOutput<typeof BookSourceDocSchema>;

/**
 * 文档的**磁盘形态**（构造器产出 / 文件里真实存在的东西）
 *
 * 为什么与 `BookSourceDoc` 分成两个类型：`v.InferOutput` 把 `v.optional(x, default)`
 * 视作**必填**（缺省在解析时补上），而磁盘上这些键**允许不写**。两者都真实存在：
 * 写盘时省略缺省（见 `core/logic/source-doc-build.ts` 的理由），装载时才补。
 * 用 `InferOutput` 描述磁盘形态会强迫构造器把所有缺省物化进文件 ——
 * 那样用户事后改 `searchMethod` 就会带着陈旧的 `searchContentType` 跑。
 */
export type BookSourceDocDraft = v.InferInput<typeof BookSourceDocSchema>;
