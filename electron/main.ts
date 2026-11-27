import { app, BrowserWindow, ipcMain, net, protocol, session } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL, URL } from 'url';
import { isPrivateHost } from './ipc/net-guard';
import { registerFetchHandler } from './ipc/fetch-handler';
import {
  applyUaEverywhere,
  FETCH_PARTITION,
  migrateLegacySearchCookies,
} from './ipc/fetch-session';
import { registerRenderHandler } from './ipc/render-handler';
import { registerExternalHandler } from './ipc/external-handler';
import { registerBookSourceHandler } from './ipc/booksource-handler';
import { registerBookSourceBundleHandler } from './ipc/booksource-bundle-handler';
import { registerBookSourceSubscriptionHandler } from './ipc/booksource-subscription';
import { migrateBookSources, registerBookSourceMigrationHandlers } from './ipc/booksource-migrate';
import { registerCoverHandler } from './ipc/cover-handler';
import { registerCfGuardHandler } from './ipc/cf-guard';
import { registerAutoImport } from './auto-import';
import { registerDbHandler } from './db/db-window';
import {
  registerPowerBlockerHandler,
  stopBlockerOnQuit,
  watchWebContents,
} from './ipc/power-blocker';
import { loadWindowState, trackWindowState } from './window-state';

// 沿用原 vendor 兼容补丁 ⑤：防双实例 IndexedDB 锁争用
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

// 本地资源自定义 scheme：HMR 开发页（http://localhost:4200 origin）无法加载 file://
// 子资源（Chromium 安全策略），封面等本地缓存统一走 pom-local://，三种运行方式通用。
// 必须在 app ready 之前注册为特权 scheme
protocol.registerSchemesAsPrivileged([
  { scheme: 'pom-local', privileges: { secure: true, stream: true, supportFetchAPI: true } },
]);

