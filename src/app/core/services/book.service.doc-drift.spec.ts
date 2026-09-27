import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Round 7 P0-1 mitigation + Round 8 加固：JSDoc 4 要素契约漂移检测
 *
 * 防止 R6-2 / R6-3 JSDoc mitigation 被静默删除：
 * - book.service.ts:114-135 必须保留 HT-1 4 要素模板（state / reason / unblock / steps）
 * - book.service.ts:392-411 必须保留 R6-1 双写契约注释
 *
 * Round 8 加固（应对 P0-1 格式化/路径/语义三重）：
 *   - 路径用 import.meta.url + fileURLToPath（CWD 独立）
 *   - 正则 dotAll 模式（/s flag）—— 跨行 marker 不被换行 false-negative
 *   - marker 锚定到 token 而非整行
 *
 * 本 spec 是 contract test —— 文档化规约的"可执行等价物"。
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const BOOK_SERVICE = readFileSync(join(__dirname, './book.service.ts'), 'utf-8');

describe('BookService JSDoc 契约漂移检测 (R6-2 / R6-3 mitigation guard)', () => {
  describe('HT-1 半委托状态文档（R6-2）', () => {
    it('应保留 HT-1 标题 + 4 要素模板标记', () => {
      // dotAll 模式 (/s) 让 ^...$ 跨行匹配；marker 锚定 token 而非整行
      expect(BOOK_SERVICE).toMatch(/##\s*HT-1\s+DEFERRED/s);
      expect(BOOK_SERVICE).toMatch(/half-migrated\s+state/s);
      expect(BOOK_SERVICE).toMatch(/\*\*阻塞原因\*\*/s);
      expect(BOOK_SERVICE).toMatch(/\*\*解阻塞条件\*\*:?\s*HT-3\s+TestBed/s);
      expect(BOOK_SERVICE).toMatch(/\*\*迁移步骤\*\*/s);
      expect(BOOK_SERVICE).toMatch(/\*\*回归矩阵\*\*/s);
    });

    it('应明确列出 4 个未委托的 facade 方法名', () => {
      // 防止 JSDoc 被裁剪为通用描述，丢失具体方法名清单
      expect(BOOK_SERVICE).toMatch(/importOnlineBook/s);
      expect(BOOK_SERVICE).toMatch(/changeBookSource/s);
      expect(BOOK_SERVICE).toMatch(/refreshChapters/s);
      expect(BOOK_SERVICE).toMatch(/refreshBookInfo/s);
    });

    it('应引用 @see HT-3 ticket 链接', () => {
      expect(BOOK_SERVICE).toMatch(/@see\s+HT-3/s);
    });
  });

  describe('forTest stub 双写契约文档（R6-1）', () => {
    it('应保留 db-first / mirror-second 注释', () => {
      expect(BOOK_SERVICE).toMatch(/db-first/s);
      expect(BOOK_SERVICE).toMatch(/mirror-second/s);
    });

    it('应明确错误传播语义（db 抛错 → 测试失败）', () => {
      expect(BOOK_SERVICE).toMatch(/db\s*抛错/s);
      expect(BOOK_SERVICE).toMatch(/测试即失败/s);
    });

    it('应引用 R6-1 review 标识', () => {
      expect(BOOK_SERVICE).toMatch(/R6-1/s);
    });
  });

  describe('forTest shape 断言（Round 7 P1-1）', () => {
    it('应保留 assertBookServiceShape 工具函数', () => {
      expect(BOOK_SERVICE).toMatch(/assertBookServiceShape/s);
    });
  });
});