import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';

import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzSpinModule } from 'ng-zorro-antd/spin';
import { NZ_MODAL_DATA, NzModalRef } from 'ng-zorro-antd/modal';
import * as v from 'valibot';
import { BookSourceDocSchema } from '../../core/models/book-source-doc.model';
import { ToastService } from '../../core/services/toast.service';

/** pom:booksource-legacy-convert-try 返回（镜像 electron JsConversion，跨边界无共享类型） */
export interface LegacyConvertTryResult {
  outcome: 'ok' | 'skeleton' | 'needs-manual';
  uuid: string;
  jsonFileName: string;
  doc?: unknown;
  reason?: string;
}

/** nzData 入参 */
export interface LegacyConvertTryData {
  fileName: string;
  /** 目标 .json 是否已存在（保存将覆盖，仅提示） */
  existingJson: boolean;
}

/** PomAPI 子集（全局 Window.pomAPI 在 page-fetcher.service.ts 声明） */
type PomLegacyConvertTry = {
  booksourceLegacyConvertTry?: (fileName: string) => Promise<LegacyConvertTryResult>;
  booksourceSaveJson?: (fileName: string, doc: unknown) => Promise<void>;
};

function pomApi(): PomLegacyConvertTry | null {
  if (typeof window === 'undefined') return null;
  return (window.pomAPI as unknown as PomLegacyConvertTry | undefined) ?? null;
}

