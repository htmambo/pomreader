/**
 * 书源导入 / 导出 bundle（Phase 1）渲染端契约类型
 *
 * 设计：docs/Architecture/2026-09-28-BOOKSOURCE_IMPORT_EXPORT_DESIGN.md §4 / §5
 * 通道挂点：window.pomAPI（与现有 booksource 段同一对象路径，见 electron/preload.ts）；
 * 三个方法的全局声明合并在 page-fetcher.service.ts 的 `declare global Window.pomAPI` 里
 * （TS interface 同名属性要求同型，无法跨文件二次声明 pomAPI 对象，故形状集中在此、
 * 挂点合并在彼）。形状与 electron/ipc/booksource-bundle.ts / booksource-bundle-handler.ts
 * 的实际返回保持一致。
 */

/** diffBundle 逐条分类（electron/ipc/booksource-bundle.ts DiffEntry 的渲染端镜像） */
interface BookSourceBundleDiffEntry {
  kind: 'new' | 'identical' | 'update' | 'conflict';
  /** incoming 源 uuid（doc.uuid ?? fileName） */
  uuid: string;
  /** incoming fileName（apply 落盘目标） */
  fileName: string;
  /** 本地匹配到的 fileName（new 时为 null；uuid 优先匹配命中改名源时与 fileName 不同） */
  matchedFileName: string | null;
  /** BookSourceDoc JSON 全文（导入时以此覆盖整个文件；渲染端预览需自行 valibot parse 取 meta） */
  content: string;
}

/**
 * pom:booksource-bundle-open 返回：
 * null = 用户取消选文件；否则 { error, entries } —— error 非 null 即 parseBundle
 * 整体拒绝原因（此时 entries 为空），渲染端展示原因并停留
 */
type BookSourceBundleOpenResult = {
  error: string | null;
  entries: BookSourceBundleDiffEntry[];
} | null;

/** pom:booksource-bundle-apply 返回（设计 §8 取舍 1：批量非原子，失败项收集报告） */
interface BookSourceBundleApplyResult {
  written: string[];
  failed: { fileName: string; error: string }[];
}

/** 三条 bundle IPC 在 window.pomAPI 上的挂点形状（pom:booksource-bundle-export / open / apply） */
interface PomBookSourceBundleApi {
  /** 导出：主进程读 content → buildBundle → showSaveDialog → atomicWrite；null = 用户取消保存对话框 */
  booksourceBundleExport?: (fileNames: string[]) => Promise<{ path: string; count: number } | null>;
  /** 打开导入：showOpenDialog → parseBundle（整体拒绝）→ diffBundle */
  booksourceBundleOpen?: () => Promise<BookSourceBundleOpenResult>;
  /** 应用勾选决策：写前全量预校验（safeFileName + BookSourceDocSchema），逐条 atomicWrite */
  booksourceBundleApply?: (
    decisions: { fileName: string; content: string }[],
  ) => Promise<BookSourceBundleApplyResult>;
}
