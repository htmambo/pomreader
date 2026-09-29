import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';

import * as v from 'valibot';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzSpinModule } from 'ng-zorro-antd/spin';
import { NzInputNumberModule } from 'ng-zorro-antd/input-number';
import { NzSwitchModule } from 'ng-zorro-antd/switch';
import { NzSelectModule } from 'ng-zorro-antd/select';
import { RulesPanelComponent } from '../../shared/components/rules-panel/rules-panel.component';
import { PageHeaderService } from '../../core/services/page-header.service';
import { ToastService } from '../../core/services/toast.service';
import { RuleEngineService } from '../../core/book-source/json-rule/rule-engine.service';
import { buildSourceDoc, serializeSourceDoc } from '../../core/logic/source-doc-build';
import {
  BookSourceDocSchema,
  SOURCE_TYPES,
  type BookSourceDoc,
  type BookSourceDocDraft,
  type SourceType,
} from '../../core/models/book-source-doc.model';

/**
 * 书源编辑器（实施计划 T-005，P3.2 起改为**文档**编辑器）
 *
 * ## 形态变更（相对 P3.2 之前的版本）
 *
 * 旧版编辑的是 `.js` 源码：左侧 textarea + 「应用规则到源码」（正则替换 15 个 const
 * 行）+「从规则生成代码」（`generateSourceCode` 覆盖整份源码）。这三条路在 JSON 规则
 * 文档下**全部消失**，原因不是"UI 改起来麻烦"，而是它们各自对应一个已经不存在的问题：
 * 源码里的规则要靠**反向解析**回填面板（`parseRulesFromSource` 是一段与 `parseJsSource`
 * 重复的正则），而反向解析与正向生成不同源 → 用户改的面板值与真正生效的值可能不一致。
 * 规则化后文档本身就是**唯一真相**，不需要"应用"，也就不需要反向解析。
 *
 * 现在只做三件事：加载文档 → 编辑元信息与规则面板 → 校验后整份存回。
 *
 * ## 校验为什么必须在这一层
 *
 * `booksourceSave` 只做原子写，不做 schema 校验（主进程不能 import `src/`，见 D4/D8）。
 * 落一份不合 schema 的文档 → 列表页立刻把它标成「规则损坏」，引擎拒绝加载。
 * 所以**存之前**必须过 `BookSourceDocSchema`；校验失败时**不写盘**，并把 issues 说清楚。
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-book-source-editor',
  imports: [
    FormsModule,
    NzButtonModule,
    NzIconModule,
    NzInputModule,
    NzSelectModule,
    NzSpinModule,
    NzInputNumberModule,
    NzSwitchModule,
    RulesPanelComponent,
  ],
  templateUrl: './book-source-editor.component.html',
  styleUrl: './book-source-editor.component.scss',
})
export class BookSourceEditorComponent {
  fileName = '';
  readonly saving = signal(false);
  /** 规则面板的测试基址（来自文档的 `homepage`） */
  readonly ruleBaseUrl = signal('');
  /** 原始文档（编辑期间持有副本，保存时逐字段覆盖） */
  readonly doc = signal<BookSourceDoc | null>(null);
  readonly loading = signal(true);

  /** 元信息表单（直接绑到 doc 的可编辑字段上） */
  readonly name = signal('');
  readonly author = signal('');
  readonly homepage = signal('');
  readonly description = signal('');
  readonly version = signal('');
  readonly updateUrl = signal('');
  readonly sourceType = signal<SourceType>('novel');
  readonly tagsText = signal('');
  /** 镜像域名（一行一个）。留空则只用 `homepage` */
  readonly urlsText = signal('');
  readonly minDelayMs = signal(0);
  readonly requireUrlsText = signal('');
  readonly enabled = signal(true);

  readonly sourceTypes = SOURCE_TYPES;

  private readonly panel = viewChild<RulesPanelComponent>('panel');

  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);
  private readonly pageHeader = inject(PageHeaderService);
  private readonly engine = inject(RuleEngineService);

  /**
   * 只读 JSON 预览（保存前的实际落盘内容）
   *
   * 保留它是因为它现在**说的是真话**：旧版的「解析预览」是正则解析 `.js` 的结果（可能
   * 与真正生效的规则不一致），这里的预览是 `serializeSourceDoc` 的直接输出，与写盘内容
   * 逐字节相同（P2.2 在主进程侧用另一条测试锁了同一格式 —— 不能共享代码，见 D4/D8）。
   *
   * **刻意不跑 schema 校验**（外部评审 R1）：它是 computed，依赖全部表单 signal，
   * 每敲一个字就重算一次；`safeParse` 一次约几十微秒、序列化还要过一遍 `JSON.stringify`，
   * 叠在每次按键上就是纯浪费。校验只在 `save()` 里做 —— 那才是它的用武之地。
   * 预览文本不受影响：校验不会改变待写内容。
   */
  readonly jsonPreview = computed(() => {
    const doc = this.doc();
    if (!doc) return '';
    try {
      return serializeSourceDoc(this.buildDraft());
    } catch (e) {
      return `// 暂不可预览：${(e as Error).message}`;
    }
  });

  constructor() {
    this.route.params.subscribe((params) => {
      const raw = params['fileName'];
      this.fileName = raw ? decodeURIComponent(String(raw)) : '';
      this.pageHeader.subtitle.set(this.fileName);
      void this.loadExisting();
    });
  }

  /** 读文档 → 拆成「规则面板 + 元信息表单」两路 */
  private async loadExisting(): Promise<void> {
    if (!this.fileName) {
      this.loading.set(false);
      return;
    }
    this.loading.set(true);
    try {
      const doc = await this.engine.readDoc(this.fileName);
      this.doc.set(doc);
      this.ruleBaseUrl.set(doc.homepage);
      this.name.set(doc.name);
      this.author.set(doc.author ?? '');
      this.homepage.set(doc.homepage);
      this.description.set(doc.description ?? '');
      this.version.set(doc.sourceVersion ?? '');
      this.updateUrl.set(doc.updateUrl ?? '');
      this.sourceType.set(doc.sourceType);
      this.tagsText.set((doc.tags ?? []).join(' '));
      this.urlsText.set((doc.urls ?? []).join('\n'));
      this.minDelayMs.set(doc.minDelayMs ?? 0);
      this.requireUrlsText.set((doc.requireUrls ?? []).join('\n'));
      this.enabled.set(doc.enabled);
      this.panel()?.setRules(doc.rules);
    } catch (e) {
      this.toast.error(`读取失败：${(e as Error).message}`);
    } finally {
      this.loading.set(false);
    }
  }

  /**
   * 拼出待存文档（**不校验**）
   *
   * `buildSourceDoc` 的入参是**闭合的 18 字段接口**（`BuildSourceDocInput`），
   * `buildSourceDoc` 也不会透传未列出的键 —— 所以"未来新增字段被抹掉"这件事不能靠
   * 展开运算符解决（`...current` 只会因 excess property 报错，且不改变行为）。
   * 真正的防线是 `editor-doc-roundtrip.spec.ts`：把一份字段齐全的文档过一遍本组件的
   * 拼装路径，断言存盘文本的每个字段都在 —— 新增字段忘了接表单，测试当场红。
   */
  private buildDraft(): BookSourceDocDraft {
    const current = this.doc();
    if (!current) throw new Error('文档未加载');
    const rules = this.panel()?.getRules() ?? current.rules;
    return buildSourceDoc({
      uuid: current.uuid,
      name: this.name().trim(),
      homepage: this.homepage().trim(),
      urls: splitLines(this.urlsText()),
      rules,
      headers: current.headers,
      enabled: this.enabled(),
      sourceType: this.sourceType(),
      author: this.author().trim() || undefined,
      description: this.description().trim() || undefined,
      tags: this.tagsText()
        .split(/[\s,，]+/)
        .map((t) => t.trim())
        .filter(Boolean),
      sourceVersion: this.version().trim(),
      updateUrl: this.updateUrl().trim() || undefined,
      minDelayMs: this.minDelayMs(),
      requireUrls: splitLines(this.requireUrlsText()),
      legadoRaw: current.legadoRaw,
    });
  }

  /**
   * 拼装 + **权威**校验 → 待写文本
   *
   * 主进程那份 `jsonEnvelopeError` 只做信封粗筛（D8：主进程不能 import `src/`，
   * 复制 schema 必然漂移），字段级规则以渲染端的 valibot schema 为准。校验不过就
   **不写盘** —— 写进去的坏文档会立刻在列表页变成「规则损坏」，引擎也拒绝加载。
   */
  private serializeValidatedDraft(): string {
    const parsed = v.safeParse(BookSourceDocSchema, this.buildDraft());
    if (!parsed.success) {
      const first = parsed.issues[0];
      throw new Error(first ? first.message : '未知校验错误');
    }
    return serializeSourceDoc(parsed.output);
  }

  async save(): Promise<void> {
    const api = typeof window !== 'undefined' ? window.pomAPI : undefined;
    if (!api?.booksourceSave) {
      this.toast.error('IPC 不可用');
      return;
    }
    let text: string;
    try {
      text = this.serializeValidatedDraft();
    } catch (e) {
      this.toast.error(`文档不合法，未保存：${(e as Error).message}`);
      return;
    }
    this.saving.set(true);
    try {
      await api.booksourceSave(this.fileName, text);
      this.toast.success(`保存成功：${this.fileName}`);
      void this.router.navigateByUrl('/book-sources');
    } catch (e) {
      this.toast.error(`保存失败：${(e as Error).message}`);
    } finally {
      this.saving.set(false);
    }
  }

  cancel(): void {
    void this.router.navigateByUrl('/book-sources');
  }
}

/** 多行文本 → 去空行/去重的字符串数组（`urls` / `requireUrls` 都是这个形态） */
function splitLines(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\n,，]/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}
