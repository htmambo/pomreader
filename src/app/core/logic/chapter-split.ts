import { finalizeChapterContent } from './text-format';

/**
 * TXT → 章节切分（行为级重写）
 * 来源：v1.1 §7.1 + SPEC §5.1
 *
 * 反推自原 vendor 行为：
 * - 默认匹配 第X章 / 第X回 / Chapter N / CHAPTER N
 * - 全角空格"第 X 章" 也命中
 * - 无章节标题时整体作为单章"全文"
 */

export interface SplitOptions {
  pattern?: RegExp;
}

export interface ImportedChapter {
  title: string;
  startLine: number;
  endLine: number;
}

const PREAMBLE = '__preamble__';

/**
 * 默认章节标题正则
 * 匹配：
 *   - 第X章 / 第X回 （X 含中文/数字/全角空格，1-12 字符）
 *   - Chapter N / Chapter N（罗马数字）
 *   - 行首尾允许空白
 */
export function defaultChapterPattern(): RegExp {
  // 匹配 第X章/第X回 + 任意标题文本；或 chapter + 编号
  // v1.1 §7.1 修订：放宽 [\s\S]* 允许标题后跟任意文本
  return /^\s*(?:第[\s\S]{1,12}[章回][\s\S]*|chapter[\s\S]+)$/i;
}

/**
 * 切分章节
 * @param text 纯文本内容
 * @param opts 自定义 pattern
 * @returns ImportedChapter[]（含兜底单章）
 */
export function splitChapters(
  text: string,
  opts?: SplitOptions
): ImportedChapter[] {
  const pattern = opts?.pattern ?? defaultChapterPattern();
  const lines = text.split(/\r?\n/);
  const chapters: ImportedChapter[] = [];
  let currentTitle = PREAMBLE;
  let currentStart = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (pattern.test(line)) {
      // 关闭上一章
      if (i > currentStart) {
        let title: string;
        if (currentTitle === PREAMBLE) {
          // 序章：用 preamble 段第一行非空文本作标题
          const firstNonEmpty = lines
            .slice(currentStart, i)
            .find((l) => l.trim().length > 0);
          title = firstNonEmpty?.trim() ?? '__preamble__';
        } else {
          title = currentTitle;
        }
        chapters.push({ title, startLine: currentStart, endLine: i - 1 });
      }
      currentTitle = line;
      currentStart = i + 1;
    }
  }
  // 末尾章节处理：无论是否有内容，只要匹配到章节标题就保留（v1.1 §7.1 修订）
  if (currentTitle !== PREAMBLE) {
    chapters.push({
      title: currentTitle,
      startLine: currentStart,
      endLine: Math.max(currentStart - 1, lines.length - 1),
    });
  } else if (currentStart < lines.length) {
    // 全文兜底前的 preamble（如果有内容未匹配任何章节）
    const firstNonEmpty = lines
      .slice(currentStart)
      .find((l) => l.trim().length > 0);
    chapters.push({
      title: firstNonEmpty?.trim() ?? '__preamble__',
      startLine: currentStart,
      endLine: lines.length - 1,
    });
  }
  // 兜底：未识别章节 → 单章"全文"
  return chapters.length > 1
    ? chapters
    : [{ title: '全文', startLine: 0, endLine: lines.length - 1 }];
}

/**
 * 把 ImportedChapter[] 转换为 Chapter[]（带 bookId + index + content）
 * 用于导入流程最后一步；正文经 finalizeChapterContent 定稿（去首尾空白行 + 段首缩进规范化）
 */
export function toChapters(
  bookId: string,
  imported: ImportedChapter[],
  fullText: string
): { bookId: string; index: number; title: string; content: string }[] {
  const lines = fullText.split(/\r?\n/);
  return imported.map((ic, i) => ({
    bookId,
    index: i,
    title: ic.title === '__preamble__' ? '序章' : ic.title,
    content: finalizeChapterContent(lines.slice(ic.startLine, ic.endLine + 1).join('\n')),
  }));
}