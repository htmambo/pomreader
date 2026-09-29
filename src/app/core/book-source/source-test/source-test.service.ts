import { Injectable, inject } from '@angular/core';
import { RuleEngineService } from '../json-rule/rule-engine.service';
import { type BookSourceMeta } from '../source-meta.types';

/** 单个测试步骤的结果 */
export interface TestStepResult {
  step: string;
  passed: boolean;
  message: string;
  durationMs: number;
}

/** 全量测试结果 */
export interface TestRunResult {
  fileName: string;
  steps: TestStepResult[];
  allPassed: boolean;
}

/** 测试步骤名（对应规则引擎四入口；explore 已按方案 D3 移除） */
const STEP_SEARCH = 'search';
const STEP_BOOK_INFO = 'bookInfo';
const STEP_CHAPTER_LIST = 'chapterList';
const STEP_CHAPTER_CONTENT = 'chapterContent';

/** 默认搜索关键词：主流小说站命中率高的书名 */
export const DEFAULT_TEST_KEYWORD = [
  '庆余年',
  '雪中悍刀行',
  '赘婿',
  '斗破苍穹',
  '盗墓笔记',
  '鬼吹灯',
][Math.floor(Math.random() * 6)];

type PomRead = {
  booksourceRead?: (fileName: string, sourceDir?: string | null) => Promise<string>;
};

function pomRead(): PomRead | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { pomAPI?: PomRead }).pomAPI ?? null;
}

/** 从搜索结果项取书籍 URL（legado 风格 url/bookUrl 兼容）—— 纯函数便于单测 */
export function pickBookUrl(items: unknown[]): string {
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const r = it as Record<string, unknown>;
    const u =
      typeof r['bookUrl'] === 'string'
        ? r['bookUrl']
        : typeof r['url'] === 'string'
          ? r['url']
          : '';
    if (u.trim()) return u.trim();
  }
  return '';
}

/** 从章节数组取第一章 URL（章节项 {name/title, url}）—— 纯函数便于单测 */
export function pickChapterUrl(chapters: unknown[]): string {
  for (const ch of chapters) {
    if (!ch || typeof ch !== 'object') continue;
    const u = (ch as Record<string, unknown>)['url'];
    if (typeof u === 'string' && u.trim()) return u.trim();
  }
  return '';
}

