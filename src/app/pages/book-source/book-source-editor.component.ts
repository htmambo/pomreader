import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';

import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzCollapseModule } from 'ng-zorro-antd/collapse';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzSelectModule } from 'ng-zorro-antd/select';
import { NzSwitchModule } from 'ng-zorro-antd/switch';
import * as v from 'valibot';
import { RulesPanelComponent } from '../../shared/components/rules-panel/rules-panel.component';
import { PageHeaderService } from '../../core/services/page-header.service';
import { ToastService } from '../../core/services/toast.service';
import { BookSourceDocSchema, type BookSourceDoc } from '../../core/models/book-source-doc.model';
import { extractBaseUrl, extractHeaders, extractRulesFromJs } from '../../core/logic/rule-parse';

/** PomAPI 子集(全局 Window.pomAPI 在 page-fetcher.service.ts 声明)。 */
type PomBooksourceEditor = {
  booksourceRead?: (fileName: string, sourceDir?: string) => Promise<string>;
  booksourceSaveJson?: (fileName: string, doc: unknown, sourceDir?: string) => Promise<void>;
};

function pomApi(): PomBooksourceEditor | null {
  if (typeof window === 'undefined') return null;
  return (window.pomAPI as unknown as PomBooksourceEditor | undefined) ?? null;
}

/** meta 表单字段（signals 集中管理；rules 由 RulesPanel 持有，保存时 getRules() 合并） */
interface MetaForm {
  name: string;
  author: string;
  description: string;
  homepage: string;
  /** 额外镜像 URL（一行一个；homepage 恒为 urls[0]） */
  extraUrls: string;
  /** 标签（可视化标签输入，数组直存） */
  tags: string[];
  enabled: boolean;
  /** 自定义请求头（JSON 文本，原 HEADERS 常量） */
  headersText: string;
}

