/**
 * IPC runtime schema 验证 + safeHandle 工厂（EVO-4 试点）
 *
 * 引入 valibot 为 IPC channel 入参提供 runtime schema 验证。
 * fetch-handler.ts 作为首个试点（最复杂、schema 收益最大）；
 * 其他 handler 暂保留原写法，后续按风险评估逐步铺开。
 *
 * 设计原则：
 * - 入参验证：safeHandle 入参在 handler 前 parse；失败抛 IpcValidationError
 * - 出参：handler 返回值原样转发；schema 仅入参验证（避免过度约束）
 * - 错误包络：handler 抛错统一包络为 Error 对象（含 cause）
 * - 性能：valibot tree-shakable；单 schema 编译产物 < 1KB；不影响 handler 性能
 *
 * 注：项目不升 Angular 19 / 不引 zod；valibot 95% 小于 zod（tree-shakable schema fragments）
 */
import { IpcMain, IpcMainInvokeEvent } from 'electron';
import * as v from 'valibot';

/** 通用包络错误（main → renderer 走 error.message） */
export class IpcValidationError extends Error {
  constructor(
    public readonly channel: string,
    public readonly issues: ReadonlyArray<v.GenericIssue>,
  ) {
    const detail = issues
      .map((i) => `${i.path?.map((p) => String(p.key)).join('.') ?? '?'}: ${i.message}`)
      .join('; ');
    super(`[${channel}] invalid args: ${detail}`);
    this.name = 'IpcValidationError';
  }
}

/**
 * 注册一个 ipc handler：自动验证入参，按 schema parse 后传给业务 handler。
 *
 * @param ipcMain - Electron IpcMain 实例
 * @param channel - IPC channel 名（如 'pom:fetch-html'）
 * @param schema - valibot schema（v.tuple(...) 或 v.object(...)，输入 args 直接 parse）
 * @param handler - 业务 handler；args 是 schema parse 后的对象/数组
 *
 * 入参形态：渲染进程 `ipcRenderer.invoke(channel, a, b, c)` → 主进程 handler 收到
 * `(event, a, b, c)` 三个独立参数（Electron spread）。我们这里通过 rest 收集
 * 为 array 后整体 parse —— 这样 v.tuple schema 才能正确识别位置参数。
 * （旧实现直接 `(event, args: unknown)` 只取第一个参数，触发"Expected Array"
 *  验证失败 —— 见 commit 747d808 后续 e2e 复现。）
 */
export function safeHandle<TInput, TOutput>(
  ipcMain: IpcMain,
  channel: string,
  schema: v.GenericSchema<unknown, TInput>,
  handler: (event: IpcMainInvokeEvent, input: TInput) => Promise<TOutput> | TOutput,
): void {
  ipcMain.handle(channel, async (event, ...rest: unknown[]) => {
    const args = rest;
    const parsed = v.safeParse(schema, args);
    if (!parsed.success) {
      throw new IpcValidationError(channel, parsed.issues);
    }
    return await handler(event, parsed.output as TInput);
  });
}

/** schema 元信息：当前已注册的 IPC channel 入参 schema（用于 debug） */
export const registeredSchemas = new Map<string, string>();

export function safeHandleWithMeta<TInput, TOutput>(
  ipcMain: IpcMain,
  channel: string,
  schemaName: string,
  schema: v.GenericSchema<unknown, TInput>,
  handler: (event: IpcMainInvokeEvent, input: TInput) => Promise<TOutput> | TOutput,
): void {
  registeredSchemas.set(channel, schemaName);
  safeHandle(ipcMain, channel, schema, handler);
}

/* ── fetch-handler.ts 试点 schemas ─────────────────────────────── */

/**
 * pom:fetch-html args tuple: (url: string, mode?: 'auto'|'utf-8'|'gbk')
 * 用 v.tuple 保持与原位置参数调用方 ipcRenderer.invoke('pom:fetch-html', url, mode) 兼容
 */
export const FetchHtmlArgsSchema = v.tuple([
  v.pipe(v.string(), v.minLength(1, 'url must be non-empty')),
  v.optional(v.picklist(['auto', 'utf-8', 'gbk']), 'auto'),
]);
export type FetchHtmlArgs = v.InferOutput<typeof FetchHtmlArgsSchema>;