/** 书源返回的书籍详情对象中提取章节数组（chapters / toc / list 兼容）—— 纯函数便于单测 */
export function extractChapters(bookInfo: unknown): unknown[] {
  if (!bookInfo || typeof bookInfo !== 'object') return [];
  const r = bookInfo as Record<string, unknown>;
  for (const key of ['chapters', 'toc', 'list', 'chapterList']) {
    if (Array.isArray(r[key])) return r[key] as unknown[];
  }
  return [];
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`步骤超时（${Math.round(ms / 1000)}s）`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * 书源测试引擎（对应 legado TestSourcesTab 调用的 booksource_run_tests —— 原项目 Rust 侧为 stub，
 * 此处为 pomreader 的 TypeScript 实现；P3 起调用层从 JS 沙箱换为 RuleEngineService，方案 §5）
 *
 * 步骤链：search → bookInfo → chapterList → chapterContent（explore 按 D3 移除；
 * JSON 源恒有四入口，不再有「书源未定义 fn()」分支 —— 文档校验失败会在首个引擎调用处报错）
 * 任一失败则后续步骤跳过（无输入可跑），最终 allPassed = 全部步骤通过
 */
@Injectable({ providedIn: 'root' })
export class SourceTestService {
  private readonly engine = inject(RuleEngineService);

  async runTest(
    meta: BookSourceMeta,
    keyword: string = DEFAULT_TEST_KEYWORD,
    timeoutSecs = 30,
  ): Promise<TestRunResult> {
    const steps: TestStepResult[] = [];
    const deadline = Date.now() + timeoutSecs * 1000;

    /** 执行单步：计时 + 超时 + 业务校验（返回 null 表示失败，后续步骤跳过） */
    const run = async <T>(
      step: string,
      fn: () => Promise<T>,
      validate: (v: T) => string | null,
      okMessage: (v: T) => string,
    ): Promise<T | null> => {
      const t0 = Date.now();
      const remaining = deadline - t0;
      if (remaining <= 0) {
        steps.push({
          step,
          passed: false,
          message: `超出单项总超时 ${timeoutSecs}s`,
          durationMs: 0,
        });
        return null;
      }
      try {
        const v = await withTimeout(fn(), remaining);
        const err = validate(v);
        steps.push({
          step,
          passed: !err,
          message: err ?? okMessage(v),
          durationMs: Date.now() - t0,
        });
        return err ? null : v;
      } catch (e) {
        steps.push({
          step,
          passed: false,
          message: (e as Error).message || String(e),
          durationMs: Date.now() - t0,
        });
        return null;
      }
    };

    // ── 加载（读文件存在性预检；JSON.parse + valibot 校验在引擎首个调用内完成） ──
    const read = pomRead()?.booksourceRead;
    if (!read) {
      steps.push({
        step: 'load',
        passed: false,
        message: 'booksourceRead IPC 不可用',
        durationMs: 0,
      });
      return { fileName: meta.fileName, steps, allPassed: false };
    }
    try {
      await read(meta.fileName, meta.sourceDir || null);
    } catch (e) {
      steps.push({ step: 'load', passed: false, message: (e as Error).message, durationMs: 0 });
      return { fileName: meta.fileName, steps, allPassed: false };
    }

    // ── search ────────────────────────────────────────────────────
    let bookUrl = '';
    const items = await run(
      STEP_SEARCH,
      () => this.engine.search(meta, keyword, 1),
      (v) =>
        !Array.isArray(v)
          ? '返回值非数组'
          : v.length === 0
            ? `搜索「${keyword}」无结果`
            : !pickBookUrl(v)
              ? '结果项缺 url/bookUrl'
              : null,
      (v) => `命中 ${v.length} 条`,
    );
    if (items) bookUrl = pickBookUrl(items);

    // ── bookInfo ──────────────────────────────────────────────────
    let chapters: unknown[] = [];
    if (bookUrl) {
      const info = await run(
        STEP_BOOK_INFO,
        () => this.engine.bookInfo(meta, bookUrl),
        (v) => {
          if (!v || typeof v !== 'object') return '返回值非对象';
          const r = v as unknown as Record<string, unknown>;
          return r['title'] || r['name'] ? null : '缺 title/name 字段';
        },
        (v) => {
          const r = v as unknown as Record<string, unknown>;
          return `《${String(r['title'] ?? r['name'] ?? '')}》 ${String(r['author'] ?? '')}`.trim();
        },
      );
      if (info) chapters = extractChapters(info);
    }

    // ── chapterList（bookInfo 未给出章节时回退引擎 chapterList 入口） ──
    if (bookUrl && chapters.length === 0) {
      const list = await run(
        STEP_CHAPTER_LIST,
        () => this.engine.chapterList(meta, bookUrl),
        (v) => (!Array.isArray(v) ? '返回值非数组' : v.length === 0 ? '目录为空' : null),
        (v) => `共 ${v.length} 章`,
      );
      if (list) chapters = list;
    } else if (chapters.length > 0) {
      // bookInfo 已含章节：chapterList 步骤标记通过（复用 bookInfo 结果）
      steps.push({
        step: STEP_CHAPTER_LIST,
        passed: true,
        message: `共 ${chapters.length} 章（来自 bookInfo）`,
        durationMs: 0,
      });
    }

    // ── chapterContent ────────────────────────────────────────────
    const chapterUrl = pickChapterUrl(chapters);
    if (chapterUrl) {
      await run(
        STEP_CHAPTER_CONTENT,
        () => this.engine.chapterContent(meta, chapterUrl),
        (v) =>
          typeof v !== 'string' ? '返回值非字符串' : v.trim().length === 0 ? '正文为空' : null,
        (v) => `正文 ${v.length} 字符`,
      );
    } else {
      steps.push({
        step: STEP_CHAPTER_CONTENT,
        passed: false,
        message: '无章节 URL 可测',
        durationMs: 0,
      });
    }

    const allPassed = steps.length > 0 && steps.every((s) => s.passed);
    return { fileName: meta.fileName, steps, allPassed };
  }
}
