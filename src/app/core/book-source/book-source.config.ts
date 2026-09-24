import { BookSourceConfig } from './book-source.adapter';

/**
 * 6 书签站编码 + 选择器规则配置（spec §4.4）
 *
 * ⚠️ 选择器基于站点 DOM 推断，需实现时抓真实 fixture 验证后修正。
 *    失效时只改本文件一处，不动适配器逻辑。
 *
 * 站点编码固定：xbiquge/kehuan=utf-8，其余三站=gbk（国内古典/名著站多用 GBK）。
 * readers365 编码待 fixture 确认，暂定 gbk。
 */
export const SOURCE_CONFIG: Record<string, BookSourceConfig> = {
  xbiquge: {
    encoding: 'utf-8',
    // 笔趣阁目录：#list dl dd a（站点实际 DOM，待 fixture 确认）
    catalogSelector: '#list dl dd a',
    titleSelector: '#info h1',
    authorSelector: '#info p',
    contentSelector: '#content',
  },
  dushu369: {
    encoding: 'gbk',
    catalogSelector: '.booklist a',
    titleSelector: '.bookinfo h1',
    authorSelector: '.bookinfo .author',
    contentSelector: '#bookcontent',
  },
  guoxue123: {
    encoding: 'gbk',
    catalogSelector: '.book_list a',
    titleSelector: '.booktitle h2',
    authorSelector: '.booktitle .author',
    contentSelector: '#content',
  },
  readers365: {
    encoding: 'gbk',
    catalogSelector: '#chapterlist a',
    titleSelector: '.bookTitle h1',
    authorSelector: '.bookTitle .author',
    contentSelector: '#contenttext',
  },
  kehuan: {
    encoding: 'utf-8',
    catalogSelector: '.booklist a',
    titleSelector: '.bookTitle h1',
    authorSelector: '.bookTitle .author',
    contentSelector: '#bookContent',
  },
};
