import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NzRadioModule } from 'ng-zorro-antd/radio';
import { NzTooltipModule } from 'ng-zorro-antd/tooltip';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { NzMessageService } from 'ng-zorro-antd/message';
import {
  BOOK_SOURCE_ENGINES,
  readBookSourceEngine,
  writeBookSourceEngine,
  type BookSourceEngine,
} from '../../../core/book-source/feature-flag';
import { BookSourceRegistry } from '../../../core/book-source/book-source.registry';

const ENGINE_LABELS: Record<BookSourceEngine, string> = {
  rule: '规则引擎',
  both: '并存',
  js: '旧沙箱',
};

const ENGINE_HINTS: Record<BookSourceEngine, string> = {
  rule: '只用 JSON 规则引擎。存量 .js 书源需已迁移到 .json',
  both: '两条链路同时装载，同 uuid 时 JSON 胜出（过渡期排障用）',
  js: '只用旧沙箱链路 —— 存量源的应急回退通道，P4 删除',
};

/**
 * 书源引擎运行时开关（分段控件，方案 §3.3 + 实施计划 3.2）
 *
 * 过渡期（P1~P3）两条链路并存，这层是**日常排障与灰度**的主战场：改完不重启就切。
 * 切换只写 localStorage；**已注册的适配器不会自动重装** —— 那需要重走一次
 * `loadAllRuleAdapters` / `loadAllJsAdapters`，而两者都在启动装配里。
 * 故明确提示用户"重启后生效"，而不是假装切了立刻生效（切换到 `js` 时例外：
 * `registerRuleAdapters` 会当场撤掉规则适配器，是立即生效的）。
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-book-source-engine-switch',
  imports: [FormsModule, NzRadioModule, NzTooltipModule, NzIconModule],
  template: `
    <div class="engine-switch">
      <nz-radio-group
        [ngModel]="engine()"
        (ngModelChange)="onChange($event)"
        nzSize="small"
        nzButtonStyle="solid"
      >
        @for (option of options; track option) {
          <label nz-radio-button [nzValue]="option" [nz-tooltip]="hints[option]">
            {{ labels[option] }}
          </label>
        }
      </nz-radio-group>
      @if (needsRestart()) {
        <span class="hint" nz-tooltip="已装载的书源适配器不会自动重装，重启应用后生效">
          <span nz-icon nzType="info-circle"></span> 重启后生效
        </span>
      }
    </div>
  `,
  styles: [
    `
      .engine-switch {
        display: inline-flex;
        align-items: center;
        gap: 8px;
      }
      .hint {
        color: #999;
        font-size: 12px;
      }
    `,
  ],
})
export class BookSourceEngineSwitchComponent {
  private readonly registry = inject(BookSourceRegistry);
  private readonly message = inject(NzMessageService);

  readonly engine = signal<BookSourceEngine>(readBookSourceEngine());
  readonly labels = ENGINE_LABELS;
  readonly hints = ENGINE_HINTS;
  readonly options = BOOK_SOURCE_ENGINES;

  /** 选中的引擎与当前已装载的适配器不一致 → 需要重启 */
  readonly needsRestart = computed(() => this.engine() !== readBookSourceEngine());

  onChange(next: BookSourceEngine): void {
    if (next === this.engine()) return;
    this.engine.set(next);
    writeBookSourceEngine(next);

    if (next === 'js' && this.registry.hasRuleAdapters()) {
      // 切到 js 是**立即生效**的：`registerRuleAdapters` 的 js 分支会当场撤掉规则适配器，
      // 不撤的话用户看到"已切到旧引擎"、实际匹配仍走新引擎，开关形同虚设
      this.registry.clearRuleAdapters();
      this.message.warning('已切到旧沙箱链路（规则适配器已撤下），JS 书源需重启后装载');
      return;
    }
    this.message.info(`已切换到「${ENGINE_LABELS[next]}」，重启应用后生效`);
  }
}