/**
 * pom:get-fetch-ua args: void（不接受任何参数）
 *
 * ⚠️ schema 收到的是 **args 数组**（safeHandle 用 ...rest 收集），零参调用即 `[]`，
 * 不是 null/undefined。早期写成 `v.nullish(v.null(), null)` 会让每次调用都抛
 * IpcValidationError（"Expected null but received Array"）。
 * 用 strictTuple（而非 tuple）表达"恰好零参"：valibot 的空 tuple 不校验长度，
 * 多带参数照样放行；strictTuple 才会把多余参数拒掉。
 */
export const GetFetchUaArgsSchema = v.strictTuple([]);
export type GetFetchUaArgs = v.InferOutput<typeof GetFetchUaArgsSchema>;

/** pom:set-fetch-ua args tuple: (ua: string | null) */
export const SetFetchUaArgsSchema = v.tuple([v.nullish(v.string(), null)]);
export type SetFetchUaArgs = v.InferOutput<typeof SetFetchUaArgsSchema>;

/** pom:set-webview-encoding args tuple: (webviewId: string, mode: EncodingMode) */
export const SetWebviewEncodingArgsSchema = v.tuple([
  v.pipe(
    v.string(),
    v.minLength(1, 'webviewId must be non-empty'),
    // security: defense-in-depth — Electron partition name sanitizes internally,
    // but regex prevents typos/edge cases from reaching session.fromPartition
    v.regex(/^[a-zA-Z0-9_-]+$/, 'webviewId must be alphanumeric, dash, or underscore'),
  ),
  v.picklist(['auto', 'utf-8', 'gbk']),
]);
export type SetWebviewEncodingArgs = v.InferOutput<typeof SetWebviewEncodingArgsSchema>;

/* ── booksource-handler.ts JSON 书源 schemas（方案 §3.4，P2） ────────────── */

/**
 * doc 最小结构探针：只钉 format/schemaVersion 标记，其余字段 loose 放行。
 * 完整 valibot 校验在渲染端 `core/models/book-source-doc.model.ts` 的
 * BookSourceDocSchema（electron tsconfig exclude ../src，跨边界不可达）；
 * 主进程侧的必填存在性检查由 booksource-meta.ts 的
 * validateBookSourceDocStructure 承担（R5 先松后紧）。
 */
export const BookSourceDocProbeSchema = v.looseObject({
  format: v.literal('pomreader.booksource'),
  schemaVersion: v.literal(1),
});
export type BookSourceDocProbe = v.InferOutput<typeof BookSourceDocProbeSchema>;

/** .json 书源文件名（后缀约束在 IPC 边界再钉一层；handler 内还有 safeJsonFileName） */
const JsonFileNameSchema = v.pipe(
  v.string(),
  v.minLength(1, 'fileName must be non-empty'),
  v.regex(/\.json$/i, 'fileName must end with .json'),
);

/** .js 书源文件名（legacy 转换尝试；handler 内还有 safeFileName） */
const JsFileNameSchema = v.pipe(
  v.string(),
  v.minLength(1, 'fileName must be non-empty'),
  v.regex(/\.js$/i, 'fileName must end with .js'),
);

/** sourceDir 可选；preload 侧传 `sourceDir ?? null`，故用 nullish 对齐现有风格 */
const OptionalSourceDirSchema = v.nullish(v.string(), null);

/** pom:booksource-list-json args: void（strictTuple 拒多余参数，见 GetFetchUaArgsSchema 注释） */
export const BooksourceListJsonArgsSchema = v.strictTuple([]);
export type BooksourceListJsonArgs = v.InferOutput<typeof BooksourceListJsonArgsSchema>;

/** pom:booksource-list-json-streaming args tuple: (requestId: string) */
export const BooksourceListJsonStreamingArgsSchema = v.tuple([
  v.pipe(v.string(), v.minLength(1, 'requestId must be non-empty')),
]);
export type BooksourceListJsonStreamingArgs = v.InferOutput<
  typeof BooksourceListJsonStreamingArgsSchema
>;

/** pom:booksource-save-json args tuple: (fileName, doc, sourceDir?) */
export const BooksourceSaveJsonArgsSchema = v.tuple([
  JsonFileNameSchema,
  BookSourceDocProbeSchema,
  OptionalSourceDirSchema,
]);
export type BooksourceSaveJsonArgs = v.InferOutput<typeof BooksourceSaveJsonArgsSchema>;

