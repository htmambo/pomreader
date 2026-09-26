import { Component, computed, inject, signal, viewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { NzInputModule } from 'ng-zorro-antd/input';
import { PageHeaderComponent } from '../../shared/components/page-header/page-header.component';
import { RulesPanelComponent } from '../../shared/components/rules-panel/rules-panel.component';
import { ToastService } from '../../core/services/toast.service';
import { parseHeaderMeta } from '../../core/book-source/js-source/header-parser';
import {
  generateSourceCode,
  SearchMethod,
} from '../../core/book-source/smart-add/smart-rules';

/** PomAPI 子集(全局 Window.pomAPI 在 page-fetcher.service.ts 声明)。 */
type PomBooksourceEditor = {
  booksourceRead?: (fileName: string, sourceDir?: string) => Promise<string>;
  booksourceSave?: (fileName: string, content: string, sourceDir?: string) => Promise<void>;
};

function pomApi(): PomBooksourceEditor | null {
  if (typeof window === 'undefined') return null;
  return (window.pomAPI as unknown as PomBooksourceEditor | undefined) ?? null;
}

/**
 * 书源编辑器(实施计划 T-005)
 * - 路由 /edit/:fileName 编辑现有书源
 * - 上方:RulesPanelComponent —— 加载源后从 const 行解析 12 规则回填,提供可视化编辑 + 4 阶段真实命中测试
 * - 下方:左侧源码 textarea;右侧实时解析预览
 * - 「应用规则到源码」:仅替换 10 个 const 值(保留 explore 等用户自定义代码)
 * - 「从规则生成代码」:用 generateSourceCode 覆盖整个源码(谨慎,自定义代码会丢失)
 * - 保存调 booksourceSave,失败 toast
 */
@Component({
  selector: 'app-book-source-editor',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    NzButtonModule,
    NzIconModule,
    NzInputModule,
    PageHeaderComponent,
    RulesPanelComponent,
  ],
  templateUrl: './book-source-editor.component.html',
  styleUrl: './book-source-editor.component.scss',
})
export class BookSourceEditorComponent {
  fileName = '';
  readonly source = signal('');
  readonly saving = signal(false);
  /** 从源 const BASE_URL 提取的测试基址(测试 search 时供 RulesPanel 用) */
  readonly ruleBaseUrl = signal('');

  private readonly panel = viewChild<RulesPanelComponent>('panel');

