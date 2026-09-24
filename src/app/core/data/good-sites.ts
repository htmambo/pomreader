/** 万能搜索书签站（从原 vendor bundle goodSites 提取） */
export interface GoodSite {
  name: string;
  url: string;
}

export const GOOD_SITES: GoodSite[] = [
  { name: '百度',         url: 'https://www.baidu.com/' },
  { name: '搜狗',         url: 'https://www.sogou.com/' },
  { name: '读书369(名著)', url: 'http://www.dushu369.com/' },
  { name: '国学123(国学)', url: 'http://www.guoxue123.com/' },
  { name: '读书人365(情怀)', url: 'http://www.readers365.com/' },
  { name: '科幻小说网(科幻)', url: 'http://www.khuan.net.cn/' },
];
