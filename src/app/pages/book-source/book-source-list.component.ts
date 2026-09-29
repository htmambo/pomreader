import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';

import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzSwitchModule } from 'ng-zorro-antd/switch';
import { NzTagModule } from 'ng-zorro-antd/tag';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzModalModule, NzModalService } from 'ng-zorro-antd/modal';
import { NzEmptyModule } from 'ng-zorro-antd/empty';
import { NzSpinModule } from 'ng-zorro-antd/spin';
import { NzTooltipModule } from 'ng-zorro-antd/tooltip';
import { NzAlertModule } from 'ng-zorro-antd/alert';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { PageHeaderService } from '../../core/services/page-header.service';
import { ToastService } from '../../core/services/toast.service';
import { type BookSourceMeta } from '../../core/book-source/source-meta.types';
import { BookSourceListStateService } from '../../core/book-source/book-source-list-state.service';
import { ImportLegadoComponent } from '../../modals/import-legado/import-legado.component';
import { BookSourceEngineSwitchComponent } from '../../shared/components/book-source-engine-switch/book-source-engine-switch.component';
import { BookSourceMigrateService } from '../../core/services/book-source-migrate.service';

/**
 * 书源管理列表页（实施计划 T-005）
 * - 拉取全部书源元数据，本地过滤
 * - 启停 / 编辑 / 删除（删除二次确认）
 * - 启停调 pomAPI.booksourceToggle，失败回滚 UI（DM-3）
 * - Esc 逐级回退：Modal 层交给 ng-zorro → 清空过滤词 → 停在列表页（见 onKeydown）
 *
 * 会话级现场由 BookSourceListStateService 持有（root）：过滤词/列表，
 * 路由切走再回来直接展示；后台再走一次 IPC 同步磁盘真实状态
 *
 * P3.2 新增三块：
 * ① 引擎运行时开关（`BookSourceEngineSwitchComponent`）—— 排障期不重启切链路
 * ② `rulesInvalid` 红标 —— 坏规则的源**仍在列表里**（用户要看得见要修），但明确标出
 * ③ needs-manual 归档区（常驻，不是弹窗）+ 首次进入的迁移汇总弹窗
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-book-source-list',
  imports: [
    FormsModule,
    NzButtonModule,
    NzSwitchModule,
    NzTagModule,
    NzInputModule,
    NzModalModule,
    NzEmptyModule,
    NzSpinModule,
    NzTooltipModule,
    NzAlertModule,
    NzIconModule,
    BookSourceEngineSwitchComponent,
  ],
  templateUrl: './book-source-list.component.html',
  styleUrl: './book-source-list.component.scss',
})
export class BookSourceListComponent {
  readonly state = inject(BookSourceListStateService);
  private readonly toast = inject(ToastService);
  private readonly modal = inject(NzModalService);
  private readonly router = inject(Router);
  private readonly pageHeader = inject(PageHeaderService);
  private readonly migrate = inject(BookSourceMigrateService);

  /** 是否还在首次加载（首次成功前显示 spinner，已加载过则走后台刷新不阻塞） */
  readonly firstLoading = computed(() => !this.state.loaded());

  /** needs-manual 归档区是否展开（默认收起：绝大多数用户没有这类源） */
  readonly legacyExpanded = signal(false);

  readonly filtered = computed<BookSourceMeta[]>(() => {
    const q = this.state.filter().trim().toLowerCase();
    const all = this.state.sources();
    if (!q) return all;
    return all.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        (s.author ?? '').toLowerCase().includes(q) ||
        s.tags.some((t) => t.toLowerCase().includes(q)),
    );
  });

  constructor() {
    // stale-while-revalidate：已加载过则后台静默刷新，未加载过则首次带 loading 拉取
    if (this.state.loaded()) {
      void this.refresh(false);
    } else {
      void this.refresh(true);
    }
    // 迁移汇总弹窗：读一次即删（主进程侧语义），下次进来不再打扰
    void this.showMigrationReport();
    // 副标题随 sources 数量变化 —— 「共 N 个书源」由本组件单独维护
    // 两个 signal 不同源，不会形成循环；Angular 22 起 effect 写 signal 默认允许
    // （allowSignalWrites flag 已废弃为空操作，故不再传）
    effect(() => {
      this.pageHeader.subtitle.set(`共 ${this.state.sources().length} 个书源`);
    });
  }

  /**
   * 迁移汇总（一次）：有 needs-manual / failed 条目时弹窗列出
   *
   * **只在"确有需要用户处理的事"时弹**：`converted` 是系统自己干的事，不需要打扰用户；
   * `needsManual` 与 `failed` 才是"你的书源出了状况"，不弹就等于没告知。
   */
  private async showMigrationReport(): Promise<void> {
    const report = await this.migrate.readReport();
    if (!report) return;
    const needsAttention = report.needsManual.length + report.failed.length;
    if (needsAttention === 0) return;
    const lines = [
      ...report.needsManual.map(
        (i) => `需手动处理：${i.fileName}${i.reason ? `（${i.reason}）` : ''}`,
      ),
      ...report.failed.map((i) => `处理失败：${i.fileName}（${i.reason}）`),
    ];
    this.modal.warning({
      nzTitle: '部分书源未能迁移到规则文档',
      nzContent: lines.join('\n'),
      nzOkText: '知道了',
      nzFooter: null,
    });
  }

  /** 拉取全量书源元数据（showLoading=false 时走后台静默刷新，不阻塞 UI） */
  async refresh(showLoading: boolean): Promise<void> {
    try {
      await this.state.refresh(showLoading);
    } catch (e) {
      this.toast.error(`加载失败：${(e as Error).message}`);
    }
  }

  /** 启停切换：失败由 state 服务回滚 UI */
  async toggle(src: BookSourceMeta, next: boolean): Promise<void> {
    try {
      await this.state.toggle(src, next);
      this.toast.success(`${next ? '启用' : '禁用'}：${src.name}`);
    } catch (e) {
      this.toast.error(`操作失败：${(e as Error).message}`);
    }
  }

  /** 二次确认后删除；本地列表同步移除（state.remove 内部完成） */
  confirmDelete(src: BookSourceMeta): void {
    this.modal.confirm({
      nzTitle: `删除书源：${src.name}？`,
      nzContent: '删除后无法恢复，需重新导入。',
      nzOkText: '删除',
      nzOkDanger: true,
      nzCancelText: '取消',
      nzOnOk: async () => {
        try {
          await this.state.remove(src);
          this.toast.success(`已删除：${src.name}`);
        } catch (e) {
          this.toast.error(`删除失败：${(e as Error).message}`);
        }
      },
    });
  }

  /** 跳转编辑器（编辑现有书源） */
  openEditor(src: BookSourceMeta): void {
    void this.router.navigateByUrl(`/book-sources/edit/${encodeURIComponent(src.fileName)}`);
  }

  /** 跳转智能添加页（输入 URL → 启发式探测 → 规则面板 → 生成书源） */
  openSmartAdd(): void {
    void this.router.navigateByUrl('/book-sources/smart-add');
  }

  /** 跳转调试书源页（?source=fileName 预选 —— 调试页 load 时读 queryParam 预填选中项） */
  openDebug(src: BookSourceMeta): void {
    void this.router.navigate(['/book-sources/debug'], { queryParams: { source: src.fileName } });
  }

  /** 打开 Legado 订阅源导入弹窗；导入完成后刷新列表 */
  openLegadoImport(): void {
    this.modal.create({
      nzTitle: '导入 Legado 订阅源',
      nzContent: ImportLegadoComponent,
      nzData: { onImported: () => void this.refresh(false) },
      nzFooter: null,
      nzWidth: 640,
      nzMaskClosable: false,
    });
  }

  /**
   * 查看归档目录里某个 `.js` 的原文
   *
   * needs-manual 的源没有 JSON 文档，**唯一的救回路径**就是看原始 JS 再手动改写规则
   * （T-13 的重写指引会基于这个弹窗补）。用只读 textarea 展示而非下载：用户要的是
   * "照着改"，不是"存一份"。源文件可能被删（用户清了 legacy 目录），故读失败要有话可说。
   */
  viewLegacySource(src: BookSourceMeta): void {
    const pom = typeof window !== 'undefined' ? window.pomAPI : undefined;
    if (!pom?.booksourceRead) {
      this.toast.error('IPC 不可用，无法读取归档书源');
      return;
    }
    void pom
      .booksourceRead(src.fileName, src.sourceDir)
      .then((content) => {
        this.modal.info({
          nzTitle: `${src.name}（${src.fileName}）`,
          nzContent: `<pre style="max-height:60vh;overflow:auto;white-space:pre-wrap;font-size:12px">${escapeHtml(
            clipForPreview(content),
          )}</pre>`,
          nzWidth: 760,
          nzFooter: null,
        });
      })
      .catch((e: unknown) => this.toast.error(`读取失败：${(e as Error).message}`));
  }

  /**
   * Esc 逐级回退（与阅读页 reader.component.ts 的 Esc 栈同构）
   *
   * 回退栈（到达本页基态即停，不跨模块跳书架）：
   *   ① 顶层 Modal（删除确认 / Legado 导入）→ 由 ng-zorro 自己关闭，见下
   *   ② 过滤词非空 → 清空过滤词
   *   ③ 已达基态 → 不响应（终态就是「列表」页本身）
   *
   * ① 为什么本组件不自己关弹窗：ng-zorro 18 的 Modal 已通过 CDK Overlay 的
   * keydownEvents() + nzKeyboard（默认 true）接管 Esc，组件再调 triggerCancel()
   * 属冗余。故此处必须**直接 return**：既不能 preventDefault 也不能 stopPropagation，
   * 一旦阻断 CDK 在 document 上的监听，弹窗将关不掉。
   * （ng-zorro 判的是废弃的 event.keyCode === ESCAPE 且 !hasModifierKey，
   *   本组件用现代的 event.key；两者监听同一 document 上的同一事件，互不干扰。）
   *
   * 与阅读页的一处**有意分歧**：reader 在无 Modal 且处于输入态时让 Esc 静默
   * （避免丢用户输入）。本页的过滤框就是主交互，且过滤词是页面级状态而非
   * 输入框局部状态，故 Esc 在输入态同样响应——清空过滤词正是回退栈的第 ② 层。
   */
  @HostListener('document:keydown', ['$event'])
  onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    // 第 ① 层：Modal 打开时放行，交给 ng-zorro 关闭顶层弹窗（见上方注释）
    if (this.modal.openModals.length > 0) return;
    // 第 ② 层：清空过滤词（输入态也响应，不做 inEditable 拦截）
    if (this.state.filter()) {
      event.preventDefault();
      this.state.filter.set('');
    }
    // 第 ③ 层：已达基态 —— 终态即本页，不再回退
  }
}

