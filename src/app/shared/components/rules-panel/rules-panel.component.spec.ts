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

  it('分页字段 set → get 保真（tocPagination 全子字段 + contentPagination 仅 area）', () => {
    const panel = makePanel();
    const rules: SourceRules = {
      ...makeFullRules(),
      tocPagination: { area: 'css:.pagination', linkPattern: '/book/\\d+\\.html', maxPages: 50 },
      contentPagination: { area: 'css:.pagebar' },
    };
    panel.setRules(rules);
    expect(panel.getRules()).toEqual(rules);
  });

  it('分页子字段全空 → getRules 不输出 tocPagination / contentPagination（无分页时文档零变化）', () => {
    const panel = makePanel();
    panel.setRules(makeFullRules());
    const rules = panel.getRules();
    expect('tocPagination' in rules).toBe(false);
    expect('contentPagination' in rules).toBe(false);
  });

  it('仅填分页区域 → 输出仅含 area 的对象；白名单/页数键省略', () => {
    const panel = makePanel();
    panel.tocPaginationArea.set('css:.pagination');
    const rules = panel.getRules();
    expect(rules.tocPagination).toEqual({ area: 'css:.pagination' });
    expect('contentPagination' in rules).toBe(false);
  });

  it('区域为空但填了白名单/页数 → 视为未启用，不输出该字段', () => {
    const panel = makePanel();
    panel.tocPaginationLinkPattern.set('page_\\d+');
    panel.tocPaginationMaxPages.set('30');
    panel.contentPaginationMaxPages.set('10');
    const rules = panel.getRules();
    expect('tocPagination' in rules).toBe(false);
    expect('contentPagination' in rules).toBe(false);
  });

  it('最大页数接受数字字符串、非法输入省略 maxPages 键', () => {
    const panel = makePanel();
    panel.contentPaginationArea.set('css:.pagebar');
    panel.contentPaginationMaxPages.set('20');
    expect(panel.getRules().contentPagination).toEqual({
      area: 'css:.pagebar',
      maxPages: 20,
    });

    const panel2 = makePanel();
    panel2.contentPaginationArea.set('css:.pagebar');
    panel2.contentPaginationMaxPages.set('abc');
    expect(panel2.getRules().contentPagination).toEqual({
      area: 'css:.pagebar',
    });
  });

  it('含分页字段的 JSON 落盘往返不变（stringify → parse → setRules → getRules）', () => {
    const panel = makePanel();
    const rules: SourceRules = {
      ...makeFullRules(),
      tocPagination: { area: 'css:.pagination', maxPages: 100 },
      contentPagination: { area: 'css:.pagebar', linkPattern: 'chapter_\\d+' },
    };
    panel.setRules(rules);
    const persisted = JSON.parse(JSON.stringify(panel.getRules())) as SourceRules;

    const panel2 = makePanel();
    panel2.setRules(persisted);
    expect(panel2.getRules()).toEqual(rules);
  });
});
