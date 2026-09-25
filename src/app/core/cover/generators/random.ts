/**
 * 导入兜底封面：从内置 20 款生成器中随机选一款渲染
 * 用途：local-txt / online 导入路径在 coverImageUrl 为空时给书籍配一张默认封面
 *
 * 注意：
 * - 用 Math.random 而不是 paletteFromBook 的 hashSeed —— 用户期望"每次导入新书封面不一样"
 * - 与「生成封面」对话框一致：调 generate({title, author, kind?})，kind 缺省时模板用自己的 fallback
 */
import { BUILTIN_COVER_GENERATORS } from './builtin';
import type { CoverBookInput } from './types';

export function randomCoverFor(book: CoverBookInput): string {
  const idx = Math.floor(Math.random() * BUILTIN_COVER_GENERATORS.length);
  const gen = BUILTIN_COVER_GENERATORS[idx];
  return gen.generate(book);
}
