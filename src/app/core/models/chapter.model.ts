export interface Chapter {
  bookId: string;
  index: number;
  title: string;
  content: string;
}

export interface ImportedChapter {
  title: string;
  startLine: number;
  endLine: number;
}