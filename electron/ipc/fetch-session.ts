/**
 * 抓取链路共享 session 与统一 UA（Cloudflare 分层过盾 Tier 0）
 * - UA 全应用注入：app.userAgentFallback（所有窗口/请求兜底）+ defaultSession
 *  （主窗口、<img> 封面、renderer fetch 降级）+ persist:fetch 共享 session
 *  （net.request / 隐藏渲染窗口 / 验证窗口 / 万能搜索 webview）
 * - cf_clearance 绑定 UA，所有链路必须使用同一 UA
 * - UA 可在设置页自定义（渲染端持久化，启动时经 pom:set-fetch-ua 推送到主进程）；
 *   默认按平台生成 Chrome/152（含 OS 与架构信息）
 */
import { app, session } from 'electron';

export const FETCH_PARTITION = 'persist:fetch';

const CHROME_VERSION = '152.0.0.0';

/** 默认 UA：Chrome/152 + 平台 OS/架构信息 */
export function defaultUA(): string {
  switch (process.platform) {
    case 'win32':
      return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VERSION} Safari/537.36`;
    case 'darwin':
      return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VERSION} Safari/537.36`;
    default:
      return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VERSION} Safari/537.36`;
  }
}

/** 用户自定义 UA（设置页推送；null = 用默认） */
let customUA: string | null = null;

/** 全链路统一 UA：自定义优先，否则平台默认 */
export function getUA(): string {
  return customUA ?? defaultUA();
}

/** 设置自定义 UA（null/空串 = 恢复默认）；立即全应用生效（新导航/新请求） */
export function setFetchUA(ua: string | null): void {
  const v = (ua ?? '').trim();
  customUA = v.length > 0 ? v : null;
  applyUaEverywhere();
}

/**
 * UA 注入应用各个角落：
 * - app.userAgentFallback：所有未显式设置 UA 的窗口/请求的兜底
 * - defaultSession：主窗口、封面 <img>、renderer fetch 降级链路
 * - persist:fetch 共享 session：net.request、隐藏渲染窗口、验证窗口、万能搜索 webview
 * （webview 等已打开页面需重新导航才用新 UA；net.request 立即生效）
 */
export function applyUaEverywhere(): void {
  app.userAgentFallback = getUA();
  session.defaultSession.setUserAgent(getUA());
  session.fromPartition(FETCH_PARTITION).setUserAgent(getUA());
}

/** 抓取共享 session 单例（session.fromPartition 本身即单例缓存） */
export function getFetchSession(): ReturnType<typeof session.fromPartition> {
  return session.fromPartition(FETCH_PARTITION);
}

/**
 * 类浏览器请求头（浏览行为"留痕"：让 net.request 的请求指纹接近真实浏览器导航，
 * 而不是凭空冒出来的裸请求 —— CF 等反爬会校验 sec-ch-ua / Sec-Fetch-* / Referer 链）
 * - sec-ch-ua 版本从当前 UA 提取（自定义 UA 改版本号时保持一致）、平台随 OS
 * - navigation=true（HTML 文档请求）：带 Upgrade-Insecure-Requests + Sec-Fetch-* 导航语义
 * - Referer 缺省用站点首页（模拟站内点击深链；调用方显式传入则优先）
 * - 不设置 Accept-Encoding：Chromium 网络栈自动协商并解压，手动设置会拿到压缩字节流
 */
export function browserHeaders(
  rawUrl: string,
  opts?: { referer?: string; navigation?: boolean }
): Record<string, string> {
  const ua = getUA();
  const ver = /Chrome\/(\d+)/.exec(ua)?.[1] ?? '152';
  const platform = process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux';
  let origin = '';
  try {
    origin = new URL(rawUrl).origin + '/';
  } catch { /* 非法 URL 由调用方校验 */ }
  const referer = opts?.referer ?? origin;
  const navigation = opts?.navigation ?? false;

  const h: Record<string, string> = {
    'User-Agent': ua,
    'Accept': navigation
      ? 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
      : '*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'sec-ch-ua': `"Chromium";v="${ver}", "Google Chrome";v="${ver}", "Not_A Brand";v="24"`,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': `"${platform}"`,
  };
  if (navigation) {
    h['Upgrade-Insecure-Requests'] = '1';
    h['Sec-Fetch-Dest'] = 'document';
    h['Sec-Fetch-Mode'] = 'navigate';
    h['Sec-Fetch-Site'] = 'same-origin';
    h['Sec-Fetch-User'] = '?1';
  }
  if (referer) h['Referer'] = referer;
  return h;
}

/**
 * 一次性迁移：万能搜索 webview 曾使用独立 session（persist:universal-search），
 * 用户在其中手动过盾的 cf_clearance 困在旧 cookie 罐里 —— 启动时拷贝到共享 session。
 * 幂等（cookies.set 同名覆盖），单个 cookie 失败不影响其余。
 */
export async function migrateLegacySearchCookies(): Promise<void> {
  try {
    const legacy = session.fromPartition('persist:universal-search');
    const cookies = await legacy.cookies.get({});
    if (cookies.length === 0) return;
    const target = getFetchSession();
    let migrated = 0;
    for (const c of cookies) {
      try {
        const host = c.domain?.replace(/^\./, '');
        if (!host) continue;
        await target.cookies.set({
          url: `${c.secure ? 'https' : 'http'}://${host}${c.path || '/'}`,
          name: c.name,
          value: c.value,
          ...(c.domain ? { domain: c.domain } : {}),
          path: c.path || '/',
          secure: !!c.secure,
          httpOnly: !!c.httpOnly,
          ...(c.expirationDate ? { expirationDate: c.expirationDate } : {}),
        });
        migrated++;
      } catch { /* 单个 cookie 非法/过期，跳过 */ }
    }
    if (migrated > 0) console.log(`[fetch-session] 已从 persist:universal-search 迁移 ${migrated} 个 cookie`);
  } catch (e) {
    console.warn('[fetch-session] cookie 迁移失败（忽略）:', (e as Error).message);
  }
}

