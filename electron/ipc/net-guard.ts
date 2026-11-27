/**
 * SSRF 防护叶子模块：不 import 任何 ipc 兄弟模块，供 fetch/render/cf-guard/safe-net 共用。
 * （原定义在 fetch-handler.ts，导致 render-handler / cf-guard / safe-net 反向 import 成环）
 *
 * 为什么不用简单正则：
 * - Node 的 `URL.hostname` 对 IPv6 返回**带方括号**的字符串（`[::1]`），
 *   `host === '::1'` / `^::ffff:` 永远不会命中；
 * - `::ffff:127.0.0.1` 会被 URL 规范化成 `[::ffff:7f00:1]`（十六进制形式）；
 * - `0.0.0.0`、`fe80::/10`、`fc00::/7`、`100.64/10` 等同样需要覆盖。
 * 因此这里统一解析为字节序列再判定。
 */

function parseIPv4(host: string): number[] | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const nums: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n < 0 || n > 255) return null;
    nums.push(n);
  }
  return nums;
}

function isPrivateIPv4(octets: number[]): boolean {
  const [a, b, c] = octets;
  if (a === 0) return true; // 0.0.0.0/8（含 "本机" 语义）
  if (a === 10) return true; // RFC 1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC 1918
  if (a === 192 && b === 168) return true; // RFC 1918
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 192 && b === 0 && c === 0) return true; // IETF 协议分配 192.0.0/24
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking 198.18/15
  if (a >= 224) return true; // multicast 224/4 + reserved 240/4
  return false;
}

/** 展开 IPv6 为 16 字节；非法返回 null（支持 `::` 缩写与内嵌 IPv4） */
function expandIPv6(input: string): number[] | null {
  let h = input.toLowerCase();
  if (h.includes('.')) {
    // 内嵌 IPv4（::ffff:127.0.0.1）→ 末尾两段换成两个 hextet
    const idx = h.lastIndexOf(':');
    if (idx < 0) return null;
    const v4 = parseIPv4(h.slice(idx + 1));
    if (!v4) return null;
    h =
      h.slice(0, idx + 1) +
      (((v4[0] << 8) | v4[1]).toString(16) + ':' + ((v4[2] << 8) | v4[3]).toString(16));
  }
  const halves = h.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1 && head.length !== 8) return null;
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  const groups = [...head, ...Array.from({ length: missing }, () => '0'), ...tail];
  if (groups.length !== 8) return null;
  const bytes: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    const n = parseInt(g, 16);
    bytes.push((n >> 8) & 0xff, n & 0xff);
  }
  return bytes;
}

function isPrivateIPv6(bytes: number[]): boolean {
  // :: 与 ::1
  if (bytes.every((b) => b === 0)) return true;
  if (bytes.slice(0, 15).every((b) => b === 0) && bytes[15] === 1) return true;
  // IPv4-mapped ::ffff:a.b.c.d
  if (bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return isPrivateIPv4(bytes.slice(12));
  }
  // IPv4-compatible（已废弃的 ::a.b.c.d）一律视为私网
  if (bytes.slice(0, 12).every((b) => b === 0)) return true;
  // 6to4 2002::/16 —— 内嵌 IPv4 位于第 3-6 字节
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return isPrivateIPv4(bytes.slice(2, 6));
  // NAT64 64:ff9b::/96 —— 内嵌 IPv4 位于最后 4 字节
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b) {
    return isPrivateIPv4(bytes.slice(12));
  }
  // link-local fe80::/10
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true;
  // unique local fc00::/7
  if ((bytes[0] & 0xfe) === 0xfc) return true;
  // multicast ff00::/8
  if (bytes[0] === 0xff) return true;
  return false;
}

/** SSRF 防护：拒绝内网地址（IPv4 私网 + IPv6 loopback/link-local/unique-local/multicast） */
export function isPrivateHost(host: string): boolean {
  if (!host) return true;
  let h = host.trim().toLowerCase();
  // URL.hostname 的 IPv6 形式带方括号；zone id（fe80::1%eth0）一并剥离
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  const zone = h.indexOf('%');
  if (zone >= 0) h = h.slice(0, zone);
  // 去掉 FQDN 尾部点；Chromium 会把 *.localhost 一律解析到 127.0.0.1
  if (h.endsWith('.')) h = h.slice(0, -1);
  if (h === 'localhost' || h.endsWith('.localhost')) return true;

  const v4 = parseIPv4(h);
  if (v4) return isPrivateIPv4(v4);

  const v6 = expandIPv6(h);
  if (v6) return isPrivateIPv6(v6);

  return false;
}
