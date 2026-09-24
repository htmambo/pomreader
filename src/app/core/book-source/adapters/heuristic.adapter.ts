import { BaseSourceAdapter } from './base-source.adapter';
import { BookSourceAdapter, CatalogEntry, PageFetcher, ResolvedBook } from '../book-source.adapter';
import { parseCatalog, parseChapterContent } from '../heuristic-parser';

/**
 * 通用启发式适配器（兜底）— 复刻原 vendor hS/fS 正文密度算法
 *
 * 原 vendor 导入在线书页是通用解析：og:novel:* meta 提取书名/作者，
 * 链接密度评分找目录容器，文字密度评分找正文段落。不限站点。
 *
 * 注册到 registry 最末位，优先级最低（仅在无专用适配器时启用）。
 * 直接实现 BookSourceAdapter（不继承 BaseSourceAdapter，因不用固定选择器）。
 */
export class HeuristicAdapter implements BookSourceAdapter {
  readonly name = '通用（启发式）';

  match(url: string): boolean {
    return /^https?:\/\//.test(url);
  }

  async fetchCatalog(url: string, fetcher: PageFetcher): Promise<ResolvedBook> {
    const html = await fetcher.fetchHtml(url, 'auto');
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const r = parseCatalog(doc, url);
    if (r.chapters.length === 0) throw new Error('catalog-empty');
    return r;
  }

  async fetchChapter(entry: CatalogEntry, fetcher: PageFetcher): Promise<string> {
    const html = await fetcher.fetchHtml(entry.url, 'auto');
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return parseChapterContent(doc);
  }
}
