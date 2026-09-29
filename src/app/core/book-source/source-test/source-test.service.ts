import { Injectable, inject } from '@angular/core';
import { SandboxService, type SandboxFn } from '../js-source/sandbox.service';
import { RuleEngineService } from '../json-rule/rule-engine.service';
import { isJsonSourceMeta, type BookSourceMeta } from '../source-meta.types';
import type { BookSourceDoc } from '../../models/book-source-doc.model';

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

/** 测试步骤名（与沙箱函数对应；explore 可选） */
const STEP_SEARCH = 'search';
const STEP_BOOK_INFO = 'bookInfo';
const STEP_CHAPTER_LIST = 'chapterList';
const STEP_CHAPTER_CONTENT = 'chapterContent';
const STEP_EXPLORE = 'explore';

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
 * 一次测试的**执行面**（search / bookInfo / … 怎么调）
 *
 * ## 为什么要抽这一层
 *
 * P3 起同一个测试页要面对两种源：JSON 规则源（`RuleEngineService`）与旧 `.js` 源
 * （`SandboxService`）。若把两套调用直接塞进 `runTest`，每一步都要写一遍
 * `if (是 JSON 源) … else …` —— 四步就是八处分支，且**步骤顺序、校验口径、
 * 超时/记账逻辑会被复制两份**，改一处忘另一处就会出现"规则源和 JS 源测试结论不一致"。
 * 故把"步骤链"与"怎么调"分开：步骤链只有一份，两个实现各 10 行。
 */
interface TestExecutor {
  /** 源是否实现了某个入口（JSON 规则源恒为 true —— 四入口是引擎的固定 API） */
  has(fn: string): boolean;
  /**
   * 返回 `unknown` 而**不是** `call<T>(): Promise<T>`（外部评审 R1）
   *
   * 泛型版本把断言推给调用方：`call<BookInfo>('search', …)` 编译通过、运行炸。
   * 这里不给任何类型出口 —— 调用方只能在 `validate` 里用 `Array.isArray` / `typeof`
   * 真正收窄（收窄失败就记成该步失败，正是想要的）。两个实现因此都**不含**类型断言。
   */
  call(fn: string, args: unknown[]): Promise<unknown>;
}

/**
 * 搜索页码归一
 *
 * `Number(x ?? 1)` 在 `x === ''` 时得到 **0**（空串不是 nullish，逃得过 `??`），
 * 页码 0 会被拼成 `/s.php?page=0` 拿到空结果 —— 症状是"源能用但搜不出来"。
 * 今天两个调用点都传字面量 `1`，故这是防御性收口，不是现存缺陷。
 */
function toPage(raw: unknown): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

/** 旧 `.js` 源：走沙箱 */
class SandboxExecutor implements TestExecutor {
  constructor(
    private readonly sandbox: SandboxService,
    private readonly fileName: string,
    private readonly fns: string[],
  ) {}
  static async create(
    sandbox: SandboxService,
    meta: BookSourceMeta,
    read: NonNullable<PomRead['booksourceRead']>,
  ): Promise<SandboxExecutor> {
    const source = await read(meta.fileName, meta.sourceDir || null);
    const mod = await sandbox.load(meta.fileName, source);
    return new SandboxExecutor(sandbox, meta.fileName, mod.fns);
  }
  has(fn: string): boolean {
    return this.fns.includes(fn as SandboxFn);
  }
  async call(fn: string, args: unknown[]): Promise<unknown> {
    return await this.sandbox.call(this.fileName, fn as SandboxFn, args);
  }
}

/** JSON 规则源：走规则引擎（四入口固定存在，explore 无对应概念） */
class RuleExecutor implements TestExecutor {
  constructor(
    private readonly engine: RuleEngineService,
    private readonly doc: BookSourceDoc,
  ) {}
  has(fn: string): boolean {
    return fn === 'search' || fn === 'bookInfo' || fn === 'chapterList' || fn === 'chapterContent';
  }
  async call(fn: string, args: unknown[]): Promise<unknown> {
    switch (fn) {
      case 'search':
        return await this.engine.search(this.doc, String(args[0] ?? ''), toPage(args[1]));
      case 'bookInfo':
        return await this.engine.bookInfo(this.doc, String(args[0] ?? ''));
      case 'chapterList':
        return await this.engine.chapterList(this.doc, String(args[0] ?? ''));
      case 'chapterContent':
        return await this.engine.chapterContent(this.doc, String(args[0] ?? ''));
      default:
        // 契约上不该走到（`has` 已挡）；抛而不是静默返回 undefined
        throw new Error(`规则引擎不支持入口 ${fn}`);
    }
  }
}

/**
 * 书源测试引擎（对应 legado TestSourcesTab 调用的 booksource_run_tests —— 原项目 Rust 侧为 stub，
 * 此处为 pomreader 的 TypeScript 实现）
 *
 * 步骤链：search → bookInfo → chapterList → chapterContent（→ explore，旧 JS 源定义了才跑）
 * 任一失败则后续步骤跳过（无输入可跑），最终 allPassed = 全部步骤通过
 *
 * 两种源走同一套步骤链（见 `TestExecutor`），差别只在执行面。
 */