  /** 实时解析头部:用于右侧预览,编辑时即时反馈 */
  readonly metaPreview = computed(() => {
    const content = this.source();
    if (!content.trim()) return '// 空内容';
    try {
      const meta = parseHeaderMeta(
        content,
        this.fileName || 'new.js',
        '',
        0,
        0,
        null,
      );
      return JSON.stringify(
        {
          name: meta.name,
          url: meta.url,
          urls: meta.urls,
          author: meta.author,
          tags: meta.tags,
          sourceType: meta.sourceType,
          enabled: meta.enabled,
        },
        null,
        2,
      );
    } catch (e) {
      return `解析失败:${(e as Error).message}`;
    }
  });

  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);

  constructor() {
    this.route.params.subscribe((params) => {
      const raw = params['fileName'];
      this.fileName = raw ? decodeURIComponent(String(raw)) : '';
      void this.loadExisting();
    });
  }

  /** 编辑模式:拉取书源 JS 内容 */
  private async loadExisting(): Promise<void> {
    if (!this.fileName) return;
    const api = pomApi();
    if (!api?.booksourceRead) {
      this.toast.error('IPC 不可用');
      return;
    }
    try {
      const content = await api.booksourceRead(this.fileName);
      this.source.set(content ?? '');
      this.parseRulesFromSource(content ?? '');
    } catch (e) {
      this.toast.error(`读取失败:${(e as Error).message}`);
    }
  }

  /** 从源码中解析 12 个规则常量 + BASE_URL → 回填到 RulesPanel */
  private parseRulesFromSource(content: string): void {
    const extract = (name: string): string => {
      const m = new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*(.+?)\\s*$`, 'm').exec(content);
      if (!m) return '';
      let raw = m[1].trim();
      raw = raw.replace(/;$/, '').trim();
      if ((raw.startsWith('"') && raw.endsWith('"')) ||
          (raw.startsWith("'") && raw.endsWith("'")) ||
          (raw.startsWith('`') && raw.endsWith('`'))) {
        try { return JSON.parse(raw); } catch { /* backtick: 取内 */ }
        if (raw.startsWith('`')) return raw.slice(1, -1);
      }
      return raw;
    };
    /** 提取并求值 JS 数组字面量(如 SEARCH_BODY_PARAMS = [["q","{keyword}"]])—— 仅解析受限语法 */
    const extractArray = (name: string): Array<{ key: string; value: string }> => {
      const raw = extract(name);
      if (!raw || !raw.startsWith('[')) return [];
      try {
        const arr = new Function(`return (${raw});`)() as unknown;
        if (!Array.isArray(arr)) return [];
        const out: Array<{ key: string; value: string }> = [];
        for (const it of arr) {
          if (Array.isArray(it) && it.length >= 2 &&
              typeof it[0] === 'string' && typeof it[1] === 'string') {
            out.push({ key: it[0], value: it[1] });
          }
        }
        return out;
      } catch {
        return [];
      }
    };
    const methodRaw = extract('SEARCH_METHOD').replace(/^["']|["']$/g, '');
    const method: SearchMethod = (['GET', 'POST', 'POST_RAW'] as SearchMethod[]).includes(methodRaw as SearchMethod)
      ? (methodRaw as SearchMethod) : 'GET';
    this.panel()?.setRules({
      searchPath: extract('SEARCH_PATH'),
      searchMethod: method,
      searchBodyParams: extractArray('SEARCH_BODY_PARAMS'),
      searchContentType: extract('SEARCH_CONTENT_TYPE') || 'application/x-www-form-urlencoded',
      searchRawBody: extract('SEARCH_RAW_BODY'),
      searchItemPattern: extract('SEARCH_ITEM_RULE'),
      bookTitlePattern: extract('BOOK_TITLE_RULE'),
      coverUrlPattern: extract('COVER_RULE'),
      bookAuthorPattern: extract('BOOK_AUTHOR_RULE'),
      chapterItemPattern: extract('CHAPTER_ITEM_RULE'),
      contentPattern: extract('CONTENT_RULE'),
      bookCategoryPattern: extract('BOOK_CATEGORY_RULE'),
    });
    this.ruleBaseUrl.set(extract('BASE_URL'));
  }

  /** 应用规则到源码 —— 仅替换 12 个规则常量(保留 explore 等用户自定义代码) */
  applyRulesToSource(): void {
    const p = this.panel();
    if (!p) return;
    const content = this.source();
    const updates = this.buildRuleReplacements(p.getRules());
    const updated = this.replaceRulesInSource(content, updates);
    this.source.set(updated);
    this.toast.success(`✓ 规则已应用(已替换 ${Object.keys(updates).length} 个常量)`);
  }

  /** 构造 const 名 → 序列化值的映射(SEARCH_BODY_PARAMS 输出 JS 数组字面量,其他走 JSON.stringify) */
  private buildRuleReplacements(
    rules: ReturnType<RulesPanelComponent['getRules']>,
  ): Record<string, string | { literal: string }> {
    return {
      SEARCH_PATH: rules.searchPath,
      SEARCH_METHOD: rules.searchMethod ?? 'GET',
      SEARCH_BODY_PARAMS: { literal: JSON.stringify(rules.searchBodyParams ?? []) },
      SEARCH_CONTENT_TYPE: rules.searchContentType ?? 'application/x-www-form-urlencoded',
      SEARCH_RAW_BODY: rules.searchRawBody ?? '',
      SEARCH_ITEM_RULE: rules.searchItemPattern,
      BOOK_TITLE_RULE: rules.bookTitlePattern,
      COVER_RULE: rules.coverUrlPattern ?? 'css:img',
      BOOK_AUTHOR_RULE: rules.bookAuthorPattern,
      CHAPTER_ITEM_RULE: rules.chapterItemPattern,
      CONTENT_RULE: rules.contentPattern,
      BOOK_CATEGORY_RULE: rules.bookCategoryPattern ?? '',
    };
  }

  /** 编辑器:从规则生成完整代码 —— 用 generateSourceCode 覆盖整个源码
   *  (与「应用规则到源码」的区别:本方法替换整个 source,包括 explore 函数 —— 用户自定义代码会丢失)
   */
  generateCodeFromRules(): void {
    if (!this.ruleBaseUrl().trim()) {
      this.toast.warn('请先填写 BASE_URL');
      return;
    }
    const p = this.panel();
    if (!p) return;
    try {
      const code = generateSourceCode(this.ruleBaseUrl().trim(), p.getRules());
      this.source.set(code);
      this.toast.success('✓ 已从规则生成完整代码(覆盖了整个源码)');
    } catch (e) {
      this.toast.error(`生成失败:${(e as Error).message}`);
    }
  }

  /** 把规则值替换到源码对应 const 行(只替换 const/let/var <NAME> = ... 这一行)
   *  - 默认 value 走 JSON.stringify 当字符串字面量
   *  - { literal: '...' } 直接写出 JS 字面量(用于 SEARCH_BODY_PARAMS 这类数组字面量) */
  private replaceRulesInSource(
    content: string,
    rules: Record<string, string | { literal: string }>,
  ): string {
    let out = content;
    for (const [name, v] of Object.entries(rules)) {
      const rendered = typeof v === 'string' ? JSON.stringify(v) : v.literal;
      const re = new RegExp(`^(\\s*(?:const|let|var)\\s+${name}\\s*=\\s*)(.+?)(\\s*;?\\s*)$`, 'm');
      out = out.replace(re, (_m, head, _old, tail) => `${head}${rendered}${tail}`);
    }
    return out;
  }

  /** 保存(保留原 fileName) */
  async save(): Promise<void> {
    const content = this.source();
    if (!content.trim()) {
      this.toast.warn('内容为空,无法保存');
      return;
    }
    const api = pomApi();
    if (!api?.booksourceSave) {
      this.toast.error('IPC 不可用');
      return;
    }
    this.saving.set(true);
    try {
      await api.booksourceSave(this.fileName, content);
      this.toast.success(`保存成功:${this.fileName}`);
      void this.router.navigateByUrl('/book-sources');
    } catch (e) {
      this.toast.error(`保存失败:${(e as Error).message}`);
    } finally {
      this.saving.set(false);
    }
  }

  cancel(): void {
    void this.router.navigateByUrl('/book-sources');
  }
}
