/**
 * JS 书源适配器（实施计划 T-004 + spec FR-1.4）
 *
 * - match(url)：按 meta.urls[0] 主机名匹配（与 BaseSourceAdapter hostPattern 一致）
 * - fetchCatalog → 沙箱 `bookInfo(url)`；fetchChapter → 沙箱 `chapterContent(url)`
 * - load() 缓存命中跳过（Worker 侧按 fileName 缓存）
 * - 读取源文件走 preload `pomAPI.booksourceRead`（renderer 不直接 FS）
 */
import { BookSourceAdapter, CatalogEntry, PageFetcher, ResolvedBook } from '../book-source.adapter';
import { FetchError } from '../fetch-error';
import { SandboxService } from './sandbox.service';
import { BookSourceMeta } from './source-meta.types';

interface BookInfoResult {
  title?: string;
  author?: string;
  chapters?: CatalogEntry[];
}

/** 手动 `new` 实例化（registry.loadAllJsAdapters 内），不挂 Angular DI */
export class JsSourceAdapter implements BookSourceAdapter {
  readonly name: string;
  private readonly hostPattern: RegExp | null;
  /** 已加载标记：load() 缓存命中时跳过 */
  private loaded = false;

  constructor(private readonly meta: BookSourceMeta, private readonly sandbox: SandboxService) {
    this.name = meta.name || meta.fileName;
    this.hostPattern = buildHostPattern(meta.url || meta.urls[0]);
  }

  match(url: string): boolean {
    if (!this.hostPattern) return false;
    return this.hostPattern.test(url);
  }

  async fetchCatalog(url: string, _fetcher: PageFetcher): Promise<ResolvedBook> {
    await this.ensureLoaded();
    const result = await this.sandbox.call<BookInfoResult>(
      this.meta.fileName, 'bookInfo', [url],
    );
    if (!result || !Array.isArray(result.chapters)) {
      throw new FetchError('parse-failed', `书源 ${this.name} 返回结果无 chapters`);
    }
    return {
      title: result.title || this.name,
      author: result.author || '未知',
      chapters: result.chapters.map((ch) => ({
        title: ch.title || '未知章节',
        url: ch.url,
      })),
    };
  }

  async fetchChapter(entry: CatalogEntry, _fetcher: PageFetcher): Promise<string> {
    await this.ensureLoaded();
    const result = await this.sandbox.call<string>(
      this.meta.fileName, 'chapterContent', [entry.url],
    );
    return typeof result === 'string' ? result : '';
  }

  /** 二次调用命中缓存，不再 postMessage 'load' */
  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    const source = await this.readSource();
    await this.sandbox.load(this.meta.fileName, source);
    this.loaded = true;
  }

  private async readSource(): Promise<string> {
    // 不在 Window.pomAPI 上声明 booksourceRead（与 sandbox/page-fetcher 的 declare global 互不冲突）
    const pom = (typeof window !== 'undefined' ? (window as unknown as {
      pomAPI?: { booksourceRead?: (fileName: string, sourceDir?: string | null) => Promise<string> };
    }).pomAPI : undefined);
    const read = pom?.booksourceRead;
    if (!read) throw new FetchError('source-unavailable', 'booksourceRead IPC 不可用');
    return await read(this.meta.fileName, this.meta.sourceDir || null);
  }
}

/** 主机名 → 正则（剥 www.，转义点号；与 base-source.adapter.ts 思路一致） */
function buildHostPattern(mainUrl: string): RegExp | null {
  if (!mainUrl) return null;
  try {
    const u = new URL(mainUrl);
    const host = u.hostname.replace(/^www\./, '').replace(/\./g, '\\.');
    return new RegExp(`^https?://([^/]+\\.)?${host}(/|$)`);
  } catch {
    return null;
  }
}