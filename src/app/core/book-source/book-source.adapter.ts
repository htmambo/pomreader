/** 书源适配器框架核心接口（spec §4.2） */

export interface CatalogEntry {
  title: string;
  /** 该章节原始页面 URL（按需抓取正文入口） */
  url: string;
}

export interface ResolvedBook {
  title: string;
  author: string;
  /** 分类/题材（项目 Book.kind 对应；用于封面生成器的 kind 文案） */
  kind?: string;
  /** 封面图片 URL（智能添加 / legado bookInfo 返回的 cover 字段；book.service 写入 Book.coverImageUrl） */
  coverImageUrl?: string;
  chapters: CatalogEntry[];
}

/**
 * 抓取工具抽象 — 渲染进程通过 preload IPC 调主进程 net，浏览器环境降级为 fetch。
 * 适配器通过依赖注入拿到 PageFetcher，与 Electron IPC 解耦，纯逻辑可单测。
 */
export interface PageFetcher {
  /** 抓取 URL 并按编码解码返回 HTML 文本 */
  fetchHtml(url: string, encoding?: 'auto' | 'utf-8' | 'gbk'): Promise<string>;
  /**
   * 可选：渲染抓取 —— 隐藏 BrowserWindow 真实加载页面（执行 JS、应用 CSS），
   * 提取渲染后 DOM 的可视正文文本。用于静态解析失效的站点（JS 渲染/水印混淆）兜底。
   */
  fetchRendered?(url: string): Promise<string>;
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

/**
 * 书源搜索原始返回项（兼容 legado 风格：name/title, url/bookUrl, author, intro/description）。
 * 适配器层公共类型：聚合搜索与各适配器统一使用，避免循环依赖
 * （multi-source.search → registry → js-source 形成回路）。
 *
 * 字段命名约定：legado 标准在前（name / url / intro），兼容字段在后（title / bookUrl / description）。
 * kind 用项目 Book.kind 命名（对应「分类」/「题材」）；fallback 链：kind / genre / category / class / type。
 */
export interface RawSearchItem {
  name?: string;
  title?: string;
  author?: string;
  kind?: string;
  genre?: string;
  category?: string;
  url?: string;
  bookUrl?: string;
  intro?: string;
  description?: string;
}

/**
 * 鸭子类型提取 adapter 的 meta.uuid（JsSourceAdapter 持有 BookSourceMeta.uuid）。
 * 用 duck typing 检查 meta 属性而不是 instanceof —— registry 不反向耦合 js-source 子模块。
 * 返回空字符串视为无效（早期版本 / 损坏数据兜底）。
 */
export function extractMetaUuid(adapter: BookSourceAdapter): string | undefined {
  const meta = (adapter as { meta?: { uuid?: unknown } }).meta;
  const uuid = meta?.uuid;
  return typeof uuid === 'string' && uuid ? uuid : undefined;
}

/** 类型守卫：adapter 是否持有有效 meta.uuid（用于 findJsSourceAdapterByUrl 等跳过无 meta 的内置 adapter） */
export function hasMetaUuid(adapter: BookSourceAdapter): boolean {
  return !!extractMetaUuid(adapter);
}
