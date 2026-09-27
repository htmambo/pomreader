import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzTagModule } from 'ng-zorro-antd/tag';
import { RulesPanelComponent } from '../../shared/components/rules-panel/rules-panel.component';
import { PageHeaderService } from '../../core/services/page-header.service';
import { ToastService } from '../../core/services/toast.service';
import { parseHeaderMeta } from '../../core/book-source/js-source/header-parser';
import { checkSourceSyntax } from '../../core/book-source/js-source/syntax-check';
import { generateSourceCode } from '../../core/book-source/smart-add/smart-rules'
import {
  ensureGeneratedMarker,
  isStandardSource,
  parseSourceRules,
  stripGeneratedMarker,
} from '../../core/book-source/smart-add/standard-source';

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
 * - 上方:RulesPanelComponent —— 加载源后从 const 行解析 13 规则回填,提供可视化编辑 + 4 阶段真实命中测试
 * - 书源分级(sourceKind):标准书源(代码=模板纯规则产物)默认折叠代码区,只维护规则;
 *   增强书源(代码被手改)展示完整代码区 + 语法检查。保存时校正 @generated marker,保证列表徽章准确
 * - 「应用规则到源码」:仅替换规则常量(保留 explore 等用户自定义代码;源里没有的常量行如 CONTENT_REPLACE_RULES 不会新增)
 * - 「从规则生成代码」:用 generateSourceCode 覆盖整个源码(谨慎,自定义代码会丢失)
 * - 保存调 booksourceSave,失败 toast
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-book-source-editor',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    NzButtonModule,
    NzIconModule,
    NzInputModule,
    NzTagModule,
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
      const meta = parseHeaderMeta(content, this.fileName || 'new.js', '', 0, 0, null);
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

  /** 实时语法检查（与沙箱 compileModule 同一包装；null = 通过）。保存前拦截，编辑时即时反馈 */
  readonly syntaxError = computed(() => {
    const content = this.source();
    if (!content.trim()) return null;
    return checkSourceSyntax(content);
  });

  /** 书源分级：standard = 代码仍是模板的纯规则产物(只维护规则即可)；enhanced = 代码被手改过。
   *  随输入实时判定 —— 标准书源展开代码改任意字符即翻转为增强 */
  readonly sourceKind = computed<'standard' | 'enhanced'>(() =>
    isStandardSource(this.source()) ? 'standard' : 'enhanced',
  );
  /** 标准模式下代码区默认折叠；展开后可见/可编辑 */
  readonly codeExpanded = signal(false);

  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);
  private readonly pageHeader = inject(PageHeaderService);

  constructor() {
    this.route.params.subscribe((params) => {
      const raw = params['fileName'];
      this.fileName = raw ? decodeURIComponent(String(raw)) : '';
      // 副标题显示当前编辑的文件名
      this.pageHeader.subtitle.set(this.fileName);
      this.codeExpanded.set(false);
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

  /** 从源码中解析 13 个规则常量 + BASE_URL → 回填到 RulesPanel（解析逻辑与标准书源判定同源） */
  private parseRulesFromSource(content: string): void {
    const { rules, baseUrl } = parseSourceRules(content);
    this.panel()?.setRules(rules);
    this.ruleBaseUrl.set(baseUrl);
  }

  /** 应用规则到源码 —— 仅替换 13 个规则常量(保留 explore 等用户自定义代码) */
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
      // 二元组数组 [["k","v"],...] —— 与 generateSourceCode 的输出形态一致(对象数组会让沙箱 buildFormBody 解构崩溃)
      SEARCH_BODY_PARAMS: {
        literal: JSON.stringify((rules.searchBodyParams ?? []).map((p) => [p.key, p.value])),
      },
      SEARCH_CONTENT_TYPE: rules.searchContentType ?? 'application/x-www-form-urlencoded',
      SEARCH_RAW_BODY: rules.searchRawBody ?? '',
      SEARCH_ITEM_RULE: rules.searchItemPattern,
      BOOK_TITLE_RULE: rules.bookTitlePattern,
      COVER_RULE: rules.coverUrlPattern ?? 'css:img',
      BOOK_AUTHOR_RULE: rules.bookAuthorPattern,
      CHAPTER_ITEM_RULE: rules.chapterItemPattern,
      CONTENT_RULE: rules.contentPattern,
      CONTENT_REPLACE_RULES: {
        literal: JSON.stringify((rules.contentReplaceRules ?? []).map((r) => [r.rule, r.replace])),
      },
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
    const syntaxError = this.syntaxError();
    if (syntaxError) {
      this.toast.error(`语法错误,保存已取消:${syntaxError}`);
      return;
    }
    const api = pomApi();
    if (!api?.booksourceSave) {
      this.toast.error('IPC 不可用');
      return;
    }
    // marker 校正:标准书源确保有 @generated(顺带迁移存量生成源);增强书源剔除,保证列表徽章与真实状态一致
    const finalContent = isStandardSource(content)
      ? ensureGeneratedMarker(content)
      : stripGeneratedMarker(content);
    this.saving.set(true);
    try {
      await api.booksourceSave(this.fileName, finalContent);
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
