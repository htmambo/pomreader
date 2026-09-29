/**
 * 书源迁移报告弹窗（方案 §4.2 流程末尾 / §4.3）
 *
 * 渲染端启动后读一次 `booksourceMigrationReport()`（主进程读后删）；
 * 有归档项（迁移数 > 0 或 needs-manual 数 > 0）时由 AppComponent 弹本组件汇总：
 * 迁移成功 N / 骨架 M / needs-manual K + legacy 目录路径提示。
 */
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';

import { NZ_MODAL_DATA, NzModalRef } from 'ng-zorro-antd/modal';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzAlertModule } from 'ng-zorro-antd/alert';
import { NzTagModule } from 'ng-zorro-antd/tag';

/** 迁移报告形状（electron/ipc/booksource-migrate.ts MigrationReport 的渲染端镜像） */
export interface MigrationReportView {
  generatedAt: string;
  /** legacy 目录绝对路径 */
  legacyDir: string;
  totals: {
    total: number;
    migrated: number;
    skeleton: number;
    needsManual: number;
    skipped: number;
  };
  entries: {
    fileName: string;
    outcome: 'migrated' | 'skeleton' | 'needs-manual' | 'skipped';
    reason?: string;
    jsonFileName?: string;
  }[];
}

@Component({
  selector: 'app-book-source-migration-report',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NzButtonModule, NzAlertModule, NzTagModule],
  template: `
    <p>
      旧版 JS 书源已迁移为 JSON 规则书源： 成功
      <strong>{{ report.totals.migrated }}</strong> 个
      @if (report.totals.skeleton > 0) {
        ，骨架 <strong>{{ report.totals.skeleton }}</strong> 个（已禁用，请补全规则后再启用）
      }
      @if (report.totals.needsManual > 0) {
        ，<strong class="warn">{{ report.totals.needsManual }}</strong> 个无法自动转换
      }
      。
    </p>
    @if (report.totals.needsManual > 0) {
      <nz-alert
        nzType="warning"
        nzMessage="以下书源无法自动转换（可能含自定义 JS），已在书源列表末尾标灰，可查看原始 JS 或删除："
        nzShowIcon
      ></nz-alert>
      <ul class="manual-list">
        @for (e of needsManualEntries; track e.fileName) {
          <li>
            <nz-tag>{{ e.fileName }}</nz-tag>
            <span class="reason">{{ e.reason }}</span>
          </li>
        }
      </ul>
    }
    <p class="legacy-dir">原始 JS 备份目录（只读，永不自动删除）：{{ report.legacyDir }}</p>
    <div class="footer">
      <button nz-button nzType="primary" (click)="modal.close()">知道了</button>
    </div>
  `,
  styles: [
    `
      .warn {
        color: #faad14;
      }
      .manual-list {
        margin: 8px 0;
        padding-left: 4px;
        list-style: none;
        max-height: 200px;
        overflow: auto;
      }
      .manual-list li {
        display: flex;
        align-items: baseline;
        gap: 8px;
        margin-bottom: 4px;
      }
      .reason {
        color: var(--pom-text-muted);
        font-size: 12px;
      }
      .legacy-dir {
        color: var(--pom-text-muted);
        font-size: 12px;
        word-break: break-all;
      }
      .footer {
        display: flex;
        justify-content: flex-end;
      }
    `,
  ],
})
export class BookSourceMigrationReportComponent {
  readonly report = inject<MigrationReportView>(NZ_MODAL_DATA);
  readonly modal = inject(NzModalRef);

  get needsManualEntries(): MigrationReportView['entries'] {
    return this.report.entries.filter((e) => e.outcome === 'needs-manual');
  }
}
