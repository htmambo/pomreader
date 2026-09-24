import { BookSourceConfig } from './book-source.adapter';

/**
 * 内置适配器（笔趣阁）的编码 + 选择器规则配置（spec §4.4）
 *
 * ⚠️ 选择器基于站点 DOM 推断，需实现时抓真实 fixture 验证后修正。
 *    失效时只改本文件一处，不动适配器逻辑。
 *
 * 站点编码：笔趣阁 utf-8。
 * 其他站点走通用启发式（heuristic.adapter.ts）兜底，不再维护固定配置。
 */
export const SOURCE_CONFIG: Record<string, BookSourceConfig> = {
  xbiquge: {
    encoding: 'utf-8',
    catalogSelector: '#list dl dd a',
    titleSelector: '#info h1',
    authorSelector: '#info p',
    contentSelector: '#content',
  },
};
