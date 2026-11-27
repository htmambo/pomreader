import { IpcMain, session } from 'electron';
import { URL } from 'url';
import { EncodingMode } from './encoding';
import { isCfChallenge } from './cf-guard';
import { getUA, defaultUA, setFetchUA } from './fetch-session';
import { cfFetchHtmlHidden } from './render-handler';
import { isPrivateHost } from './net-guard';
import { safeNetRequest } from './safe-net';
import {
  safeHandleWithMeta,
  FetchHtmlArgsSchema,
  GetFetchUaArgsSchema,
  SetFetchUaArgsSchema,
  SetWebviewEncodingArgsSchema,
} from './schema';

const FETCH_TIMEOUT_MS = 15000;
const MAX_BYTES = 8 * 1024 * 1024; // 8MB 响应上限，防内存爆炸

type FetchResult = { html?: string; error?: string };

function validateUrl(rawUrl: string): boolean {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (isPrivateHost(u.hostname)) return false;
  return true;
}

/**
 * 统一走 safeNetRequest：
 * - `redirect:'manual'` + 每跳重新 `isPrivateHost` 校验 → 堵住「公网 URL 302 到内网」的 SSRF 绕过
 * - 整条重定向链共享一份绝对 deadline（超时预算累计，不再每跳重置）
 * - 共享 persist:fetch session + 类浏览器请求头（与原实现一致）
 *
 * 错误语义保持向后兼容：timeout / parse-failed / invalid-url 原样透传，
 * 其余网络错误（DNS / 连接失败等）映射为 source-unavailable。
 */
async function doFetch(rawUrl: string, mode: EncodingMode): Promise<FetchResult> {
  try {
    const res = await safeNetRequest(rawUrl, {
      timeoutMs: FETCH_TIMEOUT_MS,
      maxBytes: MAX_BYTES,
      encoding: mode,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    });
    if (isCfChallenge(res.status, res.headers, res.body.slice(0, 4096))) {
      return { error: 'cf-challenge' };
    }
    return { html: res.body };
  } catch (e) {
    const msg = (e as Error)?.message ?? '';
    if (msg === 'timeout' || msg === 'parse-failed' || msg === 'invalid-url') {
      return { error: msg };
    }
    return { error: 'source-unavailable' };
  }
}

export function registerFetchHandler(ipcMain: IpcMain): void {
  // EVO-4: safeHandle 接管所有 4 个 channel；入参由 schema parse 验证
  safeHandleWithMeta(
    ipcMain,
    'pom:fetch-html',
    'FetchHtmlArgsSchema',
    FetchHtmlArgsSchema,
    async (_e, [rawUrl, mode = 'auto']) => {
      if (!validateUrl(rawUrl)) {
        return { error: 'invalid-url' };
      }

      let res = await doFetch(rawUrl, mode);
      // CF 挑战页 → 隐藏窗口真实加载 + 等待挑战消失 + 提取渲染 HTML
      if (res.error === 'cf-challenge') {
        const html = await cfFetchHtmlHidden(rawUrl);
        if (html) return { html };
      }
      return res;
    },
  );

  // 抓取 UA 设置（设置页）：读取当前生效值 + 默认值
  safeHandleWithMeta(
    ipcMain,
    'pom:get-fetch-ua',
    'GetFetchUaArgsSchema',
    GetFetchUaArgsSchema,
    () => ({ ua: getUA(), defaultUa: defaultUA() }),
  );

  // 抓取 UA 设置：自定义 UA（null/空 = 恢复默认）
  safeHandleWithMeta(
    ipcMain,
    'pom:set-fetch-ua',
    'SetFetchUaArgsSchema',
    SetFetchUaArgsSchema,
    (_e, [ua]) => {
      const v = (ua ?? '').trim();
      if (v.length > 0) {
        if (v.length > 300 || !v.startsWith('Mozilla/5.0')) {
          throw new Error('UA 格式无效（应以 Mozilla/5.0 开头，长度 ≤ 300）');
        }
        setFetchUA(v);
      } else {
        setFetchUA(null);
      }
      return { ua: getUA() };
    },
  );

  // webview 编码切换：给指定 session 重写 Content-Type charset
  safeHandleWithMeta(
    ipcMain,
    'pom:set-webview-encoding',
    'SetWebviewEncodingArgsSchema',
    SetWebviewEncodingArgsSchema,
    async (_e, [webviewId, mode]) => {
      // 渲染进程侧用 webview.partition 隔离 session；这里按 webviewId 解析
      // 简化实现：mode=auto 时移除拦截器，否则重写 charset
      const ses = session.fromPartition(`persist:${webviewId}`);
      // webRequest 在部分 session（如未初始化的自定义 partition / 老版本 Electron）上不存在，
      // 必须可选链访问 —— 直接 ses.webRequest.onHeadersReceived 会抛 TypeError 并把 IPC 打挂
      const wr = ses.webRequest;
      if (wr && typeof wr.onHeadersReceived === 'function') {
        wr.onHeadersReceived(
          { urls: ['*://*/*'] },
          (
            details: { responseHeaders?: Record<string, string[]> },
            callback: (r: { responseHeaders?: Record<string, string[]> }) => void,
          ) => {
            if (mode === 'auto') {
              callback({});
              return;
            }
            const respHeaders = { ...details.responseHeaders };
            respHeaders['content-type'] = [`text/html; charset=${mode}`];
            callback({ responseHeaders: respHeaders });
          },
        );
      }
    },
  );
}
