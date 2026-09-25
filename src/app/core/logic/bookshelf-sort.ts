import { Book } from '../models/book.model';
import { BookshelfSort } from '../models/settings.model';

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
      return list.sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'));
    case 'imported':
    default:
      return list.sort((a, b) => (b.importedAt ?? '').localeCompare(a.importedAt ?? ''));
  }
}
