import { describe, it, expect, beforeEach } from 'vitest';
import { LocalTxtImportService } from './local-txt-import.service';
import { BookService } from './book.service';
import { Book } from '../models/book.model';
import { Chapter } from '../models/chapter.model';
import { BookSourceRegistry } from '../book-source/book-source.registry';
import { BookSourceAdapter, PageFetcher, ResolvedBook } from '../book-source/book-source.adapter';
import { ImportViaSourceService } from '../book-source/import-via-source.service';

/**
 * LocalTxtImportService spec — TXT 导入管线（实施计划 T-007 核心）
 */

function emptyFetcher(): PageFetcher {
  return { fetchHtml: async () => '', fetchRendered: async () => '' };
}

class StubAdapter implements BookSourceAdapter {
  constructor(public readonly name: string) {}
  match(): boolean {
    return true;
  }
  async fetchCatalog(): Promise<ResolvedBook> {
    return { title: 'stub', author: 'stub', chapters: [] };
  }
  async fetchChapter(): Promise<string> {
    return '';
  }
}

function makeFakeDb() {
  return {
    bookPut: async () => undefined,
    bookDelete: async () => undefined,
    chapterPutMany: async () => undefined,
    chapterAll: async () => [],
  };
}

describe('LocalTxtImportService', () => {
  let svc: LocalTxtImportService;
  let booksSvc: BookService;
  let addBookCalls: Array<{ book: Book; chapters: Chapter[] }>;

  beforeEach(() => {
    addBookCalls = [];
    const fakeDb = makeFakeDb();
    const registry = BookSourceRegistry.forTest(emptyFetcher());
    registry.register(new StubAdapter('stub'));
    const importViaSource = Object.create(ImportViaSourceService.prototype);
    importViaSource.importByUrl = async () => ({ book: { chapters: [] } });
     
    booksSvc = BookService.forTest(fakeDb as any, registry, importViaSource as any);
    // spy addBook
     
    (booksSvc as any).addBook = async (book: Book, chapters: Chapter[]) => {
      addBookCalls.push({ book, chapters });
    };
    // Object.create 不跑 class field initializer；手动注入 books
     
    svc = Object.create(LocalTxtImportService.prototype) as any;
     
    (svc as any).books = booksSvc;
  });

  describe('titleOf', () => {
    it('应剥离最后一个扩展名', () => {
      expect(svc.titleOf('book.txt')).toBe('book');
      expect(svc.titleOf('book.epub')).toBe('book');
    });

    it('多个点号只剥离最后一个', () => {
      expect(svc.titleOf('my.book.txt')).toBe('my.book');
    });

    it('无扩展名应原样返回', () => {
      expect(svc.titleOf('book')).toBe('book');
    });
  });

  describe('hasBook', () => {
    it('书架有同名书应返回 true', () => {
       
      (booksSvc as any)._books.set([
         
        { id: 'b1', title: '天龙八部', source: 'local-txt' } as any,
      ]);
      expect(svc.hasBook('天龙八部.txt')).toBe(true);
    });

    it('书架无同名书应返回 false', () => {
       
      (booksSvc as any)._books.set([]);
      expect(svc.hasBook('天龙八部.txt')).toBe(false);
    });
  });

  describe('importText', () => {
    it('应拆分章节 + 写 BookService + 返回 singleChapter=false（多章）', async () => {
      const text = [
        '第一章 落花',
        '执剑问天道。',
        '',
        '第二章 流云',
        '剑光起西北。',
      ].join('\n');
      const result = await svc.importText('mybook.txt', text);
      expect(result.chapters.length).toBeGreaterThan(1);
      expect(result.singleChapter).toBe(false);
      expect(addBookCalls).toHaveLength(1);
      expect(addBookCalls[0].book.title).toBe('mybook');
      expect(addBookCalls[0].book.source).toBe('local-txt');
      expect(addBookCalls[0].book.author).toBe('本地导入');
    });

    it('source=auto-import 时 author 应为「自动导入」', async () => {
      await svc.importText('a.txt', '正文', 'auto-import');
      expect(addBookCalls[0].book.author).toBe('自动导入');
    });

    it('未识别到章节标题时 singleChapter 应为 true', async () => {
      const text = '这是一段没有章节标记的纯文本';
      const result = await svc.importText('plain.txt', text);
      expect(result.singleChapter).toBe(true);
      expect(result.chapters).toHaveLength(1);
      expect(result.chapters[0].title).toBe('全文');
    });

    it('coverImageUrl 应基于书名生成（data URI）', async () => {
      const result = await svc.importText('cover-test.txt', '第一章\n正文');
      expect(result.book.coverImageUrl).toMatch(/^data:/);
    });

    it('id 应以 txt- 前缀避免与 PouchDB 其它来源冲突', async () => {
      const result = await svc.importText('id.txt', '第一章\n正文');
      expect(result.book.id).toMatch(/^txt-\d+$/);
    });
  });
});