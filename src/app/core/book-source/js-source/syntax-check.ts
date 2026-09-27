/**
 * 书源 JS 保存前语法检查（拦截用户手改源码引入的语法错误）。
 * 与沙箱 sandbox.worker.ts compileModule 同一包装形态：new Function 只解析函数体、
 * 不执行 —— 构造时即抛 SyntaxError，因此此处校验结果与沙箱加载结果完全一致，
 * 用户代码不会在检查阶段运行。
 */

/** 沙箱导出表（与 sandbox.worker.ts compileModule 追加的 return 语句保持一致；修改时同步两处） */
const EXPORT_TABLE = `\n;return {\n  search: typeof search === "function" ? search : undefined,\n  bookInfo: typeof bookInfo === "function" ? bookInfo : undefined,\n  toc: typeof toc === "function" ? toc : undefined,\n  chapterList: typeof chapterList === "function" ? chapterList : undefined,\n  content: typeof content === "function" ? content : undefined,\n  chapterContent: typeof chapterContent === "function" ? chapterContent : undefined,\n  explore: typeof explore === "function" ? explore : undefined\n};`;

/** 返回 null = 语法 OK；否则返回错误描述（引擎原始 message，含出错 token 信息） */
export function checkSourceSyntax(source: string): string | null {
  try {
    // new Function 仅解析不执行 —— 语法错误在此抛出，用户代码不会运行
    new Function('legado', `${source}${EXPORT_TABLE}`);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
