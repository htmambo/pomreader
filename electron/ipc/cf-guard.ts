/**
 * Cloudflare 盾检测与分层过盾编排
 * - isCfChallenge：响应判定（cf-mitigated 头 / 403|503 + cloudflare + 挑战页标记）
 * - ensureCfClearance（Tier 1）：复用 render-handler 隐藏窗口自动过盾
 * - cfPassManual（Tier 2）：可见窗口由用户手动完成交互验证（Turnstile 等）
 * 注意：与 fetch-handler 存在循环 import（fetch-handler ↔ cf-guard），
 * 所有跨模块引用均在函数调用期解析（CommonJS 属性访问惰性求值），无模块初始化期使用。
 */
import { BrowserWindow, IpcMain } from 'electron';
import { URL } from 'url';
import { isPrivateHost } from './fetch-handler';
import { FETCH_PARTITION, getFetchSession, UA } from './fetch-session';
import { cfPass } from './render-handler';

const CF_POLL_INTERVAL_MS = 500;
const MANUAL_PASS_TIMEOUT_MS = 120000;

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

/** Tier 1：隐藏窗口自动过盾；返回是否拿到 cf_clearance / 挑战页已消失 */
export async function ensureCfClearance(rawUrl: string): Promise<boolean> {
  if (!isValidFetchUrl(rawUrl)) return false;
  try {
    return await cfPass(rawUrl);
  } catch {
    return false;
  }
}

/** Tier 2：可见窗口人工过盾；cf_clearance 出现 → true；用户关窗/超时 → false */
export async function cfPassManual(rawUrl: string, parent: BrowserWindow): Promise<boolean> {
  if (!isValidFetchUrl(rawUrl)) return false;

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

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timeout);
      if (!win.isDestroyed()) win.close();
      resolve(ok);
    };

    win.on('closed', () => done(false));
    win.loadURL(rawUrl, { userAgent: UA }).catch(() => done(false));

    const poll = setInterval(() => {
      getFetchSession()
        .cookies.get({ url: rawUrl, name: 'cf_clearance' })
        .then((cookies) => {
          if (cookies.length > 0) done(true);
        })
        .catch(() => undefined);
    }, CF_POLL_INTERVAL_MS);

    const timeout = setTimeout(() => done(false), MANUAL_PASS_TIMEOUT_MS);
  });
}

export function registerCfGuardHandler(
  ipcMain: IpcMain,
  getMainWindow: () => BrowserWindow | null
): void {
  ipcMain.handle('pom:cf-pass-manual', async (_e, rawUrl: string) => {
    const parent = getMainWindow();
    if (!parent) return false;
    return cfPassManual(rawUrl, parent);
  });
}
