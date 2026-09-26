/**
 * 共享 SSRF-safe HTTP 请求工具（fetch-handler 模式抽离）
 * 复用 isPrivateHost + UA + net.request + encoding 解码
 *
 * Round 6 增量：HTTP 代理配置 schema 落地（DM-13）
 * - v1 仅 schema 落地 + 默认 undefined（零行为变化）
 * - 调用方传入 `options.proxy` 时按 `enabled && url` 走 session.setProxy
 * - v1.1 补 UI + 持久化（DM-14）
 *
 * Round 7 hardening:
 * - Electron `net.request` 不支持 `proxyRules` 字段（必须通过 `Session` 设置）
 * - 使用 `session.fromPartition('safe-net-proxy')` + `setProxy({ proxyRules })` 单例缓存
 * - bypass 列表大小写不敏感（hostname DNS 规范）
 */
import { net, session as electronSession } from 'electron';
import { URL } from 'url';
import { decodeBuffer, EncodingMode } from './encoding';
import { isPrivateHost, UA } from './fetch-handler';
import { getFetchSession } from './fetch-session';

/** HTTP 代理配置（DM-13 schema，v1 落地） */
export interface ProxyConfig {
  enabled: boolean;
  /** "http://127.0.0.1:7890" 或 "socks5://..." */
  url?: string;
  /** 直连名单（hostname 精确匹配） */
  bypass?: string[];
}

export interface SafeNetOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | null;
  timeoutMs?: number;
  /** 默认 8MB，与 fetch-handler 一致 */
  maxBytes?: number;
  /** 编码模式；仅 text-like 响应生效 */
  encoding?: EncodingMode;
  /** Accept 默认值 */
  accept?: string;
  /** HTTP 代理配置（DM-13）。undefined / enabled=false → 走直连 */
  proxy?: ProxyConfig;
}

export interface SafeNetResult {
  status: number;
  headers: Record<string, string>;
  body: string;
  bytes: Buffer;
}

const DEFAULT_MAX = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT = 15000;
const MAX_REDIRECTS = 3;

/** 检查 URL 是否应绕过代理（bypass 列表命中 — 大小写不敏感） */
function shouldBypassProxy(rawUrl: string, bypass?: string[]): boolean {
  if (!bypass || bypass.length === 0) return false;
  try {
    const u = new URL(rawUrl);
    const hostname = u.hostname.toLowerCase();
    return bypass.some((h) => h.toLowerCase() === hostname);
  } catch {
    return false;
  }
}

/** 代理 session 单例缓存 — 不同 proxyUrl 不同 partition（Round 8 防并发竞态）
 * - 缓存 Promise 而非 Session，防止并发请求 A/B 同时 setProxy 互相覆盖
 * - 不同 proxyUrl 隔离 partition，避免互相污染代理规则
 */
const proxySessionCache = new Map<string, ReturnType<typeof electronSession.fromPartition>>();

async function getProxySession(proxyUrl: string): Promise<ReturnType<typeof electronSession.fromPartition>> {
  if (proxySessionCache.has(proxyUrl)) return proxySessionCache.get(proxyUrl)!;
  const partition = `safe-net-proxy-${encodeURIComponent(proxyUrl)}`;
  const session = electronSession.fromPartition(partition);
  // 将 proxyUrl 转换为 Chromium proxyRules 格式（Round 8 修复 P1-1）
  const proxyRules = toProxyRules(proxyUrl);
  await session.setProxy({ proxyRules });
  proxySessionCache.set(proxyUrl, session);
  return session;
}

/** 标准 URL → Chromium proxyRules 格式
 * - 'http://127.0.0.1:8080' → 'http=127.0.0.1:8080;https=127.0.0.1:8080'
 * - 'socks5://127.0.0.1:1080' → 'socks5=127.0.0.1:1080'
 * - 已含 '=' 且无 '://' 的字符串（用户手动配置）原样透传
 * - Round 9 强化：catch 分支改为 throw（避免 Chromium 静默直连导致 IP 泄露）
 */
function toProxyRules(proxyUrl: string): string {
  // proxyRules 格式特征：scheme=host 且无 "://"
  if (proxyUrl.includes('=') && !proxyUrl.includes('://')) return proxyUrl;
  let u: URL;
  try {
    u = new URL(proxyUrl);
  } catch {
    throw new Error(`Invalid proxy URL "${proxyUrl}": not a valid URL`);
  }
  const { protocol, hostname, port } = u;
  if (!hostname) throw new Error(`Invalid proxy URL "${proxyUrl}": missing hostname`);
  const hostPort = port ? `${hostname}:${port}` : hostname;
  const scheme = protocol.replace(':', '');
  if (scheme === 'http' || scheme === 'https') {
    // HTTP/HTTPS 代理：同时代理 http 和 https
    return `${scheme}=${hostPort};${scheme === 'http' ? 'https' : 'http'}=${hostPort}`;
  }
  if (scheme === 'socks4' || scheme === 'socks5' || scheme === 'socks') {
    return `${scheme === 'socks' ? 'socks5' : scheme}=${hostPort}`;
  }
  throw new Error(`Unsupported proxy scheme: ${scheme}`);
}

