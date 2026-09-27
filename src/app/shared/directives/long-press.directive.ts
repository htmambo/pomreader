import { Directive, type OnDestroy, output } from '@angular/core';

/**
 * 长按指令：按住 500ms 触发 (appLongPress)。
 * - 支持鼠标左键与触摸；右键不触发（保留给 contextmenu）
 * - 触发后可通过 pressFired 查询并消费标志，宿主据此抑制紧随其后的 click
 */
@Directive({
  selector: '[appLongPress]',
  standalone: true,
  host: {
    '(mousedown)': 'onPressStart($event)',
    '(mouseup)': 'onPressEnd()',
    '(mouseleave)': 'onPressEnd()',
    '(touchstart)': 'onPressStart($event)',
    '(touchend)': 'onPressEnd()',
    '(touchcancel)': 'onPressEnd()',
  },
})
export class LongPressDirective implements OnDestroy {
  private static readonly DELAY_MS = 500;

  readonly appLongPress = output<void>();

  private timer: ReturnType<typeof setTimeout> | null = null;
  private fired = false;

  /** 长按是否刚刚触发过；consumePressFired() 读取并清除 */
  get pressFired(): boolean {
    return this.fired;
  }

  consumePressFired(): boolean {
    const was = this.fired;
    this.fired = false;
    return was;
  }

  onPressStart(event: MouseEvent | TouchEvent): void {
    if (event instanceof MouseEvent && event.button !== 0) return;
    this.fired = false;
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.fired = true;
      this.appLongPress.emit();
    }, LongPressDirective.DELAY_MS);
  }

  onPressEnd(): void {
    this.clearTimer();
  }

  ngOnDestroy(): void {
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
