import { app, BrowserWindow, ipcMain, webContents } from 'electron';
import * as path from 'path';
import { registerFetchHandler } from './ipc/fetch-handler';
import { applyUaEverywhere, migrateLegacySearchCookies } from './ipc/fetch-session';
import { registerRenderHandler } from './ipc/render-handler';
import { registerExternalHandler } from './ipc/external-handler';
import { registerBookSourceHandler } from './ipc/booksource-handler';
import { registerCoverHandler } from './ipc/cover-handler';
import { registerCfGuardHandler } from './ipc/cf-guard';
import { registerAutoImport } from './auto-import';
import { loadWindowState, trackWindowState } from './window-state';

// 沿用原 vendor 兼容补丁 ⑤：防双实例 IndexedDB 锁争用
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

// 网络环境无法解析 WebRTC STUN 服务器（Google/Cloudflare）时，Chromium 网络服务
// 会反复刷 "Failed to resolve address for stun.*" DNS 错误日志 —— 映射到本地地址
// 使其静默快速失败（本应用不使用 WebRTC 出网，CF Turnstile 验证不依赖 STUN）
app.commandLine.appendSwitch(
  'host-resolver-rules',
  'MAP stun*.l.google.com 127.0.0.1, MAP stun.cloudflare.com 127.0.0.1'
);

app.on('second-instance', () => {
  const wins = BrowserWindow.getAllWindows();
  if (wins[0]) {
    if (wins[0].isMinimized()) wins[0].restore();
    wins[0].focus();
  }
});

// 任务栏 app_id（沿用原 vendor 兼容补丁 ④，Linux Wayland 匹配 .desktop）
if (process.platform === 'linux') {
  (app as unknown as { setDesktopName: (n: string) => void }).setDesktopName('pomreader');
}

let mainWindow: BrowserWindow | null = null;

function createWindow(userData: string): void {
  // 恢复上次窗口状态：位置（校验显示器可见性后）/ 尺寸 / 最大化 / 最小化
  const state = loadWindowState(userData);
  mainWindow = new BrowserWindow({
    width: state.width,
    height: state.height,
    ...(state.x !== undefined && state.y !== undefined ? { x: state.x, y: state.y } : {}),
    show: false,
    autoHideMenuBar: true,
    title: '白虎阅读',
    icon: path.join(__dirname, '..', 'electron', 'icons', 'icon.png'),
    webPreferences: {
      // webview 标签显式开启（Electron 默认禁用）
      webviewTag: true,
      // 安全隔离（比原 vendor 的 false 更安全，新写无旧 bundle 包袱）
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  if (state.isMaximized) mainWindow.maximize();
  trackWindowState(mainWindow, userData);

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    // 上次以最小化关闭 → 启动后同样最小化（先 show 再 minimize 避免闪烁）
    if (state.isMinimized) mainWindow?.minimize();
  });

  const devUrl = process.env['POM_DEV_URL'];
  if (devUrl) {
    // 开发模式：加载 Angular dev-server
    mainWindow.loadURL(devUrl);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    // 生产模式：加载 Angular build 产物（application builder 输出到 browser/ 子目录）
    // 用 file:// URL + 绝对路径，避免 path.join `__dirname/..` 在 asar 内解析异常
    const indexPath = path.resolve(__dirname, '..', 'electron', 'www', 'browser', 'index.html');
    mainWindow.loadURL('file://' + indexPath);
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
    // 主窗口关闭后销毁残留的隐藏窗口（如 render-handler 的抓取窗口），
    // 否则 window-all-closed 永不触发，进程无法退出
    for (const win of BrowserWindow.getAllWindows()) {
      win.destroy();
    }
  });
}

app.whenReady().then(() => {
  const userData = app.getPath('userData');
  registerFetchHandler(ipcMain);
  registerRenderHandler(ipcMain);
  registerExternalHandler(ipcMain);
  registerBookSourceHandler(ipcMain, userData);
  registerCoverHandler(ipcMain, userData);
  registerCfGuardHandler(ipcMain, () => mainWindow);
  registerAutoImport(ipcMain, userData, () => mainWindow);
  // 旧 webview session（persist:universal-search）的 cookie 迁移进共享抓取 session
  // （用户此前在其中手动过盾的 cf_clearance 不丢失）；异步执行不阻塞窗口创建
  void migrateLegacySearchCookies();
  // UA 全应用注入（defaultSession / userAgentFallback / 共享抓取 session）；
  // 自定义 UA 由渲染端设置页启动后推送（pom:set-fetch-ua）覆盖默认值
  applyUaEverywhere();
  createWindow(userData);

  // 拦截所有 webContents（含 webview）的 window.open / target=_blank：
  // 阻止新窗弹窗，改为在当前 webContents 内跳转（原 vendor 兼容补丁 ③ 现代等价）
  app.on('web-contents-created', (_e, wc) => {
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//.test(url)) {
        wc.loadURL(url);
      }
      return { action: 'deny' };
    });
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(userData);
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
