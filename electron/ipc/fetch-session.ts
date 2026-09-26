/**
 * 抓取链路共享 session 与统一 UA（Cloudflare 分层过盾 Tier 0）
 * - net.request / render 隐藏窗口 / 手动过盾窗口共用 persist:fetch 持久 session，
 *   cf_clearance 等 cookie 在三条链路间共享
 * - cf_clearance 绑定 UA，所有链路必须使用同一 UA（按平台生成真实 Chrome UA）
 */
import { session } from 'electron';

export const FETCH_PARTITION = 'persist:fetch';

const CHROME_VERSION = '152.0.0.0';

function buildUA(): string {
  switch (process.platform) {
    case 'win32':
      return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VERSION} Safari/537.36`;
    case 'darwin':
      return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VERSION} Safari/537.36`;
    default:
      return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VERSION} Safari/537.36`;
  }
}

export const UA = buildUA();

/** 抓取共享 session 单例（session.fromPartition 本身即单例缓存） */
export function getFetchSession(): ReturnType<typeof session.fromPartition> {
  return session.fromPartition(FETCH_PARTITION);
}
