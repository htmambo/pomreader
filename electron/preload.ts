import { contextBridge, ipcRenderer } from 'electron';

// 本地路径 → pom-local:// URL：HMR 页面（http origin）无法加载 file:// 子资源，
// 本地缓存文件（封面等）统一走自定义 scheme（主进程 protocol.handle，仅限 userData 目录）。
// 路径整体 encodeURIComponent，主进程 decode 后还原，无需关心保留字符。
const toFileSrc = (filePath: string): string => {
  const normalized = filePath.replace(/\\/g, '/');
  const withSlash = normalized.startsWith('/') ? normalized : `/${normalized}`;
  return `pom-local://${encodeURIComponent(withSlash)}`;
};

/**
 * 渲染进程 ↔ 主进程桥接（contextIsolation 安全模式）
 * 仅暴露必要能力，不暴露 nodeIntegration / require
 */
contextBridge.exposeInMainWorld('pomAPI', {
  /** 抓取 URL HTML（主进程 net.request 绕 CORS；encoding 可指定覆盖侦测） */
  fetchHtml: (
    url: string,
    encoding?: 'auto' | 'utf-8' | 'gbk',
  ): Promise<{ html?: string; error?: string }> =>
    ipcRenderer.invoke('pom:fetch-html', url, encoding),

  /** 渲染抓取：隐藏窗口真实加载页面（执行 JS）后提取可视正文（静态解析失效站点兜底） */
  fetchRendered: (url: string): Promise<{ text?: string; error?: string }> =>
    ipcRenderer.invoke('pom:fetch-rendered', url),

  /** Cloudflare Tier 2 人工过盾：弹可见窗口由用户完成验证；
   * 返回渲染后的 HTML（浏览器侧已完成 charset 解码 + JS 注水），null = 用户关窗/超时 */
  cfPassManual: (url: string): Promise<string | null> =>
    ipcRenderer.invoke('pom:cf-pass-manual', url),

  /** 外链走系统浏览器 */
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('pom:open-external', url),

  /** 给指定 webview 的 session 重写 Content-Type charset（编码手动切换） */
  setWebviewEncoding: (webviewId: string, mode: 'auto' | 'utf-8' | 'gbk'): Promise<void> =>
    ipcRenderer.invoke('pom:set-webview-encoding', webviewId, mode),

  /** 抓取 UA 设置：读取当前生效值 + 默认值；设置自定义 UA（null/空 = 恢复默认） */
  getFetchUA: (): Promise<{ ua: string; defaultUa: string }> =>
    ipcRenderer.invoke('pom:get-fetch-ua'),
  setFetchUA: (ua: string | null): Promise<{ ua: string }> =>
    ipcRenderer.invoke('pom:set-fetch-ua', ua),

  // ── 流式事件订阅（ASSUMPTION-15：先 on 注册再 invoke，避免漏事件） ──
  /** 订阅主进程推送事件；返回取消订阅函数 */
  on: (channel: string, listener: (...args: any[]) => void): (() => void) => {
    const wrapped = (_e: unknown, ...args: unknown[]): void => listener(...args);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },

  // ── 书源 HTTP 代理（规则引擎 legado.http 同款通道） ─────────────────────
  booksourceHttpProxy: (req: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string | null;
  }): Promise<{
    status: number;
    headers: Record<string, string>;
    body: string;
    cfChallenge?: boolean;
  }> => ipcRenderer.invoke('pom:booksource-http-proxy', req),

  // ── 封面缓存 ──────────────────────────────────────────────────────────
  coverResolveCache: (req: {
    url: string;
    referer?: string;
    headers?: Record<string, string>;
  }): Promise<{ localPath: string; localRef: string }> =>
    ipcRenderer.invoke('pom:cover-resolve-cache', req),

  coverCacheSize: (): Promise<number> => ipcRenderer.invoke('pom:cover-cache-size'),

  coverCacheClear: (): Promise<number> => ipcRenderer.invoke('pom:cover-cache-clear'),

  // ── 书源文件 CRUD ─────────────────────────────────────────────────────
  booksourceList: (): Promise<unknown[]> => ipcRenderer.invoke('pom:booksource-list'),

  /** 流式列表：触发主进程后台扫描并通过 'pom:booksource-batch' 分批推送 */
  booksourceListStreaming: (requestId: string): Promise<void> =>
    ipcRenderer.invoke('pom:booksource-list-streaming', requestId),

  booksourceRead: (fileName: string, sourceDir?: string): Promise<string> =>
    ipcRenderer.invoke('pom:booksource-read', fileName, sourceDir ?? null),

  booksourceSave: (fileName: string, content: string, sourceDir?: string): Promise<void> =>
    ipcRenderer.invoke('pom:booksource-save', fileName, content, sourceDir ?? null),

  booksourceDelete: (fileName: string, sourceDir?: string): Promise<void> =>
    ipcRenderer.invoke('pom:booksource-delete', fileName, sourceDir ?? null),

  booksourceToggle: (fileName: string, enabled: boolean, sourceDir?: string): Promise<void> =>
    ipcRenderer.invoke('pom:booksource-toggle', fileName, enabled, sourceDir ?? null),

  booksourceSaveDraft: (fileName: string, content: string): Promise<void> =>
    ipcRenderer.invoke('pom:booksource-save-draft', fileName, content),

  // ── 书源 JSON（BookSourceDoc，方案 §3.4 P2；与 .js 链路并存，P4 收敛） ──
  // 批次事件订阅镜像 .js 流式列表写法：用上方通用 on('pom:booksource-json-batch', listener)
  booksourceListJson: (): Promise<unknown[]> => ipcRenderer.invoke('pom:booksource-list-json'),

  /** JSON 流式列表：后台扫描 + 'pom:booksource-json-batch' 分批推送 */
  booksourceListJsonStreaming: (requestId: string): Promise<void> =>
    ipcRenderer.invoke('pom:booksource-list-json-streaming', requestId),

  booksourceSaveJson: (fileName: string, doc: unknown, sourceDir?: string): Promise<void> =>
    ipcRenderer.invoke('pom:booksource-save-json', fileName, doc, sourceDir ?? null),

  booksourceToggleJson: (fileName: string, enabled: boolean, sourceDir?: string): Promise<void> =>
    ipcRenderer.invoke('pom:booksource-toggle-json', fileName, enabled, sourceDir ?? null),

  booksourceDeleteJson: (fileName: string, sourceDir?: string): Promise<void> =>
    ipcRenderer.invoke('pom:booksource-delete-json', fileName, sourceDir ?? null),

  // ── 书源迁移（方案 §4.2/§3.4，P3） ─────────────────────────────────────
  /** 手动批量重触发存量 .js → .json 迁移（主进程内完成，原子写）；返回迁移报告 */
  booksourceConvert: (): Promise<unknown> => ipcRenderer.invoke('pom:booksource-convert'),

  /** 读一次性迁移报告（读后删）；无报告返回 null */
  booksourceMigrationReport: (): Promise<unknown | null> =>
    ipcRenderer.invoke('pom:booksource-migration-report'),

  /** 常驻扫描 booksources_legacy/（needs-manual 行内状态数据源，§4.3）；sourceDir = legacy 目录绝对路径 */
  booksourceLegacyList: (): Promise<
    { fileName: string; enabled: boolean; sourceDir: string; reason?: string }[]
  > => ipcRenderer.invoke('pom:booksource-legacy-list'),

  // ── 自动导入监控（万能搜索 webview .txt/压缩包 → 自动入书架） ────────
  /** 主进程检测到可导入文件并完成解码/解压后推送；返回取消订阅函数 */
  onAutoImport: (
    cb: (payload: { fileName: string; txtName?: string; error?: string }) => void,
  ): (() => void) => {
    const listener = (
      _e: unknown,
      payload: { fileName: string; txtName?: string; error?: string },
    ): void => cb(payload);
    ipcRenderer.on('pom:auto-import-detected', listener);
    return () => ipcRenderer.removeListener('pom:auto-import-detected', listener);
  },

  /** webview 导航到 .txt/.zip 页面时由渲染端主动触发抓取 + 自动导入 */
  autoImportFromUrl: (url: string): Promise<{ fileName: string; txtName: string }> =>
    ipcRenderer.invoke('pom:auto-import-from-url', url),

  /** 读取自动导入产出的 utf-8 文本（txtName 限 auto-import/txt 目录内） */
  autoImportReadText: (txtName: string): Promise<string> =>
    ipcRenderer.invoke('pom:auto-import-read-text', txtName),

  /**
   * 书库 DB 操作代理：op ∈ allDocs/get/put/bulkDocs/destroy（隐藏 DB 窗口统一持有 PouchDB，
   * HMR / dev:file / 打包三种运行方式因此共享同一份书库；详见 electron/db/db-window.ts）。
   * 返回包络 { ok, result|error }，error 保留 PouchDB 的 status/name/message（404/409 语义）
   */
  dbRequest: (
    op: string,
    args: unknown[],
  ): Promise<{
    ok: boolean;
    result?: unknown;
    error?: { status?: number; name?: string; message?: string };
  }> => ipcRenderer.invoke('pom:db-request', op, args),
});

/**
 * 标准 Electron API 桥接（contextIsolation 安全模式）
 * 仅暴露渲染端确实需要的同步 API；不做整模块透传，避免泄漏 ipcRenderer / require 等能力
 */
contextBridge.exposeInMainWorld('electronAPI', {
  /** 把本地绝对路径转成 <img src> 可加载的 pom-local:// URL（renderer 用） */
  convertFileSrc: (filePath: string): string => toFileSrc(filePath),
});
