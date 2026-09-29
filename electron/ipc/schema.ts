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

/* ── booksource-handler.ts schemas（书源 JSON 规则化 P2.4） ───────────── */

/**
 * 书源文件名：与 `booksource-meta.safeFileName` **同口径**（防路径穿越）
 *
 * 这层 schema 是**早失败**：渲染端传错名字时在这里就报出 channel + 字段，
 * 而不是等 handler 里 `throw new Error('非法 fileName')` 丢上下文。
 *
 * 口径必须与运行时 `safeFileName` 逐条对齐（外部评审 R1 抓到过漂移：初版 schema 只挡
 * `..` 前缀、漏了 `..` 中缀与控制字符，而运行时是 `includes('..')` + 控制字符全挡）。
 * 后果不是当下的漏洞（handler 仍调 `safeFileName`，两层都在），而是 P3.2 接线后有人
 * 看到"schema 已经拦了"就把运行时那层删掉，于是两处都松。**`safeFileName` 始终是最终裁决者。**
 */
const safeName = (label: string) =>
  v.pipe(
    v.string(),
    v.minLength(1, `${label} must be non-empty`),
    v.regex(/^[^/\\]*$/, `${label} must not contain path separators`),
    v.regex(/^(?!.*\.\.)/, `${label} must not contain ..`),
    // 本条规则**就是**「禁控制字符」：必须显式写出控制符区间才是它要拦的东西
    //（控制符会破坏日志 / 终端 / 文件名），故 no-control-regex 在此处属误报
    // eslint-disable-next-line no-control-regex
    v.regex(/^[^\u0000-\u001F\u007F]*$/, `${label} must not contain control characters`),
    v.check((s) => s !== '.', `${label} must not be a bare dot`),
  );

/** sourceDir：可选，必须是绝对路径（与 `resolveDir` 契约一致） */
const sourceDirArg = v.optional(
  v.nullish(
    v.pipe(v.string(), v.regex(/^([A-Za-z]:[\\/]|\/)/, 'sourceDir must be an absolute path')),
    null,
  ),
);

/** pom:booksource-read args: (fileName, sourceDir?) */
export const BooksourceReadArgsSchema = v.tuple([safeName('fileName'), sourceDirArg]);
export type BooksourceReadArgs = v.InferOutput<typeof BooksourceReadArgsSchema>;

/** pom:booksource-save args: (fileName, content, sourceDir?) */
export const BooksourceSaveArgsSchema = v.tuple([safeName('fileName'), v.string(), sourceDirArg]);
export type BooksourceSaveArgs = v.InferOutput<typeof BooksourceSaveArgsSchema>;

/** pom:booksource-delete args: (fileName, sourceDir?) */
export const BooksourceDeleteArgsSchema = v.tuple([safeName('fileName'), sourceDirArg]);
export type BooksourceDeleteArgs = v.InferOutput<typeof BooksourceDeleteArgsSchema>;

/** pom:booksource-toggle args: (fileName, enabled, sourceDir?) */
export const BooksourceToggleArgsSchema = v.tuple([
  safeName('fileName'),
  v.boolean(),
  sourceDirArg,
]);
export type BooksourceToggleArgs = v.InferOutput<typeof BooksourceToggleArgsSchema>;

/**
 * pom:booksource-convert args: (jsFileName, json, sourceDir?)
 *
 * `.js` 后缀是 handler 的硬约束（`convert` 只接受旧 JS 源），在 schema 这层就拦住，
 * 少一次主进程往返就能给出可定位的错误。
 */
export const BooksourceConvertArgsSchema = v.tuple([
  v.pipe(safeName('jsFileName'), v.regex(/\.js$/i, 'jsFileName must end with .js')),
  // 内容本身由 handler 解析 + 校验 format（结构化数据交给结构化校验，不在 schema 复述规则）
  v.string(),
  sourceDirArg,
]);
export type BooksourceConvertArgs = v.InferOutput<typeof BooksourceConvertArgsSchema>;

/**
 * pom:booksource-archive args: (jsFileName, reason, sourceDir?)
 *
 * needs-manual 源的归档通道（只搬 `.js` + marker，不产 JSON）。
 * `reason` 只作留痕用（列表页 tooltip 展示），故意不参与任何路径计算 ——
 * 原因文案可能含用户站点名，拿它拼路径是自找的路径穿越面。
 */
export const BooksourceArchiveArgsSchema = v.tuple([
  v.pipe(safeName('jsFileName'), v.regex(/\.js$/i, 'jsFileName must end with .js')),
  v.string(),
  sourceDirArg,
]);
export type BooksourceArchiveArgs = v.InferOutput<typeof BooksourceArchiveArgsSchema>;

/** pom:booksource-migration-report-write args: (report) —— 零参读取用 strictTuple([]) */
export const MigrationReportWriteArgsSchema = v.tuple([v.unknown()]);
export type MigrationReportWriteArgs = v.InferOutput<typeof MigrationReportWriteArgsSchema>;

export const MigrationReportReadArgsSchema = v.strictTuple([]);
export const BooksourceLegacyListArgsSchema = v.strictTuple([]);
