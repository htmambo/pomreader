import { Component, ChangeDetectionStrategy, computed, inject, signal } from '@angular/core';

import { FormsModule } from '@angular/forms';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzRadioModule } from 'ng-zorro-antd/radio';
import { NzSpinModule } from 'ng-zorro-antd/spin';
import { NzEmptyModule } from 'ng-zorro-antd/empty';
import { NzInputNumberModule } from 'ng-zorro-antd/input-number';
import { ToastService } from '../../core/services/toast.service';
import { type BookSourceMeta } from '../../core/book-source/source-meta.types';
import {
  SourceTestService,
  DEFAULT_TEST_KEYWORD,
  type TestStepResult,
} from '../../core/book-source/source-test/source-test.service';

type PomList = { booksourceList?: () => Promise<BookSourceMeta[]> };

interface TestSourceState {
  fileName: string;
  status: 'idle' | 'running' | 'done';
  steps: TestStepResult[];
  allPassed: boolean | null;
  logs: string[];
}

const STEP_LABELS: Record<string, string> = {
  load: '加载',
  search: '搜索',
  bookInfo: '详情',
  chapterList: '目录',
  chapterContent: '正文',
  explore: '发现',
};

/**
 * 书源测试页（迁移自 legado TestSourcesTab）
 * 差异：原项目测试引擎是 Rust stub（未实现），此处走 pomreader 沙箱（SourceTestService）；
 * 原项目 script:http 实时日志依赖引擎事件总线，pomreader 沙箱无此通道 → 日志粒度为步骤级
 */
@Component({
  selector: 'app-book-source-test',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    NzButtonModule,
    NzIconModule,
    NzInputModule,
    NzRadioModule,
    NzSpinModule,
    NzEmptyModule,
    NzInputNumberModule,
  ],
  templateUrl: './book-source-test.component.html',
  preserveWhitespaces: true,
  styles: [
    `
      .toolbar {
        display: flex;
        align-items: center;
        gap: 12px;
        margin-bottom: 12px;
        flex-wrap: wrap;
      }
      .progress-text {
        font-size: 13px;
        color: var(--pom-text-muted);
      }
      .settings {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-left: auto;
        flex-wrap: wrap;
      }
      .settings-label {
        font-size: 12px;
        color: var(--pom-text-muted);
        white-space: nowrap;
      }
      .keyword-input {
        width: 110px;
      }
      nz-input-number {
        width: 76px;
      }
      .body {
        display: grid;
        grid-template-columns: 280px 1fr;
        gap: 12px;
        min-height: 0;
        height: calc(100vh - 240px);
      }
      .list {
        display: flex;
        flex-direction: column;
        gap: 4px;
        overflow-y: auto;
        padding-right: 4px;
      }
      .item {
        padding: 8px 10px;
        border-radius: 4px;
        background: var(--pom-card);
        border: 1px solid var(--pom-border);
      }
      .item--running {
        border-color: var(--pom-accent);
      }
      .item--pass {
        border-left: 3px solid #52c41a;
      }
      .item--fail {
        border-left: 3px solid #ff4d4f;
      }
      .item-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }
      .item-name {
        font-size: 13px;
        font-weight: 500;
        color: var(--pom-text);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        min-width: 0;
      }
      .steps {
        display: flex;
        flex-wrap: wrap;
        gap: 4px 8px;
        margin-top: 4px;
        align-items: center;
      }
      .step {
        font-size: 11px;
        color: var(--pom-text-muted);
        white-space: nowrap;
      }
      .step--pass {
        color: #52c41a;
      }
      .step--fail {
        color: #ff4d4f;
      }
      .log {
        display: flex;
        flex-direction: column;
        border: 1px solid var(--pom-border);
        border-radius: 4px;
        overflow: hidden;
        min-height: 0;
      }
      .log-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 6px 10px;
        background: var(--pom-card);
        border-bottom: 1px solid var(--pom-border);
        gap: 8px;
      }
      .log-body {
        flex: 1;
        overflow-y: auto;
        padding: 8px 10px;
        font-family: 'Cascadia Code', Consolas, monospace;
        font-size: 12px;
        line-height: 1.6;
        color: var(--pom-text);
        background: var(--pom-bg);
      }
      .log-empty {
        color: var(--pom-text-muted);
        font-style: italic;
        padding: 24px 0;
        text-align: center;
      }
      .log-line {
        white-space: pre-wrap;
        word-break: break-all;
      }
      .log-line--pass {
        color: #52c41a;
      }
      .log-line--fail {
        color: #ff4d4f;
      }
      .log-line--banner {
        color: var(--pom-text-muted);
        font-weight: 500;
        opacity: 0.85;
      }
    `,
  ],
})
export class BookSourceTestComponent {
  readonly loading = signal(false);
  readonly sources = signal<BookSourceMeta[]>([]);
  readonly running = signal(false);
  readonly states = signal<Record<string, TestSourceState>>({});
  readonly batchLogs = signal<string[]>([]);
  readonly progress = signal({ current: 0, total: 0 });

  keyword = DEFAULT_TEST_KEYWORD;
  concurrency = 5;
  itemTimeoutSecs = 30;
  totalTimeoutSecs = 0;
  // signal 而非普通属性 —— filteredLogs computed 依赖它，普通属性变更不触发重算
  readonly logFilter = signal<'all' | 'pass' | 'fail'>('all');

  readonly enabledSources = computed(() => this.sources().filter((s) => s.enabled));
  readonly passCount = computed(
    () => Object.values(this.states()).filter((s) => s.allPassed === true).length,
  );
  readonly failCount = computed(
    () => Object.values(this.states()).filter((s) => s.allPassed === false).length,
  );
  readonly hasResult = computed(() =>
    Object.values(this.states()).some((s) => s.allPassed !== null),
  );

