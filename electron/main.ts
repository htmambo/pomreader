import { app, BrowserWindow, ipcMain, webContents } from 'electron';
import * as path from 'path';
import { registerFetchHandler } from './ipc/fetch-handler';
import { registerExternalHandler } from './ipc/external-handler';

// 沿用原 vendor 兼容补丁 ⑤：防双实例 IndexedDB 锁争用
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

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

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    title: '白虎阅读',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      // webview 标签显式开启（Electron 默认禁用）
      webviewTag: true,
      // 安全隔离（比原 vendor 的 false 更安全，新写无旧 bundle 包袱）
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  const devUrl = process.env['POM_DEV_URL'];
  if (devUrl) {
    // 开发模式：加载 Angular dev-server
    mainWindow.loadURL(devUrl);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    // 生产模式：加载 Angular build 产物（application builder 输出到 browser/ 子目录）
    mainWindow.loadFile(path.join(__dirname, '..', 'electron', 'www', 'browser', 'index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  registerFetchHandler(ipcMain);
  registerExternalHandler(ipcMain);
  createWindow();

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
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
