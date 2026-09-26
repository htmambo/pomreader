import { IpcMain, net } from 'electron';
import { URL } from 'url';
import { decodeBuffer, EncodingMode } from './encoding';
import { ensureCfClearance, isCfChallenge } from './cf-guard';
import { getFetchSession, UA } from './fetch-session';

// UA 唯一定义在 fetch-session（cf_clearance 绑定 UA，全链路一致），re-export 兼容既有 import
export { UA } from './fetch-session';

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

    // 共享持久 session：真 Chrome TLS 指纹 + cf_clearance cookie 与渲染/过盾链路共享
    const req = net.request({ url: rawUrl, redirect: 'follow', session: getFetchSession() });
    req.setHeader('User-Agent', UA);
    req.setHeader('Accept', 'text/html,application/xhtml+xml,*/*;q=0.8');
    req.setHeader('Accept-Language', 'zh-CN,zh;q=0.9,en;q=0.8');

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
      // Tier 1：CF 挑战页 → 隐藏窗口自动过盾（cf_clearance 落入共享 session）→ 重试一次
      if (res.error === 'cf-challenge') {
        const passed = await ensureCfClearance(rawUrl);
        if (passed) {
          res = await doFetch(rawUrl, mode);
        }
      }
      return res;
    }
  );

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
