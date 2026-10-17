export type TxtEncodingMode = 'auto' | 'utf-8' | 'gbk';

export type TxtEncoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'gb18030';

export interface DecodedTxt {
  text: string;
  /** 实际解码所用编码 */
  encoding: TxtEncoding;
}

/**
 * 解码本地 TXT 字节流
 * auto: BOM 嗅探 > UTF-16 启发式 > 严格 UTF-8 尝试 > 回退 GB18030（GBK/GB2312 超集）
 */
export function decodeTxtBuffer(buf: ArrayBuffer, mode: TxtEncodingMode = 'auto'): DecodedTxt {
  const bytes = new Uint8Array(buf);
  if (mode === 'utf-8') return { text: new TextDecoder('utf-8').decode(bytes), encoding: 'utf-8' };
  if (mode === 'gbk') {
    // 与 utf-8 模式对齐：剥离 UTF-8 BOM，避免解码出 "锘" 前缀
    const body = hasUtf8Bom(bytes) ? bytes.subarray(3) : bytes;
    return { text: new TextDecoder('gb18030').decode(body), encoding: 'gb18030' };
  }

  const bom = sniffBom(bytes);
  if (bom) return { text: new TextDecoder(bom).decode(bytes), encoding: bom };

  // 无 BOM 的 UTF-16 全是合法 UTF-8 单字节（0x00），严格校验不会拦截，需先按 NUL 分布探测
  const u16 = looksLikeUtf16(bytes);
  if (u16) return { text: new TextDecoder(u16).decode(bytes), encoding: u16 };

  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { text, encoding: 'utf-8' };
  } catch (e) {
    // fatal 模式下非法字节序列抛 TypeError；其它异常（如 detached buffer）照常上抛
    if (!(e instanceof TypeError)) throw e;
    return { text: new TextDecoder('gb18030').decode(bytes), encoding: 'gb18030' };
  }
}

function hasUtf8Bom(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
}

function sniffBom(bytes: Uint8Array): TxtEncoding | null {
  if (hasUtf8Bom(bytes)) return 'utf-8';
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    // FF FE 00 00 是 UTF-32LE BOM，不能按 utf-16le 解码
    if (bytes.length >= 4 && bytes[2] === 0 && bytes[3] === 0) return null;
    return 'utf-16le';
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
  return null;
}

/**
 * 采样前 4KB，按 NUL 字节奇偶分布判断无 BOM 的 UTF-16（奇偶悬殊 + 占比 >5%）
 * GBK/UTF-8 文本几乎不含 NUL，误报面极窄；5% 阈值约合 ASCII 占比 ≳10%，可覆盖中英混排
 * 已知盲区：ASCII 占比过低的无 BOM UTF-16 检测不到，需用户另存为 UTF-8 或带 BOM 的文件
 */
function looksLikeUtf16(bytes: Uint8Array): 'utf-16le' | 'utf-16be' | null {
  const n = Math.min(bytes.length, 4096) & ~1;
  if (n < 8) return null;
  let evenNul = 0;
  let oddNul = 0;
  for (let i = 0; i < n; i += 2) {
    if (bytes[i] === 0) evenNul++;
    if (bytes[i + 1] === 0) oddNul++;
  }
  const pairs = n / 2;
  // 不能用 evenNul === 0：U+5F00(开)/U+7000 等汉字低字节即 0x00；改用奇偶悬殊判定
  if (oddNul > pairs * 0.05 && oddNul > evenNul * 10) return 'utf-16le';
  if (evenNul > pairs * 0.05 && evenNul > oddNul * 10) return 'utf-16be';
  return null;
}