  readonly filteredLogs = computed(() => {
    const lines: string[] = [];
    const batch = this.batchLogs();
    if (batch.length > 0) lines.push(batch[0]);
    for (const st of Object.values(this.states())) {
      if (this.logFilter() === 'pass' && st.allPassed !== true) continue;
      if (this.logFilter() === 'fail' && st.allPassed !== false) continue;
      lines.push(...st.logs);
    }
    if (batch.length > 1) lines.push(...batch.slice(1));
    return lines;
  });

  private readonly testService = inject(SourceTestService);
  private readonly toast = inject(ToastService);

  constructor() {
    void this.load();
  }

  async load(): Promise<void> {
    const api = (window as unknown as { pomAPI?: PomList }).pomAPI;
    if (!api?.booksourceList) {
      this.toast.error('IPC 不可用');
      return;
    }
    this.loading.set(true);
    try {
      const list = await api.booksourceList();
      this.sources.set(Array.isArray(list) ? list : []);
    } catch (e) {
      this.toast.error(`加载失败：${(e as Error).message}`);
    } finally {
      this.loading.set(false);
    }
  }

  stepLabel(step: string): string {
    return STEP_LABELS[step] ?? step;
  }

  /** 索引访问在模板中视为非空 → 用方法返回 undefined 保持 ?. 语义（NG8107） */
  stateOf(fileName: string): TestSourceState | undefined {
    return this.states()[fileName];
  }

  isPassLine(line: string): boolean {
    return line.includes('✅') || (line.includes('✓') && !line.includes('✗'));
  }

  isFailLine(line: string): boolean {
    return line.includes('❌') || line.includes('✗');
  }

  /** 单书源测试（批量 worker 也走这里） */
  async runSingle(src: BookSourceMeta): Promise<void> {
    const st: TestSourceState = {
      fileName: src.fileName,
      status: 'running',
      steps: [],
      allPassed: null,
      logs: [],
    };
    this.patchState(src.fileName, st);
    this.pushLog(st, `▶ 开始测试: ${src.name || src.fileName}`);
    try {
      const result = await this.testService.runTest(
        src,
        this.keyword.trim() || DEFAULT_TEST_KEYWORD,
        this.itemTimeoutSecs,
      );
      st.steps = result.steps;
      st.allPassed = result.allPassed;
      st.status = 'done';
      for (const step of result.steps) {
        this.pushLog(
          st,
          `  ${step.passed ? '✓' : '✗'} [${this.stepLabel(step.step)}] ${step.message} (${step.durationMs}ms)`,
        );
      }
      this.pushLog(st, `  ${result.allPassed ? '✅ 全部通过' : '❌ 存在失败'}`);
    } catch (e) {
      st.status = 'done';
      st.allPassed = false;
      this.pushLog(st, `  ✗ 测试异常: ${(e as Error).message}`);
    }
    this.patchState(src.fileName, { ...st });
  }

  /** 批量测试：并发 worker + 总超时中断（迁移 legado runAllTests 逻辑） */
  async runAll(): Promise<void> {
    const list = this.enabledSources();
    if (list.length === 0) return;
    this.running.set(true);
    this.batchLogs.set([]);
    this.states.set({});
    this.progress.set({ current: 0, total: list.length });

    const concurrencyVal = Math.max(1, this.concurrency);
    this.pushBatchLog(
      `═══ 开始批量测试 (${list.length} 个书源, 并发: ${concurrencyVal}${this.totalTimeoutSecs > 0 ? `, 总超时: ${this.totalTimeoutSecs}s` : ''}) ═══`,
    );

    const startTime = Date.now();
    let aborted = false;
    const cursor = { next: 0 };

    const worker = async (): Promise<void> => {
      for (;;) {
        if (aborted) break;
        const idx = cursor.next++;
        if (idx >= list.length) break;
        try {
          await this.runSingle(list[idx]);
        } catch {
          /* runSingle 内部已兜底 */
        }
        this.progress.update((p) => ({ ...p, current: p.current + 1 }));
        if (this.totalTimeoutSecs > 0 && Date.now() - startTime > this.totalTimeoutSecs * 1000) {
          aborted = true;
          break;
        }
      }
    };

    try {
      await Promise.all(Array.from({ length: Math.min(concurrencyVal, list.length) }, worker));
    } finally {
      const skipped = Object.values(this.states()).filter((s) => s.allPassed === null).length;
      this.pushBatchLog(
        `═══ 测试完成: ${this.passCount()} 通过, ${this.failCount()} 失败, ${skipped} 跳过${aborted ? ' (已超时中断)' : ''} ═══`,
      );
      this.running.set(false);
    }
  }

  clearLogs(): void {
    this.batchLogs.set([]);
    const cleared: Record<string, TestSourceState> = {};
    for (const [k, v] of Object.entries(this.states())) cleared[k] = { ...v, logs: [] };
    this.states.set(cleared);
  }

  private patchState(fileName: string, st: TestSourceState): void {
    this.states.update((m) => ({ ...m, [fileName]: st }));
  }

  private pushLog(st: TestSourceState, msg: string): void {
    const ts = new Date().toLocaleTimeString();
    st.logs = [...st.logs, `[${ts}] ${msg}`];
    this.patchState(st.fileName, { ...st });
  }

  private pushBatchLog(msg: string): void {
    const ts = new Date().toLocaleTimeString();
    this.batchLogs.update((arr) => [...arr, `[${ts}] ${msg}`]);
  }
}
