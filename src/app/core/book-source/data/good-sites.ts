/** 万能搜索书签站（仅放搜索引擎；具体小说站点走 BookSourceRegistry） */
export interface GoodSite {
  name: string;
  url: string;
}

export const GOOD_SITES: GoodSite[] = [
  { name: '百度', url: 'https://www.baidu.com/' },
  { name: '搜狗', url: 'https://www.sogou.com/' },
  { name: '必应', url: 'https://cn.bing.com/' },
  { name: '谷歌', url: 'https://www.google.com/' },
];
