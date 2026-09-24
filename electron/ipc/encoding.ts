import iconv from 'iconv-lite';

export type EncodingMode = 'auto' | 'utf-8' | 'gbk';

/**
 * 解码抓取到的 bytes
 * 优先级：指定 mode > Content-Type charset > HTML meta 探测 > utf-8 默认
 */
export function decodeBuffer(
  buf: Buffer,
  mode: EncodingMode,
  headers: Record<string, string | string[] | undefined>
): string {
  if (mode === 'utf-8') return iconv.decode(buf, 'utf-8');
  if (mode === 'gbk') return iconv.decode(buf, 'gb18030'); // gb18030 是 GBK 超集，含繁体/日元

  // auto: Content-Type charset > meta charset > utf-8
  const ctCharset = parseCharsetFromHeaders(headers);
  if (ctCharset) return iconv.decode(buf, ctCharset);

  const metaCharset = detectMetaCharset(buf);
  if (metaCharset) return iconv.decode(buf, metaCharset);

  return iconv.decode(buf, 'utf-8');
}

function parseCharsetFromHeaders(
  headers: Record<string, string | string[] | undefined>
): string | null {
  const ct = headers['content-type'];
  if (!ct) return null;
  const raw = Array.isArray(ct) ? ct[0] : ct;
  const m = /charset=([^\s;]+)/i.exec(raw);
  if (!m) return null;
  return normalizeEncoding(m[1]);
}

/** 扫 HTML 前 1KB 找 <meta charset=...> 或 http-equiv Content-Type */
function detectMetaCharset(buf: Buffer): string | null {
  // 先按 ascii 读头部探测 meta（避免用错误编码解码全文）
  const head = buf.subarray(0, 1024).toString('latin1');
  const m1 = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head);
  if (m1) return normalizeEncoding(m1[1]);
  const m2 = /<meta[^>]+content=["'][^"']*charset=([\w-]+)/i.exec(head);
  if (m2) return normalizeEncoding(m2[1]);
  return null;
}

function normalizeEncoding(raw: string): string | null {
  const e = raw.toLowerCase().trim();
  if (e === 'utf-8' || e === 'utf8') return 'utf-8';
  if (e === 'gbk' || e === 'gb2312' || e === 'gb18030') return 'gb18030';
  if (iconv.encodingExists(e)) return e;
  return null;
}