/** 通用 SSRF-safe HTTP 请求（书源代理 / 封面 / 市场共用） */
export async function safeNetRequest(
  rawUrl: string,
  options: SafeNetOptions = {}
): Promise<SafeNetResult> {
  // Round 2 hardening: 手动跟踪重定向，每次 isPrivateHost 校验
  return followRedirect(rawUrl, options, 0);
}

async function followRedirect(
  rawUrl: string,
  options: SafeNetOptions,
  depth: number
): Promise<SafeNetResult> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return Promise.reject(new Error('invalid-url'));
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return Promise.reject(new Error('invalid-url'));
  }
  if (isPrivateHost(u.hostname)) {
    return Promise.reject(new Error('invalid-url'));
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX;
  const method = (options.method || 'GET').toUpperCase();

  return new Promise(async (resolve, reject) => {
    let settled = false;
    /** Round 3 hardening: 联合类型显式判别（避免正常响应对象误判含 'error' 字段） */
    type FollowResult = { ok: true; resp: SafeNetResult } | { ok: false; error: string };
    const done = (r: FollowResult): void => {
      if (settled) return;
      settled = true;
      if (r.ok) resolve(r.resp);
      else reject(new Error(r.error));
    };

    // 直连走抓取共享 session（persist:fetch，CF cookie 互通）；代理 session 在顶层 await（executor 标 async 后可 await）
    let requestSession: ReturnType<typeof electronSession.fromPartition> | undefined = getFetchSession();
    if (options.proxy?.enabled && options.proxy.url && !shouldBypassProxy(rawUrl, options.proxy.bypass)) {
      try {
        requestSession = await getProxySession(options.proxy.url);
      } catch (e) {
        done({ ok: false, error: `proxy setup failed: ${(e as Error).message}` });
        return;
      }
    }

    // Round 2 hardening: redirect: 'manual' — 拦截 3xx 跳转，每次重新校验 isPrivateHost
    const req = net.request({ url: rawUrl, method, redirect: 'manual', session: requestSession });
    req.setHeader('User-Agent', UA);
    req.setHeader('Accept', options.accept ?? '*/*');
    if (options.headers) {
      for (const [k, v] of Object.entries(options.headers)) {
        try { req.setHeader(k, v); } catch { /* noop */ }
      }
    }
    if (method !== 'GET' && method !== 'HEAD' && options.body) {
      req.write(options.body);
    }

    const chunks: Buffer[] = [];
    req.on('response', (resp) => {
      const status = resp.statusCode;
      // 处理 3xx 重定向：手动跟踪，递归前 isPrivateHost 校验
      if (status >= 300 && status < 400) {
        aborted = true; // 标记主动 abort,避免 error 事件误报
        try { req.abort(); } catch { /* noop */ }
        if (depth >= MAX_REDIRECTS) {
          done({ ok: false, error: 'redirect-loop' });
          return;
        }
        const location = (resp.headers.location || resp.headers.Location) as string | string[] | undefined;
        const nextUrl = Array.isArray(location) ? location[0] : location;
        if (!nextUrl) { done({ ok: false, error: 'redirect-missing-location' }); return; }
        // 解析相对 URL（location 可能为相对路径）
        let resolved: string;
        try { resolved = new URL(nextUrl, rawUrl).toString(); }
        catch { done({ ok: false, error: 'redirect-invalid-url' }); return; }
        // 递归前不重新校验超时（沿用原 timeoutMs）
        followRedirect(resolved, options, depth + 1).then(
          (resp) => done({ ok: true, resp }),
          (e) => done({ ok: false, error: (e as Error).message }),
        );
        return;
      }
      let size = 0;
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(resp.headers)) {
        if (typeof v === 'string') headers[k.toLowerCase()] = v;
        else if (Array.isArray(v)) headers[k.toLowerCase()] = v.join(', ');
      }
      resp.on('data', (c: Buffer) => {
        size += c.length;
        if (size > maxBytes) {
          try { req.abort(); } catch { /* noop */ }
          done({ ok: false, error: 'parse-failed' });
          return;
        }
        chunks.push(c);
      });
      resp.on('end', () => {
        try {
          const buf = Buffer.concat(chunks);
          const body = decodeBuffer(
            buf,
            options.encoding ?? 'auto',
            resp.headers as Record<string, string | string[] | undefined>
          );
          done({ ok: true, resp: { status, headers, body, bytes: buf } });
        } catch {
          done({ ok: false, error: 'parse-failed' });
        }
      });
    });

    let aborted = false; // 标记是否主动 abort(redirect manual 模式),防止 abort 后 error 事件被当真错误上报
    req.on('error', (err) => {
      if (aborted) return; // 主动 abort 是预期行为,不报错
      // Round 12: 透传原始 error 信息(原统一归类为 'source-unavailable' 掩盖了 DNS/连接/超时等真实错误)
      // err.message 通常是 'net::ERR_NAME_NOT_RESOLVED' / 'net::ERR_CONNECTION_REFUSED' / 'net::ERR_INTERNET_DISCONNECTED' 等
      const msg = (err as { message?: string })?.message ?? 'source-unavailable';
      done({ ok: false, error: msg });
    });

    const timer = setTimeout(() => {
      try { req.abort(); } catch { /* noop */ }
      done({ ok: false, error: 'timeout' });
    }, timeoutMs);
    req.on('close', () => clearTimeout(timer));

    req.end();
  });
}