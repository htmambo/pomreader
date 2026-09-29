/**
 * RuleEngineService 单元测试（方案 §3.2 / P1）
 *
 * mock window.pomAPI（booksourceRead / booksourceHttpProxy）+ CfPromptService，
 * 覆盖：valibot parse 失败带字段路径、cfChallenge → prompt fire-and-forget、
 * HTTP 状态码语义（历史 worker shim 的 2xx-only resolve）、
 * IPC 缺失降级、每次调用重读文件、traces$ 补 status。
 */
import 'zone.js';
import { TestBed } from '@angular/core/testing';
import {
  BrowserDynamicTestingModule,
  platformBrowserDynamicTesting,
} from '@angular/platform-browser-dynamic/testing';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FetchError } from '../fetch-error';
import { CfPromptService } from '../../services/cf-prompt.service';
import { type BookSourceMeta } from '../source-meta.types';
import { type RuleTrace } from './engine';
import { RuleEngineService } from './rule-engine.service';

const meta: BookSourceMeta = {
  sourceKey: 'test-uuid',
  uuid: 'test-uuid',
  fileName: 'test.json',
  name: '测试书源',
  url: 'https://example.com',
  urls: ['https://example.com'],
  author: undefined,
  logo: undefined,
  description: undefined,
  enabled: true,
  fileSize: 0,
  modifiedAt: 0,
  sourceDir: '',
  sourceType: 'novel',
  version: '1',
  tags: [],
  minDelayMs: 0,
  requireUrls: [],
};

/** 最小合法 BookSourceDoc（CSS 规则，jsdom DOMParser 可解析） */
const validDoc = {
  format: 'pomreader.booksource',
  schemaVersion: 1,
  uuid: 'test-uuid',
  name: '测试书源',
  homepage: 'https://example.com',
  urls: ['https://example.com'],
  enabled: true,
  sourceType: 'novel',
  tags: [],
  minDelayMs: 0,
  requireUrls: [],
  headers: {},
  rules: {
    siteName: '测试书源',
    searchPath: 'https://example.com/search?q={keyword}&page={page}',
    searchItemPattern: 'css:a.result',
    bookTitlePattern: 'css:h1.title',
    bookAuthorPattern: 'css:span.author',
    chapterItemPattern: 'css:a.chapter',
    contentPattern: 'css:div.content',
  },
};

const SEARCH_HTML =
  '<a class="result" href="/b/1">书名一</a><a class="result" href="/b/2">书名二</a>';
const BOOK_HTML =
  '<h1 class="title">书名一</h1><span class="author">作者甲</span>' +
  '<a class="chapter" href="/b/1/c1">第一章</a><a class="chapter" href="/b/1/c2">第二章</a>';
const CONTENT_HTML = '<div class="content">正文第一段\n正文第二段</div>';

interface PomApiMock {
  booksourceRead: ReturnType<typeof vi.fn>;
  booksourceHttpProxy: ReturnType<typeof vi.fn>;
}

function installPomApi(overrides: Partial<PomApiMock> = {}): PomApiMock {
  const pom: PomApiMock = {
    booksourceRead: vi.fn(async () => JSON.stringify(validDoc)),
    booksourceHttpProxy: vi.fn(async () => ({ status: 200, headers: {}, body: SEARCH_HTML })),
    ...overrides,
  };
  (window as unknown as { pomAPI?: unknown }).pomAPI = pom;
  return pom;
}

