import { GROUP_NAME_MAX } from '../models/bookshelf-group.model';
import { type BookshelfGroup } from '../models/bookshelf-group.model';

/**
 * 分类名校验（纯函数，供 service / dialog 共用，避免两处规则漂移）
 *
 * 规则：
 * - 去首尾空白后非空
 * - 长度 ≤ GROUP_NAME_MAX（中文按 1 计）
 * - 同名不允许（大小写不敏感 + 去空白后比较），排除自身由调用方传 existing
 */
export function validateGroupName(
  raw: string,
  existing: readonly BookshelfGroup[] = [],
  selfId?: string,
): { ok: true; name: string } | { ok: false; reason: string } {
  const name = raw.trim();
  if (!name) return { ok: false, reason: '分类名不能为空' };
  if ([...name].length > GROUP_NAME_MAX) {
    return { ok: false, reason: `分类名不能超过 ${GROUP_NAME_MAX} 个字` };
  }
  const dup = existing.some(
    (g) => g.id !== selfId && g.name.trim().toLowerCase() === name.toLowerCase(),
  );
  if (dup) return { ok: false, reason: `已存在同名分类「${name}」` };
  return { ok: true, name };
}

/** 新分类 id：优先 crypto.randomUUID，缺失（如老 webview）时退回时间戳 + 随机串 */
export function newGroupId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `g-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
