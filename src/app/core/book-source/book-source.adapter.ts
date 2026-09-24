/** 书源适配器框架核心接口（spec §4.2） */

export interface CatalogEntry {
  title: string;
  /** 该章节原始页面 URL（按需抓取正文入口） */
  url: string;
}

export interface ResolvedBook {
  title: string;
  author: string;
  chapters: CatalogEntry[];
}

/**
 * 抓取工具抽象 — 渲染进程通过 preload IPC 调主进程 net，浏览器环境降级为 fetch。
 * 适配器通过依赖注入拿到 PageFetcher，与 Electron IPC 解耦，纯逻辑可单测。
 */
export interface PageFetcher {
  /** 抓取 URL 并按编码解码返回 HTML 文本 */
  fetchHtml(url: string, encoding?: 'auto' | 'utf-8' | 'gbk'): Promise<string>;
}

/** 每站配置：编码 + DOM 选择器规则（失效时只改一处） */
export interface BookSourceConfig {
  encoding: 'utf-8' | 'gbk';
  /** 目录页章节链接选择器 */
  catalogSelector: string;
  /** 书名选择器 */
  titleSelector: string;
  /** 作者选择器（文本需含"作者"字样，正则提取） */
  authorSelector: string;
  /** 正文页正文容器选择器 */
  contentSelector: string;
}

/** 单站适配器接口 */
export interface BookSourceAdapter {
  readonly name: string;
  /** 判断本适配器是否处理该 URL */
  match(url: string): boolean;
  /** 抓取书页，解析出书名/作者/目录 */
  fetchCatalog(url: string, fetcher: PageFetcher): Promise<ResolvedBook>;
  /** 抓取单章正文（HTML→纯文本） */
  fetchChapter(entry: CatalogEntry, fetcher: PageFetcher): Promise<string>;
}
