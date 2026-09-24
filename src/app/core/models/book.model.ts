export type BookSource = 'local-txt' | 'online' | 'mock';

export interface Book {
  id: string;
  title: string;
  author: string;
  coverColor: string;
  chapterCount: number;
  totalChars: number;
  importedAt: string;
  source: BookSource;
  sourceUrl?: string;
}