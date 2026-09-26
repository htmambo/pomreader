/**
 * 自动导入监控（万能搜索 webview 的 .txt / 压缩包自动导入）
 *
 * 两条触发链：
 * 1. session will-download：服务器以 attachment 形式下发 .txt/.zip → 静默保存到
 *    <userData>/auto-import/downloads/，完成后走 processBuffer 管线
 * 2. pom:auto-import-from-url：webview 直接导航到 .txt/.zip 页面（服务器按 inline 展示）
 *    由渲染端 universal-search 的 will-navigate 拦截后调用，safeNetRequest 抓字节走同一管线
 *
 * 管线：bytes → 按扩展名 解码(txt) / 解压取最大 txt(zip) → 统一转 utf-8 写入
 * <userData>/auto-import/txt/ → webContents.send('pom:auto-import-detected') 通知渲染端导入书架
 *
 * 编码：txt 先 TextDecoder(utf-8, fatal) 试解，失败回退 gb18030（中文小说站常见 GBK）
 * rar/7z v1 不支持：引入原生/wasm 解压依赖代价过大，诚实报错提示手动解压
 */
import { BrowserWindow, IpcMain, Session, app, dialog, session } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import AdmZip from 'adm-zip';
import iconv from 'iconv-lite';
import { safeNetRequest } from './ipc/safe-net';

/** 触发自动导入的扩展名（rar/7z 能识别但解压不支持 → 明确报错） */
const IMPORTABLE_EXTS = ['.txt', '.zip', '.rar', '.7z'];
const URL_FETCH_TIMEOUT_MS = 60_000;
const MAX_TXT_BYTES = 200 * 1024 * 1024;

export interface AutoImportDetected {
  /** 展示用文件名（原始下载名 / 压缩包内 txt 名） */
  fileName: string;
  /** 产出的 utf-8 txt 文件名（位于 <userData>/auto-import/txt/ 下，供 read-text 读取） */
  txtName: string;
}

export interface AutoImportError {
  fileName: string;
  error: string;
}

/** 文件名是否命中自动导入监控（供 will-download 与渲染端 URL 判断共用同一语义） */
export function isImportableFileName(name: string): boolean {
  const clean = name.split(/[?#]/)[0];
  return IMPORTABLE_EXTS.includes(path.extname(clean).toLowerCase());
}

/** txt 解码：utf-8 严格试解 → gb18030 兜底 */
function decodeTxt(buf: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return iconv.decode(buf, 'gb18030');
  }
}

function sanitizeFileName(name: string): string {
  const base = name.replace(/[\\/:*?"<>|]/g, '_').trim();
  return base || `import-${Date.now()}.txt`;
}

/**
 * bytes → 产出 utf-8 txt 到 txtDir，返回 { fileName, txtName }
 * fileName：展示名（zip 取包内 txt 名）；txtName：落盘的 utf-8 文件名
 */
function processBuffer(txtDir: string, rawName: string, bytes: Buffer): AutoImportDetected {
  const ext = path.extname(rawName.split(/[?#]/)[0]).toLowerCase();
  fs.mkdirSync(txtDir, { recursive: true });

  let displayName = sanitizeFileName(path.basename(rawName.split(/[?#]/)[0]) || rawName);
  let text: string;

  if (ext === '.txt') {
    text = decodeTxt(bytes);
  } else if (ext === '.zip') {
    const zip = new AdmZip(bytes);
    // 包内可能多个 txt：取体积最大者（正文通常最大）
    const entries = zip
      .getEntries()
      .filter((en) => !en.isDirectory && en.entryName.toLowerCase().endsWith('.txt'))
      .sort((a, b) => b.header.size - a.header.size);
    if (entries.length === 0) throw new Error('压缩包内未找到 .txt 文件');
    const entry = entries[0];
    displayName = sanitizeFileName(path.basename(entry.entryName));
    text = decodeTxt(entry.getData());
  } else if (ext === '.rar' || ext === '.7z') {
    throw new Error(`暂不支持 ${ext} 自动解压，请手动解压后通过「导入本地 TXT」导入`);
  } else {
    throw new Error(`不支持的文件类型 ${ext || '(无扩展名)'}`);
  }

  const txtName = sanitizeFileName(displayName.replace(/\.[^.]+$/, '') + '.txt');
  fs.writeFileSync(path.join(txtDir, txtName), text, 'utf-8');
  return { fileName: displayName, txtName };
}

/** 校验 txtName 必须落在 txtDir 内（防路径穿越读取任意文件） */
function resolveTxtPath(txtDir: string, txtName: string): string {
  const p = path.resolve(txtDir, txtName);
  if (!p.startsWith(path.resolve(txtDir) + path.sep)) throw new Error('非法 txtName');
  return p;
}

export function registerAutoImport(ipcMain: IpcMain, userData: string, getWindow: () => BrowserWindow | null): void {
  const downloadDir = path.join(userData, 'auto-import', 'downloads');
  const txtDir = path.join(userData, 'auto-import', 'txt');

  const notify = (payload: AutoImportDetected | AutoImportError): void => {
    getWindow()?.webContents.send('pom:auto-import-detected', payload);
  };

  /**
   * 解析失败回退：走正常下载流程——弹出保存对话框，用户选目录后留存原始文件
   * srcPath 与 bytes 二选一（下载链给磁盘路径、URL 链给内存字节）
   * 返回保存路径；用户取消或窗口不可用返回 null
   */
  const fallbackSaveDialog = async (rawName: string, srcPath: string | null, bytes: Buffer | null): Promise<string | null> => {
    const win = getWindow();
    if (!win) return null;
    const { canceled, filePath: dest } = await dialog.showSaveDialog(win, {
      title: '自动导入失败，请保存原始文件',
      defaultPath: path.join(app.getPath('downloads'), path.basename(rawName)),
    });
    if (canceled || !dest) return null;
    if (srcPath) {
      try {
        fs.renameSync(srcPath, dest);
      } catch {
        // 跨设备 rename 失败退化为 copy+delete
        fs.copyFileSync(srcPath, dest);
        try { fs.unlinkSync(srcPath); } catch { /* noop */ }
      }
    } else if (bytes) {
      fs.writeFileSync(dest, bytes);
    }
    return dest;
  };

  /** 下载完成后的统一处理（解析失败回退保存对话框；中间产物不留存） */
  const handleFile = async (filePath: string, rawName: string): Promise<void> => {
    try {
      const bytes = fs.readFileSync(filePath);
      notify(processBuffer(txtDir, rawName, bytes));
      try { fs.unlinkSync(filePath); } catch { /* noop */ }
    } catch (e) {
      const reason = (e as Error).message;
      const saved = await fallbackSaveDialog(rawName, filePath, null);
      if (saved) {
        notify({ fileName: path.basename(rawName), error: `自动导入失败（${reason}），原始文件已保存到：${saved}` });
      } else {
        try { fs.unlinkSync(filePath); } catch { /* noop */ }
        notify({ fileName: path.basename(rawName), error: reason });
      }
    }
  };

  // ── 触发链 1：attachment 下载拦截 ──────────────────────────────────
  const onWillDownload = (event: Electron.Event, item: Electron.DownloadItem): void => {
    const rawName = item.getFilename() || 'download.txt';
    if (!isImportableFileName(rawName)) return; // 非目标类型：走系统默认保存对话框
    // 注意：此处不能 event.preventDefault()——will-download 中它会取消下载；
    // setSavePath 本身即抑制保存对话框，实现静默下载
    fs.mkdirSync(downloadDir, { recursive: true });
    const savePath = path.join(downloadDir, `${Date.now()}-${sanitizeFileName(rawName)}`);
    item.setSavePath(savePath);
    item.once('done', (_e, state) => {
      if (state === 'completed') void handleFile(savePath, rawName);
      else {
        try { fs.unlinkSync(savePath); } catch { /* noop */ }
        notify({ fileName: rawName, error: `下载未成功（${state}）` });
      }
    });
  };

  // webview 可带独立 partition（如 persist:universal-search），其下载不经 defaultSession ——
  // 必须按 Session 逐个挂载；Session 单例 + WeakSet 防重复挂载
  const hookedSessions = new WeakSet<Session>();
  const hookSession = (s: Session): void => {
    if (hookedSessions.has(s)) return;
    hookedSessions.add(s);
    s.on('will-download', onWillDownload);
  };
  hookSession(session.defaultSession);
  // 已知的 webview partition 提前挂载（web-contents-created 兜底其余动态 session）
  hookSession(session.fromPartition('persist:universal-search'));
  // 之后创建的每个 webContents（含 webview guest）按其实际 session 挂载
  app.on('web-contents-created', (_e, wc) => {
    hookSession(wc.session);
  });

  // ── 触发链 2：inline 页面（webview 导航到 .txt/.zip URL） ──────────
  ipcMain.handle('pom:auto-import-from-url', async (_e, url: string) => {
    const rawName = decodeURIComponent(url.split('/').pop()?.split(/[?#]/)[0] || 'page.txt');
    const result = await safeNetRequest(url, {
      timeoutMs: URL_FETCH_TIMEOUT_MS,
      maxBytes: MAX_TXT_BYTES,
    });
    if (result.status < 200 || result.status >= 300) {
      throw new Error(`抓取失败 HTTP ${result.status}`);
    }
    try {
      const detected = processBuffer(txtDir, rawName, result.bytes);
      notify(detected);
      return detected;
    } catch (e) {
      // 解析失败同样回退正常下载流程（内存字节直接写用户所选位置）
      const reason = (e as Error).message;
      const saved = await fallbackSaveDialog(rawName, null, result.bytes);
      throw new Error(saved ? `${reason}，原始文件已保存到：${saved}` : reason);
    }
  });

  // ── 渲染端读取产出的 utf-8 文本（路径校验防穿越） ───────────────────
  ipcMain.handle('pom:auto-import-read-text', (_e, txtName: string) => {
    const p = resolveTxtPath(txtDir, String(txtName ?? ''));
    if (!fs.existsSync(p)) throw new Error('导入产物不存在或已被清理');
    return fs.readFileSync(p, 'utf-8');
  });
}
