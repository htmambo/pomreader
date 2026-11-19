/**
 * 简繁转换（opencc-js 分方向懒加载 + 实例缓存）。
 *
 * 仅用于渲染层（阅读页 displayContent 管道），转换结果绝不写回书库/缓存，
 * 避免污染书源原文造成二次转换。
 *
 * **按方向分包**（性能）：
 *   opencc-js 的默认入口 `opencc-js` 同时打包两个方向（full ≈ 1.17MB）。
 *   而两个方向的词典体量极不对称：
 *     · 简→繁 `cn2t` ≈ 1.07MB —— 短语表 STPhrases 单文件就占 982KB
 *     · 繁→简 `t2cn` ≈ 107KB —— 只需 TSPhrases + TSCharacters
 *   分别 import 两个方向入口后，用户只下载自己选用的那一个 chunk
 *   （繁→简场景从 1.19MB 降到约 110KB，-91%）。
 *   两个方向的 `configs.s2t` / `configs.t2s` 与 full 完全一致，转换结果不变。
 *
 * 仍用通用繁体 't' 而非 'tw'：纯字形转换，不引入台湾惯用词差异（如 软件→軟體）。
 */
import type { ConvertMode } from '../models/settings.model';

export type ChineseConvertFn = (text: string) => string;
type ActiveConvertMode = Exclude<ConvertMode, 'off'>;

const LOCALES: Record<ActiveConvertMode, { from: 'cn' | 't'; to: 'cn' | 't' }> = {
  s2t: { from: 'cn', to: 't' },
  t2s: { from: 't', to: 'cn' },
};

/** 分方向入口的动态导入（每个方向独立成 chunk，按需下载） */
const LOADERS: Record<
  ActiveConvertMode,
  () => Promise<{ Converter: (options: { from: string; to: string }) => ChineseConvertFn }>
> = {
  s2t: () => import('opencc-js/cn2t'),
  t2s: () => import('opencc-js/t2cn'),
};

const cache = new Map<ActiveConvertMode, ChineseConvertFn>();
const pending = new Map<ActiveConvertMode, Promise<ChineseConvertFn>>();

/** 同步取已加载的转换器；未加载返回 null（调用方先渲染原文，加载完成后重算） */
export function getChineseConverter(mode: ActiveConvertMode): ChineseConvertFn | null {
  return cache.get(mode) ?? null;
}

/** 异步加载转换器（同档位并发共享一个 Promise；加载后永久缓存实例） */
export function loadChineseConverter(mode: ActiveConvertMode): Promise<ChineseConvertFn> {
  const hit = cache.get(mode);
  if (hit) return Promise.resolve(hit);
  let p = pending.get(mode);
  if (!p) {
    p = LOADERS[mode]()
      .then((m) => {
        const conv = m.Converter(LOCALES[mode]) as ChineseConvertFn;
        cache.set(mode, conv);
        pending.delete(mode);
        return conv;
      })
      .catch((err: unknown) => {
        pending.delete(mode);
        throw err;
      });
    pending.set(mode, p);
  }
  return p;
}