/**
 * legacy .js「尝试转换」弹窗（§4.3 needs-manual 行内动作）：
 * 主进程只读转换尝试（与启动迁移同口径 convertJsContent）→ 成功展示转换结果 +
 * 渲染端 valibot BookSourceDocSchema 全量格式验证 + JSON 预览，可一键保存到书源目录；
 * 失败展示详细原因（逐字段缺失/违规声明清单）与处理建议。原始 .js 永不改动。
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-legacy-convert-try',
  imports: [NzButtonModule, NzSpinModule],
  template: `
    @if (loading()) {
      <div class="try-loading"><nz-spin nzSimple></nz-spin> 正在尝试转换…</div>
    } @else if (result(); as r) {
      @if (r.outcome === 'needs-manual') {
        <p class="try-verdict try-verdict--fail">✗ 无法自动转换</p>
        <p class="try-reason">{{ r.reason }}</p>
        <ul class="try-hints">
          <li>按上述原因补全头注释 / 规则常量后重试；</li>
          <li>或在编辑器打开该 .js 人工转换（保存落盘同名 .json）；</li>
          <li>也可用 CLI 批量诊断：node scripts/convert-booksource.ts &lt;目录&gt;。</li>
        </ul>
        <div class="try-actions">
          <button nz-button (click)="close()">关闭</button>
        </div>
      } @else {
        <p class="try-verdict try-verdict--ok">
          ✓ 可自动转换{{
            r.outcome === 'skeleton' ? '（legado 骨架源：rules 为占位，legadoRaw 已内嵌）' : ''
          }}
        </p>
        <p class="try-meta">uuid：{{ r.uuid }} ｜ 目标文件：{{ r.jsonFileName }}</p>
        @if (validation(); as check) {
          @if (check.ok) {
            <p class="try-verify try-verify--ok">格式验证：✓ 通过 BookSourceDocSchema 全量校验</p>
          } @else {
            <div class="try-verify try-verify--fail">
              <p>格式验证：✗ 未通过 BookSourceDocSchema（{{ check.issues.length }} 处）</p>
              <ul>
                @for (issue of check.issues; track $index) {
                  <li>{{ issue }}</li>
                }
              </ul>
            </div>
          }
        }
        @if (existingJson) {
          <p class="try-overwrite">⚠ 书源目录已存在同名 {{ r.jsonFileName }}，保存将覆盖它</p>
        }
        <pre class="try-json">{{ docJson() }}</pre>
        <div class="try-actions">
          <button nz-button (click)="close()">关闭</button>
          <button
            nz-button
            nzType="primary"
            [disabled]="saving() || validation()?.ok !== true"
            (click)="save()"
          >
            {{ saving() ? '保存中…' : '保存到书源目录' }}
          </button>
        </div>
      }
    }
  `,
  styles: `
    .try-loading {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 24px 0;
      justify-content: center;
    }
    .try-verdict {
      font-weight: 600;
      margin: 4px 0;
    }
    .try-verdict--fail {
      color: var(--pom-danger, #b53d3d);
    }
    .try-verdict--ok {
      color: var(--pom-success, #2d5a3d);
    }
    .try-reason {
      font-size: 13px;
      line-height: 1.6;
      white-space: pre-wrap;
      word-break: break-all;
    }
    .try-hints {
      margin: 8px 0;
      padding-left: 18px;
      font-size: 12px;
      color: var(--pom-text-muted);
      line-height: 1.7;
    }
    .try-meta {
      font-size: 12px;
      color: var(--pom-text-muted);
    }
    .try-verify {
      font-size: 13px;
      margin: 8px 0;
    }
    .try-verify--ok {
      color: var(--pom-success, #2d5a3d);
    }
    .try-verify--fail {
      color: var(--pom-danger, #b53d3d);
    }
    .try-verify--fail ul {
      margin: 4px 0;
      padding-left: 18px;
      font-size: 12px;
      max-height: 120px;
      overflow: auto;
    }
    .try-overwrite {
      font-size: 12px;
      color: #8a6d3b;
    }
    .try-json {
      max-height: 40vh;
      overflow: auto;
      padding: 10px 12px;
      border: 1px solid var(--pom-border);
      border-radius: 4px;
      font-size: 12px;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-all;
    }
    .try-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 8px;
    }
  `,
})
export class LegacyConvertTryComponent {
  private readonly data = inject<LegacyConvertTryData>(NZ_MODAL_DATA);
  private readonly modalRef = inject(NzModalRef);
  private readonly toast = inject(ToastService);

  readonly fileName = this.data.fileName;
  readonly existingJson = this.data.existingJson;
  readonly loading = signal(true);
  readonly saving = signal(false);
  readonly result = signal<LegacyConvertTryResult | null>(null);

  /** 渲染端 valibot 全量格式验证（主进程结构探针之外的第二道，设计 §4.2 双保险同口径） */
  readonly validation = computed(() => {
    const r = this.result();
    if (!r || r.outcome === 'needs-manual' || !r.doc) return null;
    const parsed = v.safeParse(BookSourceDocSchema, r.doc);
    if (parsed.success) return { ok: true, issues: [] as string[] };
    return {
      ok: false,
      issues: parsed.issues.map(
        (i) => `${i.path?.map((p) => String(p.key)).join('.') || '(root)'}: ${i.message}`,
      ),
    };
  });

  readonly docJson = computed(() => {
    const r = this.result();
    return r?.doc ? JSON.stringify(r.doc, null, 2) : '';
  });

  constructor() {
    void this.run();
  }

  private failResult(reason: string): LegacyConvertTryResult {
    return { outcome: 'needs-manual', uuid: this.fileName, jsonFileName: this.fileName, reason };
  }

  private async run(): Promise<void> {
    const api = pomApi();
    if (!api?.booksourceLegacyConvertTry) {
      this.result.set(this.failResult('IPC 不可用'));
      this.loading.set(false);
      return;
    }
    try {
      this.result.set(await api.booksourceLegacyConvertTry(this.fileName));
    } catch (e) {
      this.result.set(this.failResult(`转换执行失败: ${(e as Error).message}`));
    } finally {
      this.loading.set(false);
    }
  }

  /** 保存到书源目录（原始 .js 不动；保存后列表页刷新） */
  async save(): Promise<void> {
    const r = this.result();
    if (!r?.doc || this.validation()?.ok !== true) return;
    const api = pomApi();
    if (!api?.booksourceSaveJson) {
      this.toast.error('IPC 不可用');
      return;
    }
    this.saving.set(true);
    try {
      await api.booksourceSaveJson(r.jsonFileName, r.doc);
      this.toast.success(`已保存：${r.jsonFileName}（原始 .js 保留在 legacy 目录）`);
      this.modalRef.close('saved');
    } catch (e) {
      this.toast.error(`保存失败：${(e as Error).message}`);
    } finally {
      this.saving.set(false);
    }
  }

  close(): void {
    this.modalRef.close();
  }
}
