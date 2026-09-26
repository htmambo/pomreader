import { Injectable, inject } from '@angular/core';
import { splitChapters, toChapters, ImportedChapter } from '../logic/chapter-split';
import { randomCoverFor } from '../cover/generators/random';
import { BookService } from './book.service';
import { Book, BookSource } from '../models/book.model';
import { Chapter } from '../models/chapter.model';

export interface TxtImportResult {
  book: Book;
  chapters: Chapter[];
  /** 未识别到章节标题（单章「全文」导入）时为 true，调用方可提示 */
  singleChapter: boolean;
}

/**
 * TXT 文本 → 书架 的共享导入管线（实施计划 T-007 拆出的可复用核心）
 * 供 import-local-txt modal（用户手选文件）与 AutoImportService（万能搜索自动监控）共用
 */
@Injectable({ providedIn: 'root' })
export class LocalTxtImportService {
  private readonly books = inject(BookService);

  /** 文件名去扩展名作为书名（供去重判断与导入共用，保证两处书名一致） */
  titleOf(fileName: string): string {
    return fileName.replace(/\.[^.]+$/, '');
  }

  /** 书架是否已有同名书（自动导入去重用） */
  hasBook(fileName: string): boolean {
    const title = this.titleOf(fileName);
    return this.books.books().some((b) => b.title === title);
  }

  /** 预拆分章节（modal 预览用；confirm 时可直接传拆分结果避免二次计算） */
  split(text: string): ImportedChapter[] {
    return splitChapters(text);
  }

  async importText(fileName: string, text: string, source: BookSource = 'local-txt'): Promise<TxtImportResult> {
    const chs = splitChapters(text);
    const id = `txt-${Date.now()}`;
    const baseTitle = this.titleOf(fileName);
    const book: Book = {
      id,
      title: baseTitle,
      author: source === 'auto-import' ? '自动导入' : '本地导入',
      // 本地 TXT 无源站封面 —— 随机选一款内置 SVG 模板生成
      coverImageUrl: randomCoverFor({ title: baseTitle, author: '本地导入' }),
      chapterCount: chs.length,
      totalChars: text.length,
      importedAt: new Date().toISOString(),
      source,
    };
    const chapters = toChapters(id, chs, text);
    await this.books.addBook(book, chapters);
    return { book, chapters, singleChapter: chs.length === 1 && chs[0].title === '全文' };
  }
}
