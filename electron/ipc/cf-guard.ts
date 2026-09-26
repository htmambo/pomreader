/**
 * Cloudflare 盾检测与分层过盾编排
 * - isCfChallenge：响应判定（cf-mitigated 头 / 403|503 + cloudflare + 挑战页标记）
 * - cfPassManual（Tier 2 可见窗口）：用户手动完成交互验证后直接提取渲染 HTML
 *
 * Tier 1（自动过盾）由 render-handler 的 cfFetchHtmlHidden 完成：
 * 隐藏窗口真实加载 URL，等挑战消失后取 documentElement.outerHTML 返回。
 * 浏览器能打开页面即视为过盾成功（99csw 这类无感 managed challenge 因此能"自动"通过）。
 *
 * 依赖方向（单向，无环）：cf-guard → render-handler / net-guard / fetch-session
 */
import { BrowserWindow, IpcMain } from 'electron';
import { URL } from 'url';
import { isPrivateHost } from './net-guard';
import { FETCH_PARTITION, getUA } from './fetch-session';
import { extractRenderedHtml, waitForPageCleared } from './render-handler';

const MANUAL_PASS_TIMEOUT_MS = 120000;
const LOAD_TIMEOUT_MS = 20000;

function isValidFetchUrl(rawUrl: string): boolean {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  return !isPrivateHost(u.hostname);
}

/** 响应是否为 Cloudflare 挑战页（JS challenge / Turnstile 拦截页） */
export function isCfChallenge(
  status: number,
  headers: Record<string, string>,
  bodySnippet: string
): boolean {
  if ((headers['cf-mitigated'] ?? '').toLowerCase() === 'challenge') return true;
  if (status !== 403 && status !== 503) return false;
  const server = (headers['server'] ?? '').toLowerCase();
  if (!server.includes('cloudflare')) return false;
  const snippet = bodySnippet.slice(0, 4096);
  return (
    snippet.includes('cf-chl') ||
    snippet.includes('challenge-platform') ||
    snippet.includes('Just a moment') ||
    snippet.includes('请稍候') ||
    snippet.includes('Attention Required')
  );
}

/**
 * Tier 2：可见窗口人工过盾
 * - 加载到真实页面（managed challenge 无感通过）→ 提取 outerHTML 返回；
 * - 用户关窗 / 超时 → null。
 *
 * 返回值是渲染后的 HTML 字符串（浏览器侧已完成 charset 解码 + JS 注水），
 * 调用方（fetch-handler / booksource-handler）直接把 html 当抓取结果使用，
 * 免去再次 net.request 验证 cookie 是否生效 —— cookie 失效的话新窗口同样过不了，
 * 已经实测了"用户能看见真实页面 = 当前 BrowserWindow 已过盾"。
 */
export async function cfPassManual(rawUrl: string, parent: BrowserWindow): Promise<string | null> {
  if (!isValidFetchUrl(rawUrl)) return null;

  const win = new BrowserWindow({
    width: 1000,
    height: 800,
    show: true,
    parent,
    autoHideMenuBar: true,
    title: '请完成 Cloudflare 验证',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      partition: FETCH_PARTITION,
    },
  });

  return new Promise<string | null>((resolve) => {
    let settled = false;
    const done = (html: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (!win.isDestroyed()) win.close();
      resolve(html);
    };

    win.on('closed', () => done(null));

    (async () => {
      try {
        await Promise.race([
          win.loadURL(rawUrl, { userAgent: getUA() }),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), LOAD_TIMEOUT_MS)),
        ]);
      } catch {
        done(null);
        return;
      }
      try {
        const cleared = await waitForPageCleared(win, MANUAL_PASS_TIMEOUT_MS);
        if (!cleared) { done(null); return; }
        done(await extractRenderedHtml(win));
      } catch {
        done(null);
      }
    })();

    const timeout = setTimeout(() => done(null), MANUAL_PASS_TIMEOUT_MS);
  });
}

export function registerCfGuardHandler(
  ipcMain: IpcMain,
  getMainWindow: () => BrowserWindow | null
): void {
  ipcMain.handle('pom:cf-pass-manual', async (_e, rawUrl: string) => {
    const parent = getMainWindow();
    if (!parent) return null;
    return cfPassManual(rawUrl, parent);
  });
}