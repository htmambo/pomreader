import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import 'zone.js';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  BrowserDynamicTestingModule,
  platformBrowserDynamicTesting,
} from '@angular/platform-browser-dynamic/testing';
import { SourceSearchStateService } from './source-search-state.service';
import {
  MultiSourceSearchService,
  type SearchProgress,
  type SearchResultItem,
} from './multi-source-search.service';
import { ToastService } from '../services/toast.service';

/**
 * SourceSearchStateService spec — 书源聚合搜索页会话级状态 + 搜索编排
 *
 * 关键契约：
 * - 空关键词不触发搜索
 * - 成功后 results / sourceCount（取自 searchSvc.progress().total）同步
 * - 0 结果时按 lastErrors 走 warn（≤3 全列 / >3 截断加 …）或 info 分支
 * - searchAll 整体异常 → toast.error 兜底，loading 必复位
 */

function makeItem(overrides: Partial<SearchResultItem> = {}): SearchResultItem {
  return {
    source: 'a.js',
    sourceName: 'A源',
    name: '三体',
    author: '刘慈欣',
    url: 'https://example.com/book/1',
    latencyMs: 12,
    ...overrides,
  };
}

describe('SourceSearchStateService', () => {
  let svc: SourceSearchStateService;
  let searchMock: any;
  let toastMock: any;

  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserDynamicTestingModule, platformBrowserDynamicTesting());
  });

  beforeEach(() => {
    searchMock = {
      progress: signal<SearchProgress>({ phase: 'idle', done: 0, total: 0, current: '' }),
      lastErrors: [] as string[],
      searchAll: vi.fn(async () => [] as SearchResultItem[]),
    };
    toastMock = { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn() };

    TestBed.configureTestingModule({
      providers: [
        SourceSearchStateService,
        { provide: MultiSourceSearchService, useValue: searchMock },
        { provide: ToastService, useValue: toastMock },
      ],
    });
    svc = TestBed.inject(SourceSearchStateService);
  });

  it('初始状态：未搜索 / 空结果 / loading=false，progress 与 searchSvc 同源', () => {
    expect(svc.keyword()).toBe('');
    expect(svc.searched()).toBe(false);
    expect(svc.results()).toEqual([]);
    expect(svc.sourceCount()).toBe(0);
    expect(svc.loading()).toBe(false);
    expect(svc.progress).toBe(searchMock.progress);
  });

  it('空关键词（含全空白 trim 后为空）不触发搜索', async () => {
    svc.keyword.set('   ');
    await svc.search();
    expect(searchMock.searchAll).not.toHaveBeenCalled();
    expect(svc.searched()).toBe(false);
    expect(svc.loading()).toBe(false);
  });

  it('搜索成功：trim 后关键词下发，results/sourceCount/searched 同步，loading 复位', async () => {
    const items = [makeItem(), makeItem({ name: '球状闪电', url: 'https://example.com/book/2' })];
    searchMock.searchAll.mockImplementationOnce(async () => {
      searchMock.progress.set({ phase: 'done', done: 2, total: 2, current: '' });
      return items;
    });

    svc.keyword.set('  三体  ');
    await svc.search();

    expect(searchMock.searchAll).toHaveBeenCalledWith('三体');
    expect(svc.results()).toEqual(items);
    expect(svc.sourceCount()).toBe(2);
    expect(svc.searched()).toBe(true);
    expect(svc.loading()).toBe(false);
    expect(toastMock.info).not.toHaveBeenCalled();
    expect(toastMock.warn).not.toHaveBeenCalled();
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it('搜索进行中 loading=true，settled 后复位', async () => {
    let resolveSearch!: (items: SearchResultItem[]) => void;
    searchMock.searchAll.mockImplementationOnce(
      () => new Promise<SearchResultItem[]>((r) => (resolveSearch = r)),
    );

    svc.keyword.set('三体');
    const pending = svc.search();
    await Promise.resolve(); // 让 searchAll 被调用
    expect(svc.loading()).toBe(true);
    expect(svc.searched()).toBe(true);

    resolveSearch([makeItem()]);
    await pending;
    expect(svc.loading()).toBe(false);
  });

  it('0 结果且有源失败（≤3 条）→ toast.warn 全列原因，不带省略号', async () => {
    searchMock.lastErrors = ['A源: timeout', 'B源: 500'];
    svc.keyword.set('不存在');
    await svc.search();

    expect(svc.results()).toEqual([]);
    expect(toastMock.warn).toHaveBeenCalledWith('未找到结果，2 个书源失败：A源: timeout；B源: 500');
    expect(toastMock.info).not.toHaveBeenCalled();
  });

  it('0 结果且源失败 >3 条 → toast.warn 只列前 3 条并追加省略号', async () => {
    searchMock.lastErrors = ['e1', 'e2', 'e3', 'e4', 'e5'];
    svc.keyword.set('不存在');
    await svc.search();

    expect(toastMock.warn).toHaveBeenCalledWith('未找到结果，5 个书源失败：e1；e2；e3…');
  });

  it('0 结果且无源失败 → toast.info 提示未找到匹配结果', async () => {
    searchMock.lastErrors = [];
    svc.keyword.set('不存在');
    await svc.search();

    expect(toastMock.info).toHaveBeenCalledWith('未找到匹配结果');
    expect(toastMock.warn).not.toHaveBeenCalled();
  });

  it('searchAll 整体抛错 → toast.error 兜底，results 保持，loading 复位', async () => {
    svc.results.set([makeItem()]);
    searchMock.searchAll.mockRejectedValueOnce(new Error('boom'));

    svc.keyword.set('三体');
    await svc.search();

    expect(toastMock.error).toHaveBeenCalledWith('搜索失败：boom');
    expect(svc.results()).toHaveLength(1); // 未被清空
    expect(svc.searched()).toBe(true);
    expect(svc.loading()).toBe(false);
  });
});
