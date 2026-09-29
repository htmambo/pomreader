import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  computed,
  effect,
  inject,
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
import { PageHeaderService } from '../../core/services/page-header.service';
import { ToastService } from '../../core/services/toast.service';
import { type BookSourceMeta } from '../../core/book-source/source-meta.types';
import {
  BookSourceListStateService,
  type LegacySourceItem,
} from '../../core/book-source/book-source-list-state.service';
import { ImportLegadoComponent } from '../../modals/import-legado/import-legado.component';
import { ExportBookSourcesComponent } from '../../modals/export-book-sources/export-book-sources.component';
import { ImportBookSourceBundleComponent } from '../../modals/import-book-source-bundle/import-book-source-bundle.component';
import { BookSourceSubscriptionsComponent } from '../../modals/book-source-subscriptions/book-source-subscriptions.component';
import { LegacyConvertTryComponent } from '../../modals/legacy-convert-try/legacy-convert-try.component';

type PomRead = {
  booksourceRead?: (fileName: string, sourceDir?: string) => Promise<string>;
};

function pomApi(): PomRead | null {
  if (typeof window === 'undefined') return null;
  return (window.pomAPI as unknown as PomRead | undefined) ?? null;
}

/**
 * 书源管理列表页（实施计划 T-005；P3 切 JSON 链路，方案 §5）
 * - 数据源 = booksourceListJson（state 服务内）；meta.rulesInvalid 非空 → 行内红标
 * - needs-manual legacy 源（§4.3）：列表末尾标灰 + 「查看原始 JS」「删除」
 * - 启停 / 编辑 / 删除（删除二次确认）；启停失败回滚 UI（DM-3）
 * - Esc 逐级回退：Modal 层交给 ng-zorro → 清空过滤词 → 停在列表页（见 onKeydown）
 *
 * 会话级现场由 BookSourceListStateService 持有（root）：过滤词/列表，
 * 路由切走再回来直接展示；后台再走一次 IPC 同步磁盘真实状态
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

  /** 是否还在首次加载（首次成功前显示 spinner，已加载过则走后台刷新不阻塞） */
  readonly firstLoading = computed(() => !this.state.loaded());

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
    // 副标题随 sources 数量变化 —— 「共 N 个书源」由本组件单独维护
    // 两个 signal 不同源，不会形成循环；Angular 22 起 effect 写 signal 默认允许
    // （allowSignalWrites flag 已废弃为空操作，故不再传）
    effect(() => {
      this.pageHeader.subtitle.set(`共 ${this.state.sources().length} 个书源`);
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

  /** 「查看原始 JS」（§4.3）：读 legacy 文件内容，Modal 只读展示 */
  async viewLegacySource(item: LegacySourceItem): Promise<void> {
    const api = pomApi();
    if (!api?.booksourceRead) {
      this.toast.error('IPC 不可用');
      return;
    }
    try {
      const content = await api.booksourceRead(item.fileName, item.sourceDir);
      // nzContent 字符串走 innerHTML 渲染 → 必须转义（源码含 <> & 字符）
      const escaped = content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      this.modal.info({
        nzTitle: `原始 JS：${item.fileName}`,
        nzContent: `<pre style="max-height:60vh;overflow:auto;white-space:pre-wrap;word-break:break-all;font-size:12px;">${escaped}</pre>`,
        nzWidth: 720,
        nzOkText: '关闭',
      });
    } catch (e) {
      this.toast.error(`读取失败：${(e as Error).message}`);
    }
  }

  /** 「尝试转换」（§4.3）：主进程只读转换尝试 + 渲染端格式验证，弹窗展示详细结果，可一键保存 */
  tryConvertLegacy(item: LegacySourceItem): void {
    const jsonFileName = item.fileName.replace(/\.js$/i, '.json');
    const existingJson = this.state.sources().some((s) => s.fileName === jsonFileName);
    const ref = this.modal.create({
      nzTitle: `尝试转换：${item.fileName}`,
      nzContent: LegacyConvertTryComponent,
      nzData: { fileName: item.fileName, existingJson },
      nzFooter: null,
      nzWidth: 720,
      nzMaskClosable: false,
    });
    ref.afterClose.subscribe((result: unknown) => {
      if (result === 'saved') void this.refresh(false);
    });
  }

  /** 「删除」legacy 源（§4.3）：二次确认后复用通用 delete channel（按路径删 + 清 marker） */
  confirmDeleteLegacy(item: LegacySourceItem): void {
    this.modal.confirm({
      nzTitle: `删除未迁移书源：${item.fileName}？`,
      nzContent: '该文件位于 booksources_legacy/，删除后无法恢复。',
      nzOkText: '删除',
      nzOkDanger: true,
      nzCancelText: '取消',
      nzOnOk: async () => {
        try {
          await this.state.removeLegacy(item);
          this.toast.success(`已删除：${item.fileName}`);
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

  /** 打开书源 bundle 导入预览弹窗（Phase 1，设计 §6.4）；导入完成后刷新列表 */
  openBundleImport(): void {
    this.modal.create({
      nzTitle: '导入书源',
      nzContent: ImportBookSourceBundleComponent,
      nzData: { onImported: () => void this.refresh(false) },
      nzFooter: null,
      nzWidth: 720,
      nzMaskClosable: false,
    });
  }

  /** 打开书源 bundle 导出弹窗（Phase 1，设计 §6.4） */
  openBundleExport(): void {
    this.modal.create({
      nzTitle: '导出书源',
      nzContent: ExportBookSourcesComponent,
      nzFooter: null,
      nzWidth: 640,
      nzMaskClosable: false,
    });
  }

  /** 打开书源订阅管理弹窗（Phase 2，设计 §6.4）；订阅写入后列表刷新走 pom:booksource-updated 广播 */
  openSubscriptions(): void {
    this.modal.create({
      nzTitle: '书源订阅',
      nzContent: BookSourceSubscriptionsComponent,
      nzFooter: null,
      nzWidth: 760,
      nzMaskClosable: false,
    });
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