describe('RuleEngineService', () => {
  let svc: RuleEngineService;
  let cfPromptMock: { prompt: ReturnType<typeof vi.fn> };

  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserDynamicTestingModule, platformBrowserDynamicTesting());
  });

  beforeEach(() => {
    TestBed.resetTestingModule();
    cfPromptMock = { prompt: vi.fn() };
    TestBed.configureTestingModule({
      providers: [RuleEngineService, { provide: CfPromptService, useValue: cfPromptMock }],
    });
    svc = TestBed.inject(RuleEngineService);
    installPomApi();
  });

  it('search 正常路径：读文件 → 代理 GET → CSS 提取条目', async () => {
    const pom = installPomApi();
    const items = await svc.search(meta, '网文', 1);
    expect(items.map((i) => i.name)).toEqual(['书名一', '书名二']);
    expect(items[0].bookUrl).toBe('https://example.com/b/1');
    expect(pom.booksourceRead).toHaveBeenCalledWith('test.json', null);
    expect(pom.booksourceHttpProxy).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        url: 'https://example.com/search?q=%E7%BD%91%E6%96%87&page=1',
      }),
    );
  });

  it('bookInfo：详情页 + 目录复抓一次（模板语义，两次 GET）', async () => {
    const pom = installPomApi({
      booksourceHttpProxy: vi.fn(async () => ({ status: 200, headers: {}, body: BOOK_HTML })),
    });
    const info = await svc.bookInfo(meta, 'https://example.com/b/1');
    expect(info.title).toBe('书名一');
    expect(info.author).toBe('作者甲');
    expect(info.chapters.map((c) => c.name)).toEqual(['第一章', '第二章']);
    expect(pom.booksourceHttpProxy).toHaveBeenCalledTimes(2);
  });

  it('chapterContent：CSS 提取 + stripTags', async () => {
    installPomApi({
      booksourceHttpProxy: vi.fn(async () => ({ status: 200, headers: {}, body: CONTENT_HTML })),
    });
    const text = await svc.chapterContent(meta, 'https://example.com/b/1/c1');
    expect(text).toContain('正文第一段');
  });

  it('valibot parse 失败抛 parse-failed 且带字段路径', async () => {
    const bad = { ...validDoc, uuid: '' };
    installPomApi({ booksourceRead: vi.fn(async () => JSON.stringify(bad)) });
    await expect(svc.search(meta, 'kw')).rejects.toMatchObject({ code: 'parse-failed' });
    await expect(svc.search(meta, 'kw')).rejects.toThrow(/uuid/);
  });

  it('JSON.parse 失败抛 parse-failed', async () => {
    installPomApi({ booksourceRead: vi.fn(async () => 'not-json{') });
    await expect(svc.search(meta, 'kw')).rejects.toMatchObject({ code: 'parse-failed' });
    await expect(svc.search(meta, 'kw')).rejects.toThrow(FetchError);
  });

  it('booksourceRead IPC 缺失 → source-unavailable', async () => {
    (window as unknown as { pomAPI?: unknown }).pomAPI = {};
    await expect(svc.search(meta, 'kw')).rejects.toMatchObject({
      code: 'source-unavailable',
      message: 'booksourceRead IPC 不可用',
    });
  });

  it('booksourceHttpProxy IPC 缺失 → source-unavailable', async () => {
    (window as unknown as { pomAPI?: unknown }).pomAPI = {
      booksourceRead: vi.fn(async () => JSON.stringify(validDoc)),
    };
    await expect(svc.search(meta, 'kw')).rejects.toMatchObject({
      code: 'source-unavailable',
      message: 'booksourceHttpProxy IPC 不可用',
    });
  });

  it('cfChallenge → CfPromptService.prompt 被调且不阻塞（本次请求仍按状态码失败）', async () => {
    installPomApi({
      booksourceHttpProxy: vi.fn(async () => ({
        status: 403,
        headers: {},
        body: '',
        cfChallenge: true,
      })),
    });
    await expect(svc.search(meta, 'kw')).rejects.toMatchObject({
      code: 'parse-failed',
      message: 'HTTP 403',
    });
    expect(cfPromptMock.prompt).toHaveBeenCalledWith('https://example.com/search?q=kw&page=1');
  });

  it('HTTP 状态码语义对齐历史 worker shim：非 2xx 一律 reject', async () => {
    const proxy = vi.fn(async () => ({ status: 404, headers: {}, body: 'not found' }));
    installPomApi({ booksourceHttpProxy: proxy });
    await expect(svc.search(meta, 'kw')).rejects.toMatchObject({
      code: 'parse-failed',
      message: 'HTTP 404',
    });
    // 3xx 也 reject（worker 语义比 page-fetcher.fetchPost 的 >=400 更严）
    proxy.mockImplementation(async () => ({ status: 302, headers: {}, body: '' }));
    await expect(svc.search(meta, 'kw')).rejects.toMatchObject({ message: 'HTTP 302' });
  });

  it('proxy 自身抛错 → 包装为 source-unavailable FetchError', async () => {
    installPomApi({
      booksourceHttpProxy: vi.fn(async () => {
        throw new Error('net::ERR_NAME_NOT_RESOLVED');
      }),
    });
    await expect(svc.search(meta, 'kw')).rejects.toMatchObject({
      code: 'source-unavailable',
    });
  });

  it('每次入口调用重读文件（无缓存，改完立即生效）', async () => {
    const pom = installPomApi();
    await svc.search(meta, 'kw');
    await svc.search(meta, 'kw');
    expect(pom.booksourceRead).toHaveBeenCalledTimes(2);
  });

  it('traces$ 发出 trace，http trace 由本层补填 status', async () => {
    installPomApi();
    const traces: RuleTrace[] = [];
    const sub = svc.traces$.subscribe((t) => traces.push(t));
    await svc.search(meta, 'kw');
    sub.unsubscribe();
    const httpTrace = traces.find((t) => t.stage === 'http');
    expect(httpTrace).toBeDefined();
    expect(httpTrace?.status).toBe(200);
    expect(httpTrace?.phase).toBe('search');
    expect(traces.some((t) => t.stage === 'done')).toBe(true);
  });
});
