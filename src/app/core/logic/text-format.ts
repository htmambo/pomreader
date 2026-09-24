/**
 * 章节正文文本规范化（导入/抓取/渲染共用）
 */

/**
 * 去除正文首尾的空白行，但保留首段的段首缩进（全角空格"　"）。
 * 不能用 String.trim()：它会连首段开头的全角空格一起剥掉，破坏"段首空两字"排版。
 */
export function stripEdgeBlankLines(text: string): string {
  return text
    .replace(/^(?:[^\S\n]*\n)+/, '') // 开头：整行皆为空白（含全角空格）的行
    .replace(/(?:\n[^\S\n]*)+$/, '') // 结尾：整行皆为空白的行
    .replace(/[^\S\n]+$/, ''); // 末尾残留的行内空白（无换行）
}

/**
 * 段首缩进规范化为两个全角空格（中文排版"段首空两字"）。
 * 段首已有任意空白（全角/半角/Tab）的统一替换为"　　"，没有的补齐；空白行保持空行。
 * 幂等：对已规范化的文本再次执行结果不变。
 */
export function normalizeParagraphIndent(text: string): string {
  return text
    .split('\n')
    .map((line) =>
      line.trim().length === 0 ? '' : '　　' + line.replace(/^[^\S\n]+/, '')
    )
    .join('\n');
}

/** 章节正文定稿：去首尾空白行 + 段首缩进规范化 */
export function finalizeChapterContent(text: string): string {
  return normalizeParagraphIndent(stripEdgeBlankLines(text));
}
