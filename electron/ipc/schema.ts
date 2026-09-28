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