/** pom:booksource-toggle-json args tuple: (fileName, enabled, sourceDir?) */
export const BooksourceToggleJsonArgsSchema = v.tuple([
  JsonFileNameSchema,
  v.boolean(),
  OptionalSourceDirSchema,
]);
export type BooksourceToggleJsonArgs = v.InferOutput<typeof BooksourceToggleJsonArgsSchema>;

/** pom:booksource-delete-json args tuple: (fileName, sourceDir?) */
export const BooksourceDeleteJsonArgsSchema = v.tuple([
  JsonFileNameSchema,
  OptionalSourceDirSchema,
]);
export type BooksourceDeleteJsonArgs = v.InferOutput<typeof BooksourceDeleteJsonArgsSchema>;

/* ── booksource-bundle-handler.ts（书源导入/导出 bundle，设计 §5，Phase 1） ── */

/** pom:booksource-bundle-export args tuple: (fileNames: string[]) */
export const BooksourceBundleExportArgsSchema = v.tuple([v.array(JsonFileNameSchema)]);
export type BooksourceBundleExportArgs = v.InferOutput<typeof BooksourceBundleExportArgsSchema>;

/** pom:booksource-bundle-open args: void（strictTuple 拒多余参数，见 GetFetchUaArgsSchema 注释） */
export const BooksourceBundleOpenArgsSchema = v.strictTuple([]);
export type BooksourceBundleOpenArgs = v.InferOutput<typeof BooksourceBundleOpenArgsSchema>;

/**
 * pom:booksource-bundle-apply args tuple: (decisions: {fileName, content}[])
 * content 的 JSON 结构校验在 handler 写前全量预校验做（§8 取舍 1），schema 只钉形状
 */
export const BooksourceBundleApplyArgsSchema = v.tuple([
  v.array(v.looseObject({ fileName: JsonFileNameSchema, content: v.string() })),
]);
export type BooksourceBundleApplyArgs = v.InferOutput<typeof BooksourceBundleApplyArgsSchema>;

/* ── booksource-subscription.ts（书源订阅自动更新，设计 §6，Phase 2） ── */

/** pom:booksource-sub-list args: void（strictTuple 拒多余参数，见 GetFetchUaArgsSchema 注释） */
export const BooksourceSubListArgsSchema = v.strictTuple([]);
export type BooksourceSubListArgs = v.InferOutput<typeof BooksourceSubListArgsSchema>;

/**
 * pom:booksource-sub-save args tuple: (item: SubscriptionItem)
 * id 缺省/空串 = 新增（主进程生成随机 id）；url 仅钉非空，协议与 SSRF 校验在
 * safeNetRequest 拉取时做（与设计 §7 订阅 URL 边界一致）
 */
export const BooksourceSubSaveArgsSchema = v.tuple([
  v.looseObject({
    id: v.optional(v.string()),
    name: v.pipe(v.string(), v.minLength(1, 'name must be non-empty')),
    url: v.pipe(v.string(), v.minLength(1, 'url must be non-empty')),
    enabled: v.boolean(),
    intervalHours: v.pipe(v.number(), v.minValue(1, 'intervalHours must be >= 1')),
    lastCheckedAt: v.nullish(v.number()),
    lastError: v.nullish(v.string()),
  }),
]);
export type BooksourceSubSaveArgs = v.InferOutput<typeof BooksourceSubSaveArgsSchema>;

/** pom:booksource-sub-delete args tuple: (id: string) */
export const BooksourceSubDeleteArgsSchema = v.tuple([
  v.pipe(v.string(), v.minLength(1, 'id must be non-empty')),
]);
export type BooksourceSubDeleteArgs = v.InferOutput<typeof BooksourceSubDeleteArgsSchema>;

/** pom:booksource-sub-check args tuple: (id: string) */
export const BooksourceSubCheckArgsSchema = v.tuple([
  v.pipe(v.string(), v.minLength(1, 'id must be non-empty')),
]);
export type BooksourceSubCheckArgs = v.InferOutput<typeof BooksourceSubCheckArgsSchema>;

/** pom:booksource-legacy-convert-try args tuple: (fileName.js)（strictTuple 拒多余参数） */
export const BooksourceLegacyConvertTryArgsSchema = v.strictTuple([JsFileNameSchema]);
export type BooksourceLegacyConvertTryArgs = v.InferOutput<
  typeof BooksourceLegacyConvertTryArgsSchema
>;
