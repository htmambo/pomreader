import { IpcMain, net } from 'electron';
import { URL } from 'url';
import { decodeBuffer, EncodingMode } from './encoding';

const FETCH_TIMEOUT_MS = 15000;
const MAX_BYTES = 8 * 1024 * 1024; // 8MB 响应上限，防内存爆炸
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';

/** SSRF 防护：拒绝内网地址 */
function isPrivateHost(host: string): boolean {
  if (host === 'localhost' || host === '::1') return true;
  if (/^127\./.test(host)) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true;
  if (/^::ffff:/.test(host)) return isPrivateHost(host.slice(7));
  return false;
}

export function registerFetchHandler(ipcMain: IpcMain): void {
  ipcMain.handle(
    'pom:fetch-html',
    async (_e, rawUrl: string, mode: EncodingMode = 'auto') => {
      let u: URL;
      try {
        u = new URL(rawUrl);
      } catch {
        return { error: 'invalid-url' };
      }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        return { error: 'invalid-url' };
      }
      if (isPrivateHost(u.hostname)) {
        return { error: 'invalid-url' };
      }

      return new Promise((resolve) => {
        let settled = false;
        const done = (r: { html?: string; error?: string }) => {
          if (!settled) {
            settled = true;
            resolve(r);
          }
        };

        const req = net.request({ url: rawUrl, redirect: 'follow' });
        req.setHeader('User-Agent', UA);
        req.setHeader('Accept', 'text/html,application/xhtml+xml,*/*;q=0.8');
        req.setHeader('Accept-Language', 'zh-CN,zh;q=0.9,en;q=0.8');

        const chunks: Buffer[] = [];

        req.on('response', (resp) => {
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
