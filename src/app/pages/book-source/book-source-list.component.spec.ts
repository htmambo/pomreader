import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import 'zone.js';
import { TestBed } from '@angular/core/testing';
import {
  BrowserDynamicTestingModule,
  platformBrowserDynamicTesting,
} from '@angular/platform-browser-dynamic/testing';
import { signal } from '@angular/core';
import { Router } from '@angular/router';
import { NzModalService } from 'ng-zorro-antd/modal';
import { BookSourceListComponent } from './book-source-list.component';
import { BookSourceListStateService } from '../../core/book-source/book-source-list-state.service';
import { PageHeaderService } from '../../core/services/page-header.service';
import { ToastService } from '../../core/services/toast.service';

/**
 * BookSourceListComponent spec — Esc 逐级回退
 *
 * 回退栈契约（与 reader.component.ts 的 Esc 栈同构）：
 *   ① Modal 打开 → 组件**直接放行**，由 ng-zorro（CD Overlay keydownEvents + nzKeyboard
 *      默认 true）关闭顶层弹窗。组件不得 preventDefault / stopPropagation，否则弹窗关不掉。
 *   ② 过滤词非空 → 清空过滤词
 *   ③ 已达基态 → **不响应**。终态就是「列表」页本身，不跨模块跳书架（产品决策）。
 *
 * 用例 ③ 与最后一个用例是本 spec 最关键的回归防线：一旦有人照抄 reader 的兜底
 * router.navigate('/bookshelf')，它们会立刻失败。
 *
 * 另有一条**有意分歧于阅读页**：reader 在无 Modal 且输入态时让 Esc 静默（避免丢输入），
 * 本页过滤框就是主交互且过滤词是页面级状态，故输入态同样响应（用例 ④）。
 *
 * 实现说明：组件用 templateUrl/styleUrl，vitest 的 JIT 无法解析这两类资源
 * （overrideComponent 也挡不住 —— 装饰器元数据在 TestBed 编译前就被求值），
 * 故这里用 runInInjectionContext 直接实例化真实类，只验证 onKeydown 的键盘契约；
 * @HostListener 的 document 绑定由 Angular 自身保证，不在本 spec 覆盖范围。
 */

type Harness = {
  component: BookSourceListComponent;
  filter: { (): string; set(v: string): void };
  openModals: unknown[];
  router: { navigateByUrl: ReturnType<typeof vi.fn>; navigate: ReturnType<typeof vi.fn> };
};

/** 构造并派发一个可取消的 Esc 事件，返回同一实例供断言 defaultPrevented */
function pressEsc(target: EventTarget = document): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  target.dispatchEvent(ev);
  return ev;
}

describe('BookSourceListComponent — Esc 逐级回退', () => {
  let h: Harness;

  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserDynamicTestingModule, platformBrowserDynamicTesting());
  });

  beforeEach(() => {
    const filter = signal('');
    const openModals: unknown[] = [];
    const router = { navigateByUrl: vi.fn(async () => true), navigate: vi.fn(async () => true) };

    TestBed.configureTestingModule({
      providers: [
        {
          provide: BookSourceListStateService,
          useValue: {
            filter,
            sources: signal([]),
            loaded: signal(true), // 已加载 → 构造函数走后台刷新分支，不进 loading
            refresh: vi.fn(async () => {}),
            toggle: vi.fn(async () => {}),
            remove: vi.fn(async () => {}),
          },
        },
        { provide: ToastService, useValue: { error: vi.fn(), success: vi.fn(), warn: vi.fn() } },
        // openModals 是真实 NzModalService 的公开面，用数组长度表达「有无弹窗」
        { provide: NzModalService, useValue: { openModals, confirm: vi.fn(), create: vi.fn() } },
        { provide: Router, useValue: router },
        { provide: PageHeaderService, useValue: { subtitle: signal('') } },
      ],
    });

    const component = TestBed.runInInjectionContext(() => new BookSourceListComponent());
    h = { component, filter, openModals, router };
  });

  it('① Modal 打开时放行：不清空过滤词，也不阻断 CDK（不 preventDefault）', () => {
    h.filter.set('测试源');
    h.openModals.push({ fake: 'nz-modal-ref' });
    const ev = pressEsc();

    h.component.onKeydown(ev);

    expect(h.filter()).toBe('测试源');
    // 关键：defaultPrevented 为 false → CDK 的 keydownEvents 仍能收到事件并关闭弹窗
    expect(ev.defaultPrevented).toBe(false);
  });

  it('② 过滤词非空时，Esc 清空过滤词', () => {
    h.filter.set('测试源');
    const ev = pressEsc();

    h.component.onKeydown(ev);

    expect(h.filter()).toBe('');
    expect(ev.defaultPrevented).toBe(true);
  });

  it('③ 已达基态（过滤词为空）时不响应：不跳转书架，终态停在列表页', () => {
    h.filter.set('');
    const ev = pressEsc();

    h.component.onKeydown(ev);

    expect(h.filter()).toBe('');
    // 用户决策：Esc 最多回退到当前菜单项，不跨模块跳书架
    expect(h.router.navigateByUrl).not.toHaveBeenCalled();
    expect(h.router.navigate).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
  });

  it('④ 焦点在输入框内时 Esc 同样清空过滤词（有意分歧于阅读页的输入态拦截）', () => {
    h.filter.set('测试源');
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    try {
      const ev = pressEsc(input);
      expect(ev.target).toBe(input); // 事件确实是输入框发起的
      h.component.onKeydown(ev);
      expect(h.filter()).toBe('');
    } finally {
      input.remove();
    }
  });

  it('非 Esc 键不响应（例如 Enter）', () => {
    h.filter.set('测试源');
    const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });

    h.component.onKeydown(ev);

    expect(h.filter()).toBe('测试源');
    expect(h.router.navigateByUrl).not.toHaveBeenCalled();
  });

  it('连续按 Esc 逐级回退：先清过滤词，再无动作（不产生越界回退）', () => {
    h.filter.set('测试源');

    h.component.onKeydown(pressEsc());
    expect(h.filter()).toBe('');

    h.component.onKeydown(pressEsc());
    h.component.onKeydown(pressEsc());

    expect(h.filter()).toBe('');
    expect(h.router.navigateByUrl).not.toHaveBeenCalled();
    expect(h.router.navigate).not.toHaveBeenCalled();
  });

  it('Modal 优先于过滤词：弹窗打开时按 Esc 不会连带清空过滤词', () => {
    h.filter.set('测试源');
    h.openModals.push({ fake: 'a' });
    h.openModals.push({ fake: 'b' });

    h.component.onKeydown(pressEsc());

    expect(h.filter()).toBe('测试源');
  });
});