/**
 * HTML 转义 —— 弹窗内容走 `innerHTML`（`nzContent` 接受字符串）
 *
 * 书源 `.js` 是**用户自己的文件**，但内容来自磁盘、也可能来自第三方分享的链接：
 * 直接塞进 `innerHTML` 就是一条 XSS 执行路径（`<img onerror=…>` 就能跑）。
 * 存根里不引 `DomSanitizer`（`bypassSecurityTrustHtml` 正是要避免的东西），
 * 用纯转义函数最省事也最安全。
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 预览上限：超过就截断（外部评审 R1 P3） */
const LEGACY_PREVIEW_MAX = 200_000;

/**
 * 归档 JS 预览的截断
 *
 * 内容走 `innerHTML`，一个几 MB 的 `.js` 会生成同等体量的文本节点 + 一次同步布局，
 * 表现为"点开就卡住"。截断时明确告知还剩多少 —— 静默截断会让用户以为那就是全文。
 * 完整内容用户仍可从 `booksources_legacy/` 用文件管理器打开。
 */
function clipForPreview(text: string): string {
  if (text.length <= LEGACY_PREVIEW_MAX) return text;
  const kept = text.slice(0, LEGACY_PREVIEW_MAX);
  return `${kept}\n\n… （已截断：全文共 ${text.length} 字符，完整文件在 booksources_legacy/ 目录）`;
}