// 网络环境无法解析 WebRTC STUN 服务器（Google/Cloudflare）时，Chromium 网络服务
// 会反复刷 "Failed to resolve address for stun.*" DNS 错误日志 —— 映射到本地地址
// 使其静默快速失败（本应用不使用 WebRTC 出网，CF Turnstile 验证不依赖 STUN）
app.commandLine.appendSwitch(
  'host-resolver-rules',
  'MAP stun*.l.google.com 127.0.0.1, MAP stun.cloudflare.com 127.0.0.1',
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
  // 窗口关闭 / 渲染进程崩溃时兜底释放唤醒锁（关窗、崩溃后 reload 均不经 ngOnDestroy）
  watchWebContents(mainWindow.webContents);

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

  // 主窗口只承载本地应用页面：拒绝页面发起的任何外部导航
  // （远程内容一律走 webview / 隐藏窗口，二者有各自的导航护栏）
  // 开发模式按 **origin** 精确比较，不能用 startsWith（端口前缀会误命中 `:42000` 之类的地址）。
  const devOrigin = (() => {
    if (!devUrl) return null;
    try {
      return new URL(devUrl).origin;
    } catch {
      return null;
    }
  })();
  mainWindow.webContents.on('will-navigate', (event, url) => {
    let allowed = false;
    try {
      allowed = devOrigin ? new URL(url).origin === devOrigin : url.startsWith('file://');
    } catch {
      allowed = false;
    }
    if (!allowed) event.preventDefault();
  });

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

  // 权限收口：应用内的远程内容（万能搜索 webview / CF 过盾窗口 / 隐藏渲染窗口）
  // 默认不允许摄像头、麦克风、地理位置、通知、剪贴板读取等能力；
  // 仅放行复制到剪贴板与全屏播放这两个明确用到的能力。
  const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write', 'fullscreen']);
  const lockDownPermissions = (sess: Electron.Session): void => {
    sess.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(ALLOWED_PERMISSIONS.has(permission));
    });
    sess.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission));
  };
  lockDownPermissions(session.defaultSession);
  lockDownPermissions(session.fromPartition(FETCH_PARTITION));

  // pom-local://<encodeURIComponent(绝对路径)> —— 本地文件读取，仅限 userData 目录内
  // （防止 webview 内远程页面借该 scheme 读任意本地文件）。
  // 供 <img> 等 no-cors 子资源加载使用（fetch() 对自定义 scheme 另有 CORS 限制，页面侧不走 fetch）
  // 路径校验先 realpath：userData 内若存在指向外部的符号链接，前缀比较会被绕过。
  const realUserData = (() => {
    try {
      return fs.realpathSync(userData);
    } catch {
      return userData;
    }
  })();
  protocol.handle('pom-local', (request) => {
    const abs = path.resolve(decodeURIComponent(request.url.slice('pom-local://'.length)));
    let real = abs;
    try {
      real = fs.realpathSync(abs);
    } catch {
      // 目标不存在时退化为「解析父目录 + 文件名」，仍可拦截目录级符号链接
      try {
        real = path.join(fs.realpathSync(path.dirname(abs)), path.basename(abs));
      } catch {
        return new Response('forbidden', { status: 403 });
      }
    }
    if (real !== realUserData && !real.startsWith(realUserData + path.sep)) {
      return new Response('forbidden', { status: 403 });
    }
    return net.fetch(pathToFileURL(real).toString());
  });
  registerFetchHandler(ipcMain);
  registerRenderHandler(ipcMain);
  registerExternalHandler(ipcMain);
  // 存量 JS 书源启动迁移（方案 §4.2）：
  //  - 改为**建窗之后**再跑：迁移是同步的（全文 readFileSync + JS 解析），
  //    放在 createWindow 之前会把首屏整体推迟；放在之后则渲染进程可与迁移并行启动。
  //  - 但列表与一次性迁移报告必须读到**迁移后**状态 → 用 migrationDone 门控两个 IPC 通道
  //    （旧注释「必须在书源 handler 注册前完成，否则渲染端先读到未迁移列表」的因果并不成立：
  //     scanJsonDir 只在 IPC invoke 时懒调用，注册期只做 mkdirSync）。
  //  - 失败只告警不阻断启动（migrationDone 在 finally 中 resolve，渲染端照常启动）。
  let resolveMigration: () => void = () => undefined;
  const migrationDone = new Promise<void>((resolve) => {
    resolveMigration = resolve;
  });
  registerBookSourceHandler(ipcMain, userData, migrationDone);
  registerBookSourceBundleHandler(ipcMain, userData, () => mainWindow);
  // 书源订阅自动更新（设计 §6，Phase 2）：调度在主进程，窗口最小化/后台仍运行；
  // 广播逐个窗口发（getAllWindows），will-quit 清 timer
  const booksourceSubScheduler = registerBookSourceSubscriptionHandler(ipcMain, userData, () =>
    BrowserWindow.getAllWindows(),
  );
  booksourceSubScheduler.start();
  app.on('will-quit', () => booksourceSubScheduler.stop());
  registerBookSourceMigrationHandlers(ipcMain, userData, migrationDone);
  registerCoverHandler(ipcMain, userData);
  registerCfGuardHandler(ipcMain, () => mainWindow);
  registerAutoImport(ipcMain, userData, () => mainWindow);
  // 阅读时防睡眠/防锁屏（renderer PowerBlockerService 经 IPC 驱动）
  registerPowerBlockerHandler(ipcMain);
  // 书库 DB：隐藏窗口统一持有 PouchDB（详见 db/db-window.ts 头注释）
  registerDbHandler(ipcMain);
  // 旧 webview session（persist:universal-search）的 cookie 迁移进共享抓取 session
  // （用户此前在其中手动过盾的 cf_clearance 不丢失）；异步执行不阻塞窗口创建
  void migrateLegacySearchCookies();
  // UA 全应用注入（defaultSession / userAgentFallback / 共享抓取 session）；
  // 自定义 UA 由渲染端设置页启动后推送（pom:set-fetch-ua）覆盖默认值
  applyUaEverywhere();
  createWindow(userData);

  // 存量 JS 书源启动迁移：建窗之后再跑（setImmediate 让出当前事件循环一拍，
  // 渲染进程得以并行启动），迁移本身是同步的 —— 对存量用户（booksources/ 下有 .js）
  // 才产生实际开销，无 .js 时一次 readdir 即返回。
  // 无论成败都在 finally 里 resolve migrationDone：失败时渲染端照常启动，
  // 迁移报告文件未写出 → readMigrationReportOnce 返回 null → 渲染端不弹窗、不报错。
  setImmediate(() => {
    try {
      migrateBookSources(userData);
    } catch (err) {
      console.warn('[booksource-migrate] 启动迁移失败（不阻断启动）:', err);
    } finally {
      resolveMigration();
    }
  });

  // 拦截所有 webContents（含 webview）的 window.open / target=_blank：
  // 阻止新窗弹窗，改为在当前 webContents 内跳转（原 vendor 兼容补丁 ③ 现代等价）
  app.on('web-contents-created', (_e, wc) => {
    wc.setWindowOpenHandler(({ url }) => {
      // 只允许在当前 webContents 内跳转到公网 http(s)；
      // loadURL 不会触发 will-navigate / will-redirect，私网地址必须在这里拦下（SSRF）。
      if (/^https?:\/\//.test(url)) {
        try {
          if (!isPrivateHost(new URL(url).hostname)) wc.loadURL(url);
        } catch {
          /* 非法 URL：拒绝 */
        }
      }
      return { action: 'deny' };
    });
  });

  // 安全网：关窗即退出后此分支通常不可达；保留以防未来 before-quit 阻止退出
  // 或引入托盘保活时，点击 Dock 图标无法重建窗口
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(userData);
  });
});

// 全平台关窗即退出（含 macOS 打包版），不留 Dock
app.on('window-all-closed', () => {
  app.quit();
});

// 退出前显式释放唤醒锁：阅读页可能仍持有，不释放会让系统在应用退出后仍被阻止休眠
app.on('before-quit', () => {
  stopBlockerOnQuit();
});
