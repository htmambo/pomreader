import { IpcMain, net } from 'electron';
import { URL } from 'url';
import { decodeBuffer, EncodingMode } from './encoding';
import { isCfChallenge } from './cf-guard';
import { getFetchSession, getUA, defaultUA, setFetchUA, browserHeaders } from './fetch-session';
// 循环 import（render-handler ↔ fetch-handler）：cfFetchHtmlHidden 仅在函数调用期解析
import { cfFetchHtmlHidden } from './render-handler';

const FETCH_TIMEOUT_MS = 15000;
const MAX_BYTES = 8 * 1024 * 1024; // 8MB 响应上限，防内存爆炸

/** SSRF 防护：拒绝内网地址 */
export function isPrivateHost(host: string): boolean {
  if (host === 'localhost' || host === '::1') return true;
  if (/^127\./.test(host)) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true;
  if (/^::ffff:/.test(host)) return isPrivateHost(host.slice(7));
  return false;
}

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

function doFetch(rawUrl: string, mode: EncodingMode): Promise<FetchResult> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: FetchResult) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };

    // 共享持久 session：真 Chrome TLS 指纹 + cf_clearance cookie 与渲染/过盾链路共享；
    // 类浏览器请求头 + Referer 留痕（模拟站内导航，非凭空深链请求）
    const req = net.request({ url: rawUrl, redirect: 'follow', session: getFetchSession() });
    for (const [k, v] of Object.entries(browserHeaders(rawUrl, { navigation: true }))) {
      try { req.setHeader(k, v); } catch { /* 个别受限 header 跳过 */ }
    }

    const chunks: Buffer[] = [];

    req.on('response', (resp) => {
      // 响应头在 response 事件即可读取（end 后 resp 仍可访问，但提前归一化供 CF 判定）
      const status = resp.statusCode;
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(resp.headers)) {
        if (typeof v === 'string') headers[k.toLowerCase()] = v;
        else if (Array.isArray(v)) headers[k.toLowerCase()] = v.join(', ');
      }
      let size = 0;
      resp.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_BYTES) {
          try { req.abort(); } catch { /* noop */ }
          done({ error: 'parse-failed' });
          return;
        }
        chunks.push(c);
      });
      resp.on('end', () => {
        try {
          const buf = Buffer.concat(chunks);
          const html = decodeBuffer(buf, mode, resp.headers);
          if (isCfChallenge(status, headers, html.slice(0, 4096))) {
            done({ error: 'cf-challenge' });
            return;
          }
          done({ html });
        } catch {
          done({ error: 'parse-failed' });
        }
      });
    });

    req.on('error', () => done({ error: 'source-unavailable' }));

    const timer = setTimeout(() => {
      try {
        req.abort();
      } catch {
        /* noop */
      }
      done({ error: 'timeout' });
    }, FETCH_TIMEOUT_MS);

    req.on('close', () => clearTimeout(timer));

    req.end();
  });
}

export function registerFetchHandler(ipcMain: IpcMain): void {
  ipcMain.handle(
    'pom:fetch-html',
    async (_e, rawUrl: string, mode: EncodingMode = 'auto') => {
      if (!validateUrl(rawUrl)) {
        return { error: 'invalid-url' };
      }

      let res = await doFetch(rawUrl, mode);
      // CF 挑战页 → 隐藏窗口真实加载 + 等待挑战消失 + 提取渲染 HTML
      // （浏览器能打开即视为过盾成功；99csw 这类 managed challenge 自动通过，
      //  交互式 Turnstile 则 20s 超时返回 null → 仍报错引导用户人工验证）
      if (res.error === 'cf-challenge') {
        const html = await cfFetchHtmlHidden(rawUrl);
        if (html) return { html };
      }
      return res;
    }
  );

  // 抓取 UA 设置（设置页）：读取当前生效值 + 默认值；设置自定义 UA（null/空 = 恢复默认）
  ipcMain.handle('pom:get-fetch-ua', () => ({ ua: getUA(), defaultUa: defaultUA() }));
  ipcMain.handle('pom:set-fetch-ua', (_e, ua: string | null) => {
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
  });

  // webview 编码切换：给指定 session 重写 Content-Type charset
  ipcMain.handle(
    'pom:set-webview-encoding',
    async (_e, webviewId: string, mode: EncodingMode) => {
      // 渲染进程侧用 webview.partition 隔离 session；这里按 webviewId 解析
      // 简化实现：mode=auto 时移除拦截器，否则重写 charset
      const { session } = require('electron');
      const ses = session.fromPartition(`persist:${webviewId}`);
      if (ses.webRequest.onHeadersReceived) {
        ses.webRequest.onHeadersReceived(
          { urls: ['*://*/*'] },
          (details: { responseHeaders?: Record<string, string[]> }, callback: (r: { responseHeaders?: Record<string, string[]> }) => void) => {
            if (mode === 'auto') {
              callback({});
              return;
            }
            const respHeaders = { ...details.responseHeaders };
            respHeaders['content-type'] = [`text/html; charset=${mode}`];
            callback({ responseHeaders: respHeaders });
          }
        );
      }
    }
  );
}
