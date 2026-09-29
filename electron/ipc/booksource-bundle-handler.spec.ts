import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Mock electron BEFORE importing handler（dialog / app.getVersion 是 handler 仅有的 Electron 依赖）
const showSaveDialog = vi.fn();
const showOpenDialog = vi.fn();
vi.mock('electron', () => ({
  app: { getVersion: () => '9.9.9-test' },
  dialog: {
    showSaveDialog: (...args: unknown[]) => showSaveDialog(...args),
    showOpenDialog: (...args: unknown[]) => showOpenDialog(...args),
  },
  IpcMain: class {},
  BrowserWindow: class {},
}));

import { registerBookSourceBundleHandler } from './booksource-bundle-handler';
import { parseBundle } from './booksource-bundle';

/**
 * booksource-bundle-handler spec — 导出 / 打开 / 应用 三个 channel（设计 §5，Phase 1）
 *
 * 覆盖：dialog 取消返回 null；apply 写前全量预校验不过则不写任何文件；
 * 部分写入失败收集进 failed（不回滚）；成功路径 enabled 随 content 落盘（无 marker）；
 * pom:booksource-updated 广播 payload
 */

type HandlerFn = (event: unknown, ...args: unknown[]) => unknown;

function createFakeIpcMain(): { handlers: Map<string, HandlerFn> } & Record<'handle', unknown> {
  const handlers = new Map<string, HandlerFn>();
  return {
    handlers,
    handle(channel: string, fn: HandlerFn) {
      handlers.set(channel, fn);
    },
  };
}

function makeDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: 'pomreader.booksource',
    schemaVersion: 1,
    uuid: 'uuid-1',
    name: '源一',
    homepage: 'https://example.com/',
    urls: ['https://example.com/'],
    enabled: true,
    sourceType: 'novel',
    rules: {
      siteName: '源一',
      searchPath: '/search',
      searchItemPattern: '.item',
      bookTitlePattern: '.title',
      bookAuthorPattern: '.author',
      chapterItemPattern: '.chapter',
      contentPattern: '.content',
    },
    ...overrides,
  };
}

const FAKE_WINDOW = { id: 1 };
const FAKE_EVENT = () => ({
  sender: {
    isDestroyed: () => false,
    send: vi.fn(),
  },
});