@Injectable({ providedIn: 'root' })
export class SourceTestService {
  private readonly sandbox = inject(SandboxService);
  private readonly ruleEngine = inject(RuleEngineService);

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

    // ── 装配执行面（JSON 规则源 vs 旧 JS 源）──────────────────────
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
    let exec: TestExecutor;
    try {
      exec = isJsonSourceMeta(meta)
        ? new RuleExecutor(
            this.ruleEngine,
            await this.ruleEngine.readDoc(meta.fileName, meta.sourceDir),
          )
        : await SandboxExecutor.create(this.sandbox, meta, read);
    } catch (e) {
      // 读文档 / 编译失败都归到 load 步：用户看到的第一行就是"为什么这个源测不了"
      steps.push({ step: 'load', passed: false, message: (e as Error).message, durationMs: 0 });
      return { fileName: meta.fileName, steps, allPassed: false };
    }
    const has = (fn: string) => exec.has(fn);
    const call = (fn: string, args: unknown[]): Promise<unknown> => exec.call(fn, args);

    // ── search ────────────────────────────────────────────────────
    let bookUrl = '';
    if (has('search')) {
      const items = await run(
        STEP_SEARCH,
        () => call('search', [keyword, 1]),
        (v) =>
          !Array.isArray(v)
            ? '返回值非数组'
            : v.length === 0
              ? `搜索「${keyword}」无结果`
              : !pickBookUrl(v)
                ? '结果项缺 url/bookUrl'
                : null,
        // 不再盲转：okMessage 自己也收窄（validate 已确保是数组，这里只是不再依赖它）
        (v) => `命中 ${Array.isArray(v) ? v.length : 0} 条`,
      );
      if (Array.isArray(items)) bookUrl = pickBookUrl(items);
    } else {
      steps.push({
        step: STEP_SEARCH,
        passed: false,
        message: '书源未定义 search()',
        durationMs: 0,
      });
    }

    // ── bookInfo ──────────────────────────────────────────────────
    let chapters: unknown[] = [];
    if (bookUrl && has('bookInfo')) {
      const info = await run(
        STEP_BOOK_INFO,
        () => call('bookInfo', [bookUrl]),
        (v) => {
          if (!v || typeof v !== 'object') return '返回值非对象';
          const r = v as Record<string, unknown>;
          return r['title'] || r['name'] ? null : '缺 title/name 字段';
        },
        (v) => {
          const r = v as Record<string, unknown>;
          return `《${String(r['title'] ?? r['name'] ?? '')}》 ${String(r['author'] ?? '')}`.trim();
        },
      );
      if (info) chapters = extractChapters(info);
    } else if (bookUrl) {
      steps.push({
        step: STEP_BOOK_INFO,
        passed: false,
        message: '书源未定义 bookInfo()',
        durationMs: 0,
      });
    }

    // ── chapterList（bookInfo 未给出章节时回退 toc/chapterList 函数） ──
    if (bookUrl && chapters.length === 0 && (has('chapterList') || has('toc'))) {
      const fn = has('chapterList') ? 'chapterList' : 'toc';
      const list = await run(
        STEP_CHAPTER_LIST,
        () => call(fn, [bookUrl]),
        (v) => (!Array.isArray(v) ? '返回值非数组' : v.length === 0 ? '目录为空' : null),
        (v) => `共 ${Array.isArray(v) ? v.length : 0} 章`,
      );
      if (Array.isArray(list)) chapters = list;
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
    const contentFn: string | null = has('chapterContent')
      ? 'chapterContent'
      : has('content')
        ? 'content'
        : null;
    if (chapterUrl && contentFn) {
      await run(
        STEP_CHAPTER_CONTENT,
        () => call(contentFn, [chapterUrl]),
        (v) =>
          typeof v !== 'string' ? '返回值非字符串' : v.trim().length === 0 ? '正文为空' : null,
        (v) => `正文 ${(v as string).length} 字符`,
      );
    } else if (!chapterUrl) {
      steps.push({
        step: STEP_CHAPTER_CONTENT,
        passed: false,
        message: '无章节 URL 可测',
        durationMs: 0,
      });
    } else {
      steps.push({
        step: STEP_CHAPTER_CONTENT,
        passed: false,
        message: '书源未定义 chapterContent()/content()',
        durationMs: 0,
      });
    }

    // ── explore（可选步骤：书源定义了才测，不计入 allPassed） ──────
    if (has('explore')) {
      await run(
        STEP_EXPLORE,
        () => call('explore', ['', 1]),
        (v) => (v == null ? '返回 null' : null),
        () => 'explore 可调用',
      );
    }

    const required = steps.filter((s) => s.step !== STEP_EXPLORE);
    const allPassed = required.length > 0 && required.every((s) => s.passed);
    return { fileName: meta.fileName, steps, allPassed };
  }
}
