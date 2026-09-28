import { IpcMain, net, session } from 'electron';
import { URL } from 'url';
import { decodeBuffer, EncodingMode } from './encoding';
import { isCfChallenge } from './cf-guard';
import { getFetchSession, getUA, defaultUA, setFetchUA, browserHeaders } from './fetch-session';
import { cfFetchHtmlHidden } from './render-handler';
import { isPrivateHost } from './net-guard';
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
      try {
        req.setHeader(k, v);
      } catch {
        /* 个别受限 header 跳过 */
      }
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
          try {
            req.abort();
          } catch {
            /* noop */
          }
          done({ error: 'parse-failed' });
          return;
        }
        chunks.push(c);
      });
      resp.on('end', () => {
        try {
          const buf = Buffer.concat(chunks as Uint8Array[]);
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