describe('booksource-bundle-handler', () => {
  let tmpUserData: string;
  let exportDir: string;
  let handlers: Map<string, HandlerFn>;

  const call = (channel: string, event: unknown, ...args: unknown[]): Promise<unknown> =>
    Promise.resolve(handlers.get(channel)!(event, ...args));

  beforeEach(() => {
    tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-handler-test-'));
    exportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-export-test-'));
    const fake = createFakeIpcMain();

    registerBookSourceBundleHandler(fake as any, tmpUserData, () => FAKE_WINDOW as any);
    handlers = fake.handlers;
    showSaveDialog.mockReset();
    showOpenDialog.mockReset();
  });

  afterEach(() => {
    fs.rmSync(tmpUserData, { recursive: true, force: true });
    fs.rmSync(exportDir, { recursive: true, force: true });
  });

  it('应注册 3 个 bundle channel', () => {
    for (const ch of [
      'pom:booksource-bundle-export',
      'pom:booksource-bundle-open',
      'pom:booksource-bundle-apply',
    ]) {
      expect(handlers.has(ch), ch).toBe(true);
    }
  });

  /* ── export ── */

  it('export：用户取消保存对话框返回 null', async () => {
    fs.mkdirSync(path.join(tmpUserData, 'booksources'), { recursive: true });
    fs.writeFileSync(path.join(tmpUserData, 'booksources', 'a.json'), JSON.stringify(makeDoc()));
    showSaveDialog.mockResolvedValue({ canceled: true, filePath: undefined });
    const r = await call('pom:booksource-bundle-export', FAKE_EVENT(), ['a.json']);
    expect(r).toBeNull();
  });

  it('export：成功路径写 bundle 并返回 { path, count }，内容可 parseBundle 往返', async () => {
    fs.mkdirSync(path.join(tmpUserData, 'booksources'), { recursive: true });
    fs.writeFileSync(path.join(tmpUserData, 'booksources', 'a.json'), JSON.stringify(makeDoc()));
    fs.writeFileSync(
      path.join(tmpUserData, 'booksources', 'b.json'),
      JSON.stringify(makeDoc({ uuid: 'uuid-2', name: '源二' })),
    );
    const dest = path.join(exportDir, 'out.json');
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: dest });

    const r = (await call('pom:booksource-bundle-export', FAKE_EVENT(), ['a.json', 'b.json'])) as {
      path: string;
      count: number;
    };
    expect(r).toEqual({ path: dest, count: 2 });

    // 对话框默认文件名 pomreader-sources-YYYY-MM-DD.json
    const dialogArg = showSaveDialog.mock.calls[0][1] as { defaultPath: string };
    expect(dialogArg.defaultPath).toMatch(/^pomreader-sources-\d{4}-\d{2}-\d{2}\.json$/);

    const bundle = parseBundle(fs.readFileSync(dest, 'utf-8'));
    expect(bundle.app).toBe('9.9.9-test');
    expect(bundle.sources.map((s) => s.uuid)).toEqual(['uuid-1', 'uuid-2']);
  });

  it('export：fileName 对应的文件不存在应抛错', async () => {
    fs.mkdirSync(path.join(tmpUserData, 'booksources'), { recursive: true });
    await expect(
      call('pom:booksource-bundle-export', FAKE_EVENT(), ['ghost.json']),
    ).rejects.toThrow(/不存在/);
  });

  /* ── open ── */

  it('open：用户取消打开对话框返回 null', async () => {
    showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    const r = await call('pom:booksource-bundle-open', FAKE_EVENT());
    expect(r).toBeNull();
  });

  it('open：parseBundle 失败返回错误信息（不抛穿 IPC）', async () => {
    const bad = path.join(exportDir, 'bad.json');
    fs.writeFileSync(bad, JSON.stringify({ format: 'other.bundle' }));
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [bad] });
    const r = (await call('pom:booksource-bundle-open', FAKE_EVENT())) as {
      error: string | null;
      entries: unknown[];
    };
    expect(r.error).toMatch(/未知 format/);
    expect(r.entries).toEqual([]);
  });

  it('open：成功路径返回 diff 分类（new / identical / update，无 baseline 不产 conflict）', async () => {
    const dir = path.join(tmpUserData, 'booksources');
    fs.mkdirSync(dir, { recursive: true });
    // 本地：identical 一条 + update 一条（content 不同）
    fs.writeFileSync(path.join(dir, 'same.json'), JSON.stringify(makeDoc({ uuid: 'u-same' })));
    fs.writeFileSync(path.join(dir, 'chg.json'), JSON.stringify(makeDoc({ uuid: 'u-chg' })));

    const bundle = {
      format: 'pomreader.booksource.bundle',
      version: 1,
      exportedAt: 1789000000000,
      app: '1.0.0',
      sources: [
        {
          uuid: 'u-same',
          fileName: 'same.json',
          content: JSON.stringify(makeDoc({ uuid: 'u-same' })),
        },
        {
          uuid: 'u-chg',
          fileName: 'chg.json',
          content: JSON.stringify(makeDoc({ uuid: 'u-chg', name: '改名' })),
        },
        {
          uuid: 'u-new',
          fileName: 'new.json',
          content: JSON.stringify(makeDoc({ uuid: 'u-new' })),
        },
      ],
    };
    const src = path.join(exportDir, 'bundle.json');
    fs.writeFileSync(src, JSON.stringify(bundle));
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [src] });

    const r = (await call('pom:booksource-bundle-open', FAKE_EVENT())) as {
      error: string | null;
      entries: { kind: string; fileName: string; content: string }[];
    };
    expect(r.error).toBeNull();
    expect(r.entries.map((e) => [e.fileName, e.kind])).toEqual([
      ['same.json', 'identical'],
      ['chg.json', 'update'],
      ['new.json', 'new'],
    ]);
    // 每条带 content 原文（渲染端预览 + valibot 全量校验用）
    expect(JSON.parse(r.entries[2].content).uuid).toBe('u-new');
  });

  /* ── apply ── */

  it('apply：成功路径逐条 atomicWrite，enabled 随 content 落盘（无 marker）', async () => {
    const event = FAKE_EVENT();
    const decisions = [
      { fileName: 'on.json', content: JSON.stringify(makeDoc({ uuid: 'u-on', enabled: true })) },
      { fileName: 'off.json', content: JSON.stringify(makeDoc({ uuid: 'u-off', enabled: false })) },
    ];
    const r = (await call('pom:booksource-bundle-apply', event, decisions)) as {
      written: string[];
      failed: unknown[];
    };
    expect(r.written).toEqual(['on.json', 'off.json']);
    expect(r.failed).toEqual([]);

    const dir = path.join(tmpUserData, 'booksources');
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'on.json'), 'utf-8')).enabled).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'off.json'), 'utf-8')).enabled).toBe(false);
    // 无 marker 文件
    expect(fs.existsSync(path.join(dir, 'off.json.disabled'))).toBe(false);

    // 广播 pom:booksource-updated，payload 带 { source: 'bundle-import', count }
    expect(event.sender.send).toHaveBeenCalledWith('pom:booksource-updated', {
      source: 'bundle-import',
      count: 2,
    });
  });

  it('apply：写前全量预校验不过 → 整体拒绝，不写任何文件', async () => {
    const event = FAKE_EVENT();
    const decisions = [
      { fileName: 'good.json', content: JSON.stringify(makeDoc()) },
      { fileName: 'bad.json', content: JSON.stringify(makeDoc({ sourceType: 'bogus' })) },
    ];
    await expect(call('pom:booksource-bundle-apply', event, decisions)).rejects.toThrow(/结构非法/);
    const dir = path.join(tmpUserData, 'booksources');
    expect(fs.existsSync(path.join(dir, 'good.json'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'bad.json'))).toBe(false);
    expect(event.sender.send).not.toHaveBeenCalled();
  });

  it('apply：路径穿越 fileName 被预校验拒绝', async () => {
    const decisions = [{ fileName: '../evil.json', content: JSON.stringify(makeDoc()) }];
    await expect(call('pom:booksource-bundle-apply', FAKE_EVENT(), decisions)).rejects.toThrow(
      /非法 fileName/,
    );
  });

  it('apply：部分写入失败收集进 failed（不回滚已写项）', async () => {
    // 预置同名目录让 atomicWrite 的 rename 失败（文件 rename 覆盖目录 → EISDIR/EPERM）
    const dir = path.join(tmpUserData, 'booksources');
    fs.mkdirSync(path.join(dir, 'blocked.json'), { recursive: true });

    const decisions = [
      { fileName: 'ok.json', content: JSON.stringify(makeDoc({ uuid: 'u-ok' })) },
      { fileName: 'blocked.json', content: JSON.stringify(makeDoc({ uuid: 'u-blocked' })) },
    ];
    const r = (await call('pom:booksource-bundle-apply', FAKE_EVENT(), decisions)) as {
      written: string[];
      failed: { fileName: string; error: string }[];
    };
    expect(r.written).toEqual(['ok.json']);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0].fileName).toBe('blocked.json');
    expect(r.failed[0].error).toBeTruthy();
    expect(fs.existsSync(path.join(dir, 'ok.json'))).toBe(true);
  });
});
