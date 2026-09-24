import {
  BookSourceAdapter,
  BookSourceConfig,
  CatalogEntry,
  PageFetcher,
  ResolvedBook,
} from '../book-source.adapter';

/**
 * 适配器基类 — 封装通用解析逻辑（DOMParser + 选择器），6 站复用。
 * 站点差异通过 hostPattern + config 表达。
 */
export abstract class BaseSourceAdapter implements BookSourceAdapter {
  abstract readonly name: string;
  protected abstract readonly hostPattern: RegExp;
  protected abstract readonly config: BookSourceConfig;

  match(url: string): boolean {
    return this.hostPattern.test(url);
  }

  async fetchCatalog(url: string, fetcher: PageFetcher): Promise<ResolvedBook> {
    const html = await fetcher.fetchHtml(url, this.config.encoding);
    const doc = new DOMParser().parseFromString(html, 'text/html');

    const title = doc.querySelector(this.config.titleSelector)?.textContent?.trim() ?? '未知书名';
    const authorRaw = doc.querySelector(this.config.authorSelector)?.textContent ?? '';
    const author = this.extractAuthor(authorRaw) ?? '未知';

    const links = Array.from(doc.querySelectorAll<HTMLAnchorElement>(this.config.catalogSelector));
    const chapters: CatalogEntry[] = [];
    for (const a of links) {
      const t = a.textContent?.trim();
      const href = a.getAttribute('href');
      if (!t || !href) continue;
      const abs = this.toAbsolute(url, href);
      if (abs) chapters.push({ title: t, url: abs });
    }

    if (chapters.length === 0) throw new Error('catalog-empty');
    return { title, author, chapters };
  }

  async fetchChapter(entry: CatalogEntry, fetcher: PageFetcher): Promise<string> {
    const html = await fetcher.fetchHtml(entry.url, this.config.encoding);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const node = doc.querySelector(this.config.contentSelector);
    if (!node) return '（正文解析失败，该书源可能已改版）';
    return this.toPlainText(node);
  }

  /** 作者文本提取：常见格式"作者：XXX"或"作者:XXX" */
  protected extractAuthor(raw: string): string | null {
    const m = /作者[：:]\s*([^\s,，]+)/.exec(raw);
    if (m) return m[1].trim();
    const trimmed = raw.trim();
    return trimmed || null;
  }

  protected toAbsolute(base: string, href: string): string | null {
    try {
      return new URL(href, base).href;
    } catch {
      return null;
    }
  }

  /** HTML 节点 → 纯文本（保留段落换行） */
  protected toPlainText(node: Element): string {
    // 移除脚本/样式/广告
    node.querySelectorAll('script, style, ins, .adsbygoogle').forEach((n) => n.remove());
    const text = node.textContent ?? '';
    return text.replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }
}
