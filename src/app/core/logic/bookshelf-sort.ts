import { type Book } from '../models/book.model';
import { type BookshelfSort } from '../models/settings.model';

/**
 * 中文排序比较器（模块级单例）。
 *
 * `String.prototype.localeCompare(x, 'zh-Hans-CN')` 每次调用都要走一遍 locale
 * 感知路径（V8 内部需查 ICU 排序表）。书架排序是 O(N log N) 次比较
 * （N=1000 时约 1 万次），且每次重渲染都会重排 —— 缓存一个 Collator 实例后
 * 复用其比较表，语义完全一致（同样按 zh-Hans-CN 拼音序）。
 */
const zhCollator = new Intl.Collator('zh-Hans-CN');

/**
 * 书架排序纯函数（设置页 bookshelfSort 对应的展示规则）
 * - imported：入库时间新 → 旧
 * - lastRead：最后阅读时间新 → 旧；从未读过的（无 lastReadAt）排在最后
 * - title：书名按中文拼音升序
 * 返回新数组，不改原列表（signal 不可变性）
 */
export function sortBooks(books: readonly Book[], sort: BookshelfSort): Book[] {
  const list = [...books];
  switch (sort) {
    case 'lastRead':
      // ISO 字符串可字典序比较；缺字段视为 ''（最小），desc 排后
      return list.sort((a, b) => (b.lastReadAt ?? '').localeCompare(a.lastReadAt ?? ''));
    case 'title':
      return list.sort((a, b) => zhCollator.compare(a.title, b.title));
    case 'imported':
    default:
      return list.sort((a, b) => (b.importedAt ?? '').localeCompare(a.importedAt ?? ''));
  }
}
