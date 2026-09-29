import { describe, it, expect, beforeAll, vi } from 'vitest';
import 'zone.js';
import { TestBed } from '@angular/core/testing';
import {
  BrowserDynamicTestingModule,
  platformBrowserDynamicTesting,
} from '@angular/platform-browser-dynamic/testing';
import { RulesPanelComponent } from './rules-panel.component';
import { PageFetcherService } from '../../../core/book-source/page-fetcher.service';
import { type SourceRules } from '../../../core/book-source/smart-add/smart-rules';

/**
 * RulesPanelComponent spec —— 面板 ↔ JSON 字段序列化 round-trip（方案 §5：P3 编辑器迁移后
 * 面板是 BookSourceDoc.rules 的唯一编辑入口，本用例锁定 setRules/getRules 与 JSON 序列化的往返一致性）
 *
 * 与 book-source-list.component.spec.ts 同模式：templateUrl/styleUrl 在 vitest JIT 下不可解析，
 * 故 runInInjectionContext 直接实例化真实类，只验证规则字段契约，不渲染模板。
 */

function makeFullRules(): SourceRules {
  return {
    siteName: '测试站',
    searchPath: '/search?q={keyword}',
    searchMethod: 'POST',
    searchBodyParams: [{ key: 'q', value: '{keyword}' }],
    searchContentType: 'application/x-www-form-urlencoded',
    searchRawBody: '',
    searchItemPattern: 'css:.item',
    searchAuthorPattern: 'css:.author',
    searchCategoryPattern: 'css:.cat',
    bookTitlePattern: 'css:h1',
    coverUrlPattern: 'css:img@src',
    bookAuthorPattern: 'css:.author',
    chapterItemPattern: 'css:.chapter a',
    contentPattern: 'css:#content',
    contentReplaceRules: [{ rule: '广告', replace: '' }],
    bookCategoryPattern: 'css:.category',
  };
}

describe('RulesPanelComponent — 面板 ↔ JSON 字段 round-trip', () => {
  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserDynamicTestingModule, platformBrowserDynamicTesting());
  });

  function makePanel(): RulesPanelComponent {
    // 单测内多次实例化需先 reset（TestBed 已 instantiated 后不能再 configure）
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [{ provide: PageFetcherService, useValue: { fetchHtml: vi.fn() } }],
    });
    return TestBed.runInInjectionContext(() => new RulesPanelComponent());
  }

  it('setRules(全字段) → getRules() 逐字段一致', () => {
    const panel = makePanel();
    const rules = makeFullRules();
    panel.setRules(rules);
    expect(panel.getRules()).toEqual(rules);
  });

  it('getRules() → JSON.stringify → JSON.parse → setRules → getRules() 往返不变（doc.rules 落盘口径）', () => {
    const panel = makePanel();
    const rules = makeFullRules();
    panel.setRules(rules);

    // 与 booksourceSaveJson 落盘路径同口径：doc.rules 经 JSON.stringify 写盘
    const persisted = JSON.parse(JSON.stringify(panel.getRules())) as SourceRules;

    const panel2 = makePanel();
    panel2.setRules(persisted);
    expect(panel2.getRules()).toEqual(rules);
  });

  it('空 contentReplaceRules 行在 getRules 时被过滤（UI 常留一空行，落盘不带空规则）', () => {
    const panel = makePanel();
    panel.setRules(makeFullRules());
    panel.addContentReplaceRule();
    const rules = panel.getRules();
    expect(rules.contentReplaceRules).toEqual([{ rule: '广告', replace: '' }]);
  });
});
