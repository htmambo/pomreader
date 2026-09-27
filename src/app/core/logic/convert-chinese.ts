/**
 * 简繁转换（opencc-js 懒加载 + 实例缓存）。
 *
 * 仅用于渲染层（阅读页 displayContent 管道），转换结果绝不写回书库/缓存，
 * 避免污染书源原文造成二次转换。
 *
 * 词典体积较大（~1MB），必须经 import() 动态加载，只在 convertMode !== 'off' 时载入。
 * 用通用繁体 't' 而非 'tw'：纯字形转换，不引入台湾惯用词差异（如 软件→軟體）。
 */
import type { ConvertMode } from '../models/settings.model';

export type ChineseConvertFn = (text: string) => string;
type ActiveConvertMode = Exclude<ConvertMode, 'off'>;

const LOCALES: Record<ActiveConvertMode, { from: 'cn' | 't'; to: 'cn' | 't' }> = {
  s2t: { from: 'cn', to: 't' },
  t2s: { from: 't', to: 'cn' },
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
    p = import('opencc-js')
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