/**
 * 书源编辑器（P3 JSON 链路改造，方案 §5）
 * - 路由 /edit/:fileName 编辑现有 JSON 书源（.json）
 * - 主体 = RulesPanelComponent（规则 16 字段）+ meta 表单（name/author/urls/tags/enabled/headers）
 * - 打开：booksourceRead → JSON.parse → valibot safeParse → 填表单；保存走 booksourceSaveJson
 * - 保留「高级：查看 JSON」只读视图（当前表单 + 面板规则实时组装的 doc JSON）
 * - 直接打开旧 .js（迁移后列表不再出现，仅剩 drafts/手动 URL 场景）：
 *   用 rule-parse 抽取规则按 JSON 编辑，保存落盘为同名 .json（uuid 沿用原 .js 文件名，
 *   保住 Book.bookSourceUuid 引用）；原 .js 不删（legacy 文件永不删，§3.1）
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-book-source-editor',
  imports: [
    FormsModule,
    NzButtonModule,
    NzCollapseModule,
    NzIconModule,
    NzInputModule,
    NzSelectModule,
    NzSwitchModule,
    RulesPanelComponent,
  ],
  templateUrl: './book-source-editor.component.html',
  styleUrl: './book-source-editor.component.scss',
})
export class BookSourceEditorComponent {
  fileName = '';
  /** 保存目标文件名（.js 打开时换 .json 落盘） */
  private saveFileName = '';
  /** 加载时保留的 doc 原字段（uuid/sourceVersion/legadoRaw 等不在表单内的字段原样回写） */
  private baseDoc: Partial<BookSourceDoc> = {};
  /** 面板规则加载前值（computed 在 viewChild 就绪前求值用） */
  private loadedRules: BookSourceDoc['rules'] | null = null;

  readonly saving = signal(false);
  /** 基础信息面板展开态（默认展开，可收起给规则面板腾空间） */
  readonly metaOpen = signal(true);
  readonly form = signal<MetaForm>({
    name: '',
    author: '',
    description: '',
    homepage: '',
    extraUrls: '',
    tags: [],
    enabled: true,
    headersText: '{}',
  });

  private readonly panel = viewChild<RulesPanelComponent>('panel');

  /** 「高级：查看 JSON」只读视图：当前表单 + 面板规则实时组装的 doc */
  readonly jsonPreview = computed(() => {
    const doc = this.assembleDoc();
    return doc ? JSON.stringify(doc, null, 2) : '// 请求头 JSON 解析失败，请先修正';
  });

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
      void this.loadExisting();
    });
  }

  /** 编辑模式：拉取书源内容（.json 直接 parse；.js 走 rule-parse 抽取，见类注释） */
  private async loadExisting(): Promise<void> {
    if (!this.fileName) return;
    const api = pomApi();
    if (!api?.booksourceRead) {
      this.toast.error('IPC 不可用');
      return;
    }
    try {
      const content = await api.booksourceRead(this.fileName);
      if (/\.js$/i.test(this.fileName)) {
        this.loadFromJs(content ?? '');
      } else {
        this.loadFromJson(content ?? '');
      }
    } catch (e) {
      this.toast.error(`读取失败:${(e as Error).message}`);
    }
  }

  /** .json 打开：JSON.parse + valibot safeParse（失败按 issues 摘要报错，不填表单） */
  private loadFromJson(content: string): void {
    let json: unknown;
    try {
      json = JSON.parse(content);
    } catch (e) {
      this.toast.error(`JSON 解析失败:${(e as Error).message}`);
      return;
    }
    const parsed = v.safeParse(BookSourceDocSchema, json);
    if (!parsed.success) {
      const summary = parsed.issues
        .map((i) => `${i.path?.map((p) => String(p.key)).join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      this.toast.error(`书源文档校验失败:${summary}`);
      return;
    }
    const doc = parsed.output;
    this.baseDoc = doc;
    this.saveFileName = this.fileName;
    this.loadedRules = doc.rules;
    this.form.set({
      name: doc.name,
      author: doc.author ?? '',
      description: doc.description ?? '',
      homepage: doc.homepage,
      extraUrls: doc.urls.slice(1).join('\n'),
      tags: [...doc.tags],
      enabled: doc.enabled,
      headersText: JSON.stringify(doc.headers, null, 2),
    });
    this.panel()?.setRules(doc.rules);
  }

  /** .js 打开（ drafts / 手动 URL）：rule-parse 抽取后按 JSON 编辑，保存落盘同名 .json */
  private loadFromJs(content: string): void {
    const rules = extractRulesFromJs(content);
    if (!rules) {
      this.toast.error('JS 书源规则抽取失败（必填规则缺失），请手工转换');
      return;
    }
    const homepage = extractBaseUrl(content);
    this.saveFileName = this.fileName.replace(/\.js$/i, '.json');
    // uuid 沿用原 .js 文件名（带扩展名）—— 迁移同口径，保住 Book.bookSourceUuid 引用（§3.1 D6）
    this.baseDoc = { uuid: this.fileName };
    this.loadedRules = rules;
    this.form.set({
      name: rules.siteName,
      author: '',
      description: '',
      homepage,
      extraUrls: '',
      tags: [],
      enabled: false, // 人工转换默认禁用，验证后手动启用
      headersText: JSON.stringify(extractHeaders(content), null, 2),
    });
    this.panel()?.setRules(rules);
    this.toast.info(
      `已按 JSON 模式打开 JS 书源，保存将落盘为 ${this.saveFileName}（原 .js 保留不动）`,
    );
  }

  /** 表单 + 面板规则 → BookSourceDoc；headersText 非法 JSON 时返回 null（保存时拦截） */
  private assembleDoc(): BookSourceDoc | null {
    const f = this.form();
    let headers: Record<string, string>;
    try {
      const parsed: unknown = JSON.parse(f.headersText.trim() || '{}');
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      headers = Object.fromEntries(Object.entries(parsed).map(([k, val]) => [k, String(val)]));
    } catch {
      return null;
    }
    const panelRules = this.panel()?.getRules() ?? this.loadedRules;
    if (!panelRules) return null;
    // siteName 与 name 同源（面板不显示 siteName，保存时以表单名称为准）
    const rules = { ...panelRules, siteName: f.name.trim() || panelRules.siteName };
    const homepage = f.homepage.trim();
    const extraUrls = f.extraUrls
      .split('\n')
      .map((u) => u.trim())
      .filter((u) => u && u !== homepage);
    return {
      format: 'pomreader.booksource',
      schemaVersion: 1,
      uuid: this.baseDoc.uuid ?? this.saveFileName,
      name: f.name.trim(),
      ...(f.author.trim() ? { author: f.author.trim() } : {}),
      ...(this.baseDoc.logo ? { logo: this.baseDoc.logo } : {}),
      ...(f.description.trim() ? { description: f.description.trim() } : {}),
      homepage,
      urls: [homepage, ...extraUrls],
      enabled: f.enabled,
      sourceType: this.baseDoc.sourceType ?? 'novel',
      ...(this.baseDoc.sourceVersion ? { sourceVersion: this.baseDoc.sourceVersion } : {}),
      ...(this.baseDoc.updateUrl ? { updateUrl: this.baseDoc.updateUrl } : {}),
      tags: f.tags.map((t) => t.trim()).filter(Boolean),
      minDelayMs: this.baseDoc.minDelayMs ?? 0,
      requireUrls: this.baseDoc.requireUrls ?? [],
      headers,
      rules,
      ...(this.baseDoc.legadoRaw ? { legadoRaw: this.baseDoc.legadoRaw } : {}),
    };
  }

  patchForm(patch: Partial<MetaForm>): void {
    this.form.update((f) => ({ ...f, ...patch }));
  }

  /** 保存（.json 覆盖原文件；.js 打开时落盘同名 .json） */
  async save(): Promise<void> {
    const doc = this.assembleDoc();
    if (!doc) {
      this.toast.warn('自定义请求头不是合法 JSON，无法保存');
      return;
    }
    const parsed = v.safeParse(BookSourceDocSchema, doc);
    if (!parsed.success) {
      const summary = parsed.issues
        .map((i) => `${i.path?.map((p) => String(p.key)).join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      this.toast.error(`校验失败:${summary}`);
      return;
    }
    const api = pomApi();
    if (!api?.booksourceSaveJson) {
      this.toast.error('IPC 不可用');
      return;
    }
    this.saving.set(true);
    try {
      await api.booksourceSaveJson(this.saveFileName, doc);
      this.toast.success(`保存成功:${this.saveFileName}`);
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
