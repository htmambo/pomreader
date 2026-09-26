/**
 * SSRF 防护叶子模块：不 import 任何 ipc 兄弟模块，供 fetch/render/cf-guard/safe-net 共用。
 * （原定义在 fetch-handler.ts，导致 render-handler / cf-guard / safe-net 反向 import 成环）
 */

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
