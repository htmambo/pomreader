import { contextBridge, ipcRenderer } from 'electron';

/**
 * 渲染进程 ↔ 主进程桥接（contextIsolation 安全模式）
 * 仅暴露必要能力，不暴露 nodeIntegration / require
 */
contextBridge.exposeInMainWorld('pomAPI', {
  /** 抓取 URL HTML（主进程 net.request 绕 CORS；encoding 可指定覆盖侦测） */
  fetchHtml: (
    url: string,
    encoding?: 'auto' | 'utf-8' | 'gbk'
  ): Promise<{ html?: string; error?: string }> =>
    ipcRenderer.invoke('pom:fetch-html', url, encoding),

  /** 渲染抓取：隐藏窗口真实加载页面（执行 JS）后提取可视正文（静态解析失效站点兜底） */
  fetchRendered: (url: string): Promise<{ text?: string; error?: string }> =>
    ipcRenderer.invoke('pom:fetch-rendered', url),

  /** 外链走系统浏览器 */
  openExternal: (url: string): Promise<void> =>
    ipcRenderer.invoke('pom:open-external', url),

  /** 给指定 webview 的 session 重写 Content-Type charset（编码手动切换） */
  setWebviewEncoding: (
    webviewId: string,
    mode: 'auto' | 'utf-8' | 'gbk'
  ): Promise<void> =>
    ipcRenderer.invoke('pom:set-webview-encoding', webviewId, mode),

  // ── 流式事件订阅（ASSUMPTION-15：先 on 注册再 invoke，避免漏事件） ──
  /** 订阅主进程推送事件；返回取消订阅函数 */
  on: (channel: string, listener: (...args: any[]) => void): (() => void) => {
    const wrapped = (_e: unknown, ...args: unknown[]): void => listener(...args);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },

  // ── 书源 HTTP 代理（沙箱 legado.http） ────────────────────────────────
  booksourceHttpProxy: (req: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string | null;
  }): Promise<{ status: number; headers: Record<string, string>; body: string }> =>
    ipcRenderer.invoke('pom:booksource-http-proxy', req),

  /** 书源 eval（健康检测 / 调试）；主进程仅返回文件路径，函数名解析由 Renderer Worker 负责 */
  booksourceEval: (fileName: string, code?: string): Promise<string> =>
    ipcRenderer.invoke('pom:booksource-eval', fileName, code ?? ''),

  // ── 封面缓存 ──────────────────────────────────────────────────────────
  coverResolveCache: (req: {
    url: string;
    referer?: string;
    headers?: Record<string, string>;
  }): Promise<{ localPath: string; localRef: string }> =>
    ipcRenderer.invoke('pom:cover-resolve-cache', req),

  coverCacheSize: (): Promise<number> =>
    ipcRenderer.invoke('pom:cover-cache-size'),

  coverCacheClear: (): Promise<number> =>
    ipcRenderer.invoke('pom:cover-cache-clear'),

  // ── 书源文件 CRUD ─────────────────────────────────────────────────────
  booksourceList: (): Promise<unknown[]> =>
    ipcRenderer.invoke('pom:booksource-list'),

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

  // ── 扩展 CRUD + eval stub ─────────────────────────────────────────────
  extensionList: (): Promise<unknown[]> =>
    ipcRenderer.invoke('pom:extension-list'),

  extensionRead: (fileName: string): Promise<string> =>
    ipcRenderer.invoke('pom:extension-read', fileName),

  extensionSave: (fileName: string, content: string): Promise<void> =>
    ipcRenderer.invoke('pom:extension-save', fileName, content),

  extensionDelete: (fileName: string): Promise<void> =>
    ipcRenderer.invoke('pom:extension-delete', fileName),

  /** v1 仅返回元数据 + 文件路径（实际沙箱执行由 Renderer Worker 承担） */
  extensionEval: (fileName: string, args: unknown[]): Promise<unknown> =>
    ipcRenderer.invoke('pom:extension-eval', fileName, args),

  // ── 书源市场 ──────────────────────────────────────────────────────────
  booksourceFetchRepo: (repoUrl: string): Promise<unknown> =>
    ipcRenderer.invoke('pom:booksource-fetch-repo', repoUrl),

  booksourceInstall: (downloadUrl: string, fileName: string): Promise<void> =>
    ipcRenderer.invoke('pom:booksource-install', downloadUrl, fileName),

  // ── 健康检测（主进程 stub：返回文件路径 + 元数据，详细检测由 Renderer 沙箱执行） ──
  sourceHealthCheck: async (fileName: string): Promise<{
    fileName: string;
    capabilities: string[];
    testedAt: number;
    filePath?: string;
  }> => {
    // 主进程仅提供文件存在性校验；实际能力列表走 booksourceEval → Renderer 沙箱
    try {
      const filePath = await ipcRenderer.invoke('pom:booksource-eval', fileName, '');
      return {
        fileName,
        capabilities: [],
        testedAt: Date.now(),
        filePath: String(filePath),
      };
    } catch {
      return {
        fileName,
        capabilities: [],
        testedAt: Date.now(),
      };
    }
  },
});