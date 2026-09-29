import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Mock electron BEFORE importing booksource-handler (handler uses electron, but
// resolvePath / resolveDir are pure path/fs helpers that don't depend on electron)
vi.mock('electron', () => ({
  app: {},
  IpcMain: class {},
}));

import {
  resolvePath,
  resolveDir,
  resolveJsonPath,
  registerBookSourceHandler,
} from './booksource-handler';

/**
 * booksource-handler spec — IPC handler 内的 path/fs helper 导出测试
 *
 * 覆盖：
 * - resolvePath：safeFileName + sourceDir 校验 + 主目录 fallback
 * - resolveDir：sourceDir 绝对路径校验 + 主目录自动创建
 *
 * 覆盖 booksource-handler.ts:30-54 关键契约（FR-1.5 防路径穿越）
 */

describe('resolvePath', () => {
  let tmpUserData: any;

  beforeEach(() => {
    tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-path-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpUserData, { recursive: true, force: true });
  });

  it('合法 fileName + 无 sourceDir 应返回 userData/booksources/<name>', () => {
    const p = resolvePath(tmpUserData, 'legado.js', null);
    expect(p).toBe(path.join(tmpUserData, 'booksources', 'legado.js'));
  });

  it('合法 fileName + undefined sourceDir 同上', () => {
    const p = resolvePath(tmpUserData, 'legado.js', undefined);
    expect(p).toBe(path.join(tmpUserData, 'booksources', 'legado.js'));
  });

  it('非法 fileName（../evil）应返回 null（FR-1.5）', () => {
    expect(resolvePath(tmpUserData, '../evil.js', null)).toBeNull();
  });

  it('非法 fileName（含 /）应返回 null', () => {
    expect(resolvePath(tmpUserData, 'foo/bar.js', null)).toBeNull();
  });

  it('非法 fileName（含 \\）应返回 null（Windows 路径分隔符）', () => {
    expect(resolvePath(tmpUserData, 'foo\\bar.js', null)).toBeNull();
  });

  it('空 fileName 应返回 null', () => {
    expect(resolvePath(tmpUserData, '', null)).toBeNull();
  });

  it('绝对路径 sourceDir 应使用 sourceDir + fileName', () => {
    const customDir = path.join(tmpUserData, 'custom');
    fs.mkdirSync(customDir, { recursive: true });
    const p = resolvePath(tmpUserData, 'x.js', customDir);
    expect(p).toBe(path.join(customDir, 'x.js'));
  });

  it('相对路径 sourceDir 应返回 null（防目录穿越）', () => {
    expect(resolvePath(tmpUserData, 'x.js', './relative')).toBeNull();
    expect(resolvePath(tmpUserData, 'x.js', 'relative/path')).toBeNull();
  });
});

describe('resolveDir', () => {
  let tmpUserData: any;

  beforeEach(() => {
    tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-dir-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpUserData, { recursive: true, force: true });
  });

  it('无 sourceDir 应自动创建并返回 userData/booksources', () => {
    expect(fs.existsSync(path.join(tmpUserData, 'booksources'))).toBe(false);
    const d = resolveDir(tmpUserData, null);
    expect(d).toBe(path.join(tmpUserData, 'booksources'));
    expect(fs.existsSync(d!)).toBe(true);
  });

  it('重复调用 resolveDir 应幂等（mkdirSync recursive）', () => {
    const d1 = resolveDir(tmpUserData, null);
    const d2 = resolveDir(tmpUserData, null);
    expect(d1).toBe(d2);
    expect(fs.existsSync(d2!)).toBe(true);
  });

  it('绝对路径 sourceDir 应原样返回（不 mkdir）', () => {
    const customDir = path.join(tmpUserData, 'external');
    const d = resolveDir(tmpUserData, customDir);
    expect(d).toBe(customDir);
    expect(fs.existsSync(customDir)).toBe(false); // 未自动创建
  });

  it('相对路径 sourceDir 应返回 null', () => {
    expect(resolveDir(tmpUserData, 'relative')).toBeNull();
    expect(resolveDir(tmpUserData, '../escape')).toBeNull();
  });
});

/* ── JSON 书源 channel（方案 §3.4，P2）：fake ipcMain 收集 handler 后逐个调 ── */

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

function makeJsonDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: 'pomreader.booksource',
    schemaVersion: 1,
    uuid: 'uuid-rt',
    name: '回环源',
    homepage: 'https://example.com/',
    urls: ['https://example.com/'],
    enabled: true,
    sourceType: 'novel',
    tags: [],
    minDelayMs: 0,
    requireUrls: [],
    headers: {},
    rules: {
      siteName: '回环源',
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

describe('resolveJsonPath（.json 后缀约束的路径解析）', () => {
  let tmpUserData: any;

  beforeEach(() => {
    tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-json-path-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpUserData, { recursive: true, force: true });
  });

  it('合法 .json fileName 应返回 userData/booksources/<name>', () => {
    expect(resolveJsonPath(tmpUserData, 'foo.json', null)).toBe(
      path.join(tmpUserData, 'booksources', 'foo.json'),
    );
  });

  it('非 .json fileName 应返回 null', () => {
    expect(resolveJsonPath(tmpUserData, 'foo.js', null)).toBeNull();
  });

  it('路径穿越 / 控制字符应返回 null', () => {
    expect(resolveJsonPath(tmpUserData, '../evil.json', null)).toBeNull();
    expect(resolveJsonPath(tmpUserData, 'foo\n.json', null)).toBeNull();
  });

  it('相对 sourceDir 应返回 null；绝对 sourceDir 应拼接', () => {
    expect(resolveJsonPath(tmpUserData, 'x.json', 'relative')).toBeNull();
    const dir = path.join(tmpUserData, 'ext');
    expect(resolveJsonPath(tmpUserData, 'x.json', dir)).toBe(path.join(dir, 'x.json'));
  });
});

describe('JSON 书源 channel（save → list → toggle → delete round-trip）', () => {
  let tmpUserData: any;
  let handlers: Map<string, HandlerFn>;

  const call = (channel: string, ...args: unknown[]): Promise<unknown> =>
    Promise.resolve(handlers.get(channel)!({}, ...args));

  beforeEach(() => {
    tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'booksource-json-ipc-test-'));
    const fake = createFakeIpcMain();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerBookSourceHandler(fake as any, tmpUserData);
    handlers = fake.handlers;
  });

  afterEach(() => {
    fs.rmSync(tmpUserData, { recursive: true, force: true });
  });

  it('应注册 5 个 JSON channel（旧 channel 不受影响）', () => {
    for (const ch of [
      'pom:booksource-list-json',
      'pom:booksource-list-json-streaming',
      'pom:booksource-save-json',
      'pom:booksource-toggle-json',
      'pom:booksource-delete-json',
      // 旧 channel 仍在
      'pom:booksource-list',
      'pom:booksource-save',
      'pom:booksource-toggle',
    ]) {
      expect(handlers.has(ch), ch).toBe(true);
    }
  });

  it('save-json → list-json → toggle-json → delete-json 全流程', async () => {
    await call('pom:booksource-save-json', 'rt.json', makeJsonDoc(), null);

    // 落盘内容是 JSON.stringify(doc, null, 2)
    const raw = fs.readFileSync(path.join(tmpUserData, 'booksources', 'rt.json'), 'utf-8');
    expect(raw).toBe(JSON.stringify(makeJsonDoc(), null, 2));

    let list = (await call('pom:booksource-list-json')) as Record<string, unknown>[];
    expect(list).toHaveLength(1);
    expect(list[0].uuid).toBe('uuid-rt');
    expect(list[0].enabled).toBe(true);

    // toggle 改写文档内 enabled（不写 marker）
    await call('pom:booksource-toggle-json', 'rt.json', false, null);
    const after = JSON.parse(
      fs.readFileSync(path.join(tmpUserData, 'booksources', 'rt.json'), 'utf-8'),
    );
    expect(after.enabled).toBe(false);
    expect(fs.existsSync(path.join(tmpUserData, 'booksources', 'rt.json.disabled'))).toBe(false);
    list = (await call('pom:booksource-list-json')) as Record<string, unknown>[];
    expect(list[0].enabled).toBe(false);

    // delete 只删 .json 本体，不清理 marker（JSON 源没有 marker；残留 marker 不被牵连）
    fs.writeFileSync(path.join(tmpUserData, 'booksources', 'rt.json.disabled'), '');
    await call('pom:booksource-delete-json', 'rt.json', null);
    expect(fs.existsSync(path.join(tmpUserData, 'booksources', 'rt.json'))).toBe(false);
    expect(fs.existsSync(path.join(tmpUserData, 'booksources', 'rt.json.disabled'))).toBe(true);
    list = (await call('pom:booksource-list-json')) as Record<string, unknown>[];
    expect(list).toHaveLength(0);
  });

  it('save-json：非 .json fileName 被 schema 拒绝（IpcValidationError）', async () => {
    await expect(call('pom:booksource-save-json', 'evil.js', makeJsonDoc(), null)).rejects.toThrow(
      /invalid args/,
    );
  });

  it('save-json：format 探针不命中的 doc 被 schema 拒绝', async () => {
    const doc = makeJsonDoc({ format: 'not-a-booksource' });
    await expect(call('pom:booksource-save-json', 'x.json', doc, null)).rejects.toThrow(
      /invalid args/,
    );
  });

  it('save-json：结构非法 doc（必填规则为空）被 handler 拒绝', async () => {
    const doc = makeJsonDoc();
    (doc.rules as Record<string, unknown>).contentPattern = '';
    await expect(call('pom:booksource-save-json', 'x.json', doc, null)).rejects.toThrow(
      /书源文档结构非法.*contentPattern/,
    );
    expect(fs.existsSync(path.join(tmpUserData, 'booksources', 'x.json'))).toBe(false);
  });

  it('save-json：相对 sourceDir 应抛错', async () => {
    await expect(call('pom:booksource-save-json', 'x.json', makeJsonDoc(), 'rel')).rejects.toThrow(
      /sourceDir/,
    );
  });

  it('toggle-json：文件不存在应抛错；enabled 非 boolean 被 schema 拒绝', async () => {
    await expect(call('pom:booksource-toggle-json', 'ghost.json', true, null)).rejects.toThrow(
      /文件不存在/,
    );
    await expect(call('pom:booksource-toggle-json', 'x.json', 'yes', null)).rejects.toThrow(
      /invalid args/,
    );
  });

  it('delete-json：非法 fileName 应抛错（不删任何东西）', async () => {
    await expect(call('pom:booksource-delete-json', '../escape.json', null)).rejects.toThrow(
      /非法 fileName/,
    );
  });

  it('list-json-streaming：批次事件推送到 pom:booksource-json-batch 且 done 收尾', async () => {
    await call('pom:booksource-save-json', 's1.json', makeJsonDoc({ uuid: 'u1' }), null);
    await call('pom:booksource-save-json', 's2.json', makeJsonDoc({ uuid: 'u2' }), null);

    const sent: Record<string, unknown>[] = [];
    const event = {
      sender: {
        isDestroyed: () => false,
        send: (channel: string, payload: Record<string, unknown>) => {
          expect(channel).toBe('pom:booksource-json-batch');
          sent.push(payload);
        },
      },
    };
    await Promise.resolve(handlers.get('pom:booksource-list-json-streaming')!(event, 'req-1'));
    // setImmediate 后台扫描：等两轮确保完成
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(sent.length).toBeGreaterThanOrEqual(1);
    const last = sent[sent.length - 1];
    expect(last.done).toBe(true);
    expect(last.requestId).toBe('req-1');
    expect(last.total).toBe(2);
    const allItems = sent.flatMap((p) => p.items as unknown[]);
    expect(allItems).toHaveLength(2);
  });
});
