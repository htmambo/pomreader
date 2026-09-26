import { Injectable } from '@angular/core';

/**
 * AI 草稿生成服务（v1 mock 模板）
 * - 不接真实 LLM（v2 接入 OpenAI 兼容 API）
 * - 模板基于 @name + @url 拼接固定模板（含 search/bookInfo/toc/content 函数 stub）
 * - 预留 AiDraftProvider 接口供 v2 替换
 */
export interface AiDraftInput {
  name: string;
  url: string;
  author?: string;
}

export interface AiDraftProvider {
  generate(input: AiDraftInput): Promise<string>;
}

/** v1 mock provider：拼接固定模板（含 TODO 注释的 search/bookInfo/toc/content stub） */
export class MockTemplateProvider implements AiDraftProvider {
  async generate(input: AiDraftInput): Promise<string> {
    const author = input.author?.trim() || 'AI Draft';
    return `// @name          ${input.name}
// @author        ${author}
// @url           ${input.url}
// @version       1.0.0
// @description   自动生成的书源模板（v1 mock），需手动调整搜索/章节解析逻辑
// @enabled       true
// @type          novel

var baseUrl = "${input.url}";

function search(keyword, page) {
  const url = baseUrl + "/search?q=" + encodeURIComponent(keyword) + "&page=" + page;
  const html = legado.http.get(url);
  // TODO: 解析搜索结果，提取书名/作者/链接
  return [];
}

function bookInfo(bookUrl) {
  const html = legado.http.get(bookUrl);
  // TODO: 解析书页，提取书名/作者/简介/章节列表
  return { title: "", author: "", chapters: [] };
}

function toc(bookUrl) {
  return bookInfo(bookUrl).chapters;
}

function chapterContent(chapterUrl) {
  const html = legado.http.get(chapterUrl);
  // TODO: 提取章节正文
  return html;
}
`;
  }
}

@Injectable({ providedIn: 'root' })
export class AiDraftService {
  private provider: AiDraftProvider = new MockTemplateProvider();

  /** v2 切换为真实 LLM provider */
  setProvider(provider: AiDraftProvider): void {
    this.provider = provider;
  }

  async generate(input: AiDraftInput): Promise<string> {
    return this.provider.generate(input);
  }

  /** 从书源名称推导 fileName：保留中英文 / 数字 / 下划线 / 连字符；非法字符替换；超长截断 */
  suggestFileName(name: string): string {
    const safe = name.replace(/[^\w一-鿿-]+/g, '_').slice(0, 50);
    return `${safe || `source-${Date.now()}`}.js`;
  }
}