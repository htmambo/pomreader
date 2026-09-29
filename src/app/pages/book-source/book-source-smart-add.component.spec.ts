/**
 * 智能添加页的「homepage 与 rules 同源」契约（书源 JSON 规则化 P2.3）
 *
 * ## 为什么用直接实例化而不是 TestBed.createComponent
 *
 * 被测的决策是"生成文档时 homepage 取**分析快照**而不是输入框当前值"。纯函数测不到它，
 * 但也不需要整套模板：fixture 方式下 `RulesPanelComponent` 的 `templateUrl` 无法被
 * vitest JIT 解析（得用 `overrideComponent` 换桩），而 `viewChild` + effect 的
 * 变更检测顺序让"分析 → 面板就绪"这件事在测试里既脆弱又难读
 * （组件自己的注释就记着这个 33c21e7 时序坑）。
 *
 * 故沿用 `book-source-list.component.spec.ts` 的既有做法：在注入上下文里直接实例化
 * 真实类，验证那条**状态取值契约**。"effect 会不会随 signal 重跑"由 Angular 保证，
 * 不是本项目能写错的东西。
 *
 * ## 回归的缺陷（外部评审 R2 推翻了我 R1 的判断）
 *
 * `fileName` 改成 signal 之后，改名会触发 effect 重生成；若重生成时读**输入框当前值**
 * 当 homepage，用户"分析后改 URL、再改文件名"就会得到「新 URL + 旧页面规则」的文档 ——
 * 抓取必然失败，而界面上没有任何异常提示。把 `targetUrl` 留作普通属性**并不能**阻止它，
 * 只是推迟了触发时机。
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import 'zone.js';
import { TestBed } from '@angular/core/testing';
import {
  BrowserDynamicTestingModule,
  platformBrowserDynamicTesting,
} from '@angular/platform-browser-dynamic/testing';
import { Router } from '@angular/router';
import type { WritableSignal } from '@angular/core';
import { BookSourceSmartAddComponent } from './book-source-smart-add.component';
import { PageFetcherService } from '../../core/book-source/page-fetcher.service';
import { ToastService } from '../../core/services/toast.service';
import type { SourceRules } from '../../core/book-source/smart-add/smart-rules';

const RULES: SourceRules = {
  siteName: '示例站点',
  searchPath: '/s?q={keyword}',
  searchItemPattern: 'ul.list li',
  bookTitlePattern: 'h1',
  bookAuthorPattern: 'css:.author',
  chapterItemPattern: 'ul.c a',
  contentPattern: 'div#content',
};

/** 组件内部的私有成员（白盒）：`buildDocText` 与 `analyzedHomepage` 快照 */
interface Internals {
  buildDocText: (rules: SourceRules) => string;
  analyzedHomepage: WritableSignal<string>;
}

function internals(comp: BookSourceSmartAddComponent): Internals {
  return comp as unknown as Internals;
}

function newComp(): BookSourceSmartAddComponent {
  return TestBed.runInInjectionContext(() => new BookSourceSmartAddComponent());
}

function docOf(comp: BookSourceSmartAddComponent): Record<string, unknown> {
  return JSON.parse(internals(comp).buildDocText(RULES)) as Record<string, unknown>;
}

describe('BookSourceSmartAddComponent · 生成文档的 homepage 来源', () => {
  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserDynamicTestingModule, platformBrowserDynamicTesting());
  });

  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        // fetch 永不 resolve：`analyze()` 会停在 await 上，但**快照在那之前就已落定**，
        // 而那正是本 spec 要验的东西（不让 fetch/面板的 DOM 时序掺进来）
        {
          provide: PageFetcherService,
          useValue: { fetchHtml: () => new Promise<string>(() => {}) },
        },
        {
          provide: ToastService,
          useValue: { warn: () => {}, error: () => {}, success: () => {}, info: () => {} },
        },
        { provide: Router, useValue: { navigateByUrl: () => {}, navigate: () => {} } },
      ],
    });
  });

  it('homepage 取分析快照：改输入框 URL 不影响生成结果', () => {
    const comp = newComp();
    internals(comp).analyzedHomepage.set('https://old.example.com');
    comp.targetUrl = 'https://old.example.com/book/1';
    comp.fileName.set('old_com.json');

    comp.targetUrl = 'https://new.example.com/book/1'; // 用户顺手改了输入框
    comp.fileName.set('renamed.json'); // 触发 effect 重生成

    expect(docOf(comp).homepage).toBe('https://old.example.com');
    expect(docOf(comp).homepage).not.toBe('https://new.example.com');
  });

  it('uuid 取当前 fileName（改名后命名空间跟着变）', () => {
    const comp = newComp();
    internals(comp).analyzedHomepage.set('https://old.example.com');
    comp.fileName.set('first.json');
    expect(docOf(comp).uuid).toBe('first.json');

    comp.fileName.set('second.json');
    expect(docOf(comp).uuid).toBe('second.json');
  });

  it('fileName 为空时用兜底值，不产出空 uuid（schema 必填）', () => {
    const comp = newComp();
    internals(comp).analyzedHomepage.set('https://old.example.com');
    comp.fileName.set('');
    expect(docOf(comp).uuid).toBe('book_source.json');
  });

  it('reset() 清掉快照：不会拿上一个站点的 homepage 继续生成', () => {
    const comp = newComp();
    internals(comp).analyzedHomepage.set('https://old.example.com');
    comp.reset();
    expect(internals(comp).analyzedHomepage()).toBe('');
    expect(docOf(comp).homepage).toBe('');
  });

  it('analyze() 在 await 之前就落定快照（URL 校验通过即写入）', async () => {
    const comp = newComp();
    comp.targetUrl = 'https://old.example.com/book/1';
    void comp.analyze(); // fetch 永不 resolve，这里不等它
    await Promise.resolve();
    expect(internals(comp).analyzedHomepage()).toBe('https://old.example.com');
  });

  it('非法 URL 不进入分析，快照保持为空（不会写出半成品）', async () => {
    const comp = newComp();
    comp.targetUrl = '不是 URL';
    await comp.analyze();
    expect(internals(comp).analyzedHomepage()).toBe('');
    expect(docOf(comp).homepage).toBe('');
  });
});
