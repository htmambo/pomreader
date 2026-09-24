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
});
