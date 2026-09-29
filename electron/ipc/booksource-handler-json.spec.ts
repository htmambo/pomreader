/**
 * 书源 JSON 相关 channel 行为测试（书源 JSON 规则化 P2.2）
 *
 * 用一个**假的 ipcMain** 驱动真实 handler：handler 全部逻辑（原子写、归档移动、
 * 报告读删、toggle 读改写）都在主进程这一侧，用 mock 掉 ipcRenderer 反而测不到。
 *
 * 覆盖：
 * - `booksource-toggle` 对 `.json` 走读改写、对 `.js` 仍走 marker（两种语义不串）
 * - `booksource-convert`：原子写 + 移走源文件 + 拒绝覆盖 + 坏 JSON 不落盘
 * - `booksource-migration-report-*`：读一次即删
 * - `booksource-legacy-list`：扫归档目录
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('electron', () => ({ app: {}, IpcMain: class {} }));

import { registerBookSourceHandler } from './booksource-handler';
import { JSON_SOURCE_FORMAT } from './booksource-meta';

/** 收集 handler 注册的 channel，便于直接调用（不经过 Electron 运行时） */
function fakeIpcMain(): {
  handle: (channel: string, fn: (...args: unknown[]) => unknown) => void;
  call: (channel: string, ...args: unknown[]) => unknown;
  /**
   * 走 `safeHandle` 的 channel（`booksource-convert` / `booksource-archive`）注册的是
   * **async** 包装函数（safeHandle 内部是 `async (…) => …`），返回值是 Promise，
   * 与真实 Electron 运行时一致 —— 这两个 channel 的断言必须用本方法 await。
   */
  callAsync: (channel: string, ...args: unknown[]) => Promise<unknown>;
} {
  const map = new Map<string, (...args: unknown[]) => unknown>();
  return {
    handle: (channel, fn) => map.set(channel, fn),
    callAsync: async (channel, ...args) => {
      const fn = map.get(channel);
      if (!fn) throw new Error(`未注册的 channel: ${channel}`);
      return await fn({}, ...args);
    },
    call: (channel, ...args) => {
      const fn = map.get(channel);
      if (!fn) throw new Error(`未注册的 channel: ${channel}`);
      // 去掉首参 event（handler 签名是 (event, ...args)）
      return fn({}, ...args);
    },
  };
}

function validDoc(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    format: JSON_SOURCE_FORMAT,
    schemaVersion: 1,
    uuid: 'uuid-abc',
    name: '示例源',
    homepage: 'https://example.com',
    urls: ['https://example.com'],
    enabled: true,
    rules: {
      siteName: 'S',
      searchPath: '/s',
      searchItemPattern: 'ul li',
      bookTitlePattern: 'h1',
      bookAuthorPattern: 'css:.a',
      chapterItemPattern: 'ul.c a',
      contentPattern: 'div#content',
    },
    ...overrides,
  });
}

let userData: string;
let ipc: ReturnType<typeof fakeIpcMain>;

const bsDir = (): string => path.join(userData, 'booksources');
const read = (name: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(path.join(bsDir(), name), 'utf-8'));

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-handler-'));
  ipc = fakeIpcMain();
  registerBookSourceHandler(ipc as never, userData);
});

afterEach(() => {
  fs.rmSync(userData, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('booksource-list：合并两种后缀', () => {
  it('.js 与 .json 一起返回，形状一致', async () => {
    fs.writeFileSync(
      path.join(bsDir(), 'old.js'),
      '// @name 老的\n// @url https://old.example.com\n',
    );
    fs.writeFileSync(path.join(bsDir(), 'new.json'), validDoc());
    const items = ipc.call('pom:booksource-list') as Record<string, unknown>[];
    expect(items.map((i) => i.fileName)).toEqual(['new.json', 'old.js']);
    expect(items[0].format).toBe('json');
    expect(items[1].format).toBeUndefined();
  });
});

describe('booksource-toggle：.json 读改写，.js 仍走 marker', () => {
  it('.json：enabled 落进文档内，**不**产生 marker 文件', async () => {
    fs.writeFileSync(path.join(bsDir(), 'a.json'), validDoc());
    ipc.call('pom:booksource-toggle', 'a.json', false);
    expect(read('a.json').enabled).toBe(false);
    expect(fs.existsSync(path.join(bsDir(), 'a.json.disabled'))).toBe(false);
    expect(fs.existsSync(path.join(bsDir(), 'a.json.enabled'))).toBe(false);
  });

  it('.json：toggle 不破坏其余字段（读改写，不是重建）', async () => {
    fs.writeFileSync(path.join(bsDir(), 'a.json'), validDoc());
    ipc.call('pom:booksource-toggle', 'a.json', false);
    const doc = read('a.json');
    expect(doc.uuid).toBe('uuid-abc');
    expect(doc.rules).toBeTruthy();
  });

  it('.json：反复 toggle 可来回切换', async () => {
    fs.writeFileSync(path.join(bsDir(), 'a.json'), validDoc());
    ipc.call('pom:booksource-toggle', 'a.json', false);
    ipc.call('pom:booksource-toggle', 'a.json', true);
    expect(read('a.json').enabled).toBe(true);
  });

  it('.js：仍写 marker 文件，**不**去改源文件内容', async () => {
    const js = '// @name 老的\nconst A = 1;\n';
    fs.writeFileSync(path.join(bsDir(), 'old.js'), js);
    ipc.call('pom:booksource-toggle', 'old.js', false);
    expect(fs.existsSync(path.join(bsDir(), 'old.js.disabled'))).toBe(true);
    expect(fs.readFileSync(path.join(bsDir(), 'old.js'), 'utf-8')).toBe(js);
  });

  it('.js：写失败时**原 marker 完好**（外部评审 R2：先删后写会让禁用状态静默反转）', async () => {
    fs.writeFileSync(path.join(bsDir(), 'old.js'), '// @name 老的\n');
    fs.writeFileSync(path.join(bsDir(), 'old.js.disabled'), '');
    // 把要写的目标占成一个目录 → atomicWrite 的 rename 必然失败
    fs.mkdirSync(path.join(bsDir(), 'old.js.enabled'));
    expect(() => ipc.call('pom:booksource-toggle', 'old.js', true)).toThrow();
    // 关键：用户明确禁用过的状态没有被清掉
    expect(fs.existsSync(path.join(bsDir(), 'old.js.disabled'))).toBe(true);
  });

  it('.js：写成功后才清理对立 marker（切换方向正确）', async () => {
    fs.writeFileSync(path.join(bsDir(), 'old.js'), '// @name 老的\n');
    ipc.call('pom:booksource-toggle', 'old.js', false);
    expect(fs.existsSync(path.join(bsDir(), 'old.js.disabled'))).toBe(true);
    expect(fs.existsSync(path.join(bsDir(), 'old.js.enabled'))).toBe(false);
    ipc.call('pom:booksource-toggle', 'old.js', true);
    expect(fs.existsSync(path.join(bsDir(), 'old.js.enabled'))).toBe(true);
    expect(fs.existsSync(path.join(bsDir(), 'old.js.disabled'))).toBe(false);
  });

  it('.json 文件不存在时报错（不静默建空文件）', async () => {
    expect(() => ipc.call('pom:booksource-toggle', 'ghost.json', false)).toThrow(/不存在/);
  });

  it('坏 JSON 上 toggle **报错而不是覆盖**：宁可不改，也不毁掉用户文档', async () => {
    const broken = '{ not json';
    fs.writeFileSync(path.join(bsDir(), 'a.json'), broken);
    expect(() => ipc.call('pom:booksource-toggle', 'a.json', false)).toThrow(/不是合法 JSON/);
    // 关键：原文件内容原封不动
    expect(fs.readFileSync(path.join(bsDir(), 'a.json'), 'utf-8')).toBe(broken);
  });

  it('顶层是数组的 JSON 上 toggle 报错（同上，不覆盖）', async () => {
    fs.writeFileSync(path.join(bsDir(), 'a.json'), '[]');
    expect(() => ipc.call('pom:booksource-toggle', 'a.json', false)).toThrow(/顶层不是对象/);
    expect(fs.readFileSync(path.join(bsDir(), 'a.json'), 'utf-8')).toBe('[]');
  });
});

describe('booksource-convert：落盘 + 归档', () => {
  it('写 .json 并把 .js 移进归档目录', async () => {
    fs.writeFileSync(path.join(bsDir(), 'old.js'), '// @name 老的\n');
    const name = (await ipc.callAsync('pom:booksource-convert', 'old.js', validDoc())) as string;
    expect(name).toBe('old.json');
    expect(fs.existsSync(path.join(bsDir(), 'old.json'))).toBe(true);
    expect(fs.existsSync(path.join(bsDir(), 'old.js'))).toBe(false);
    expect(fs.existsSync(path.join(userData, 'booksources_legacy', 'old.js'))).toBe(true);
  });

  it('目标已存在时拒绝覆盖（不毁用户已编辑的规则）', async () => {
    fs.writeFileSync(path.join(bsDir(), 'old.js'), '// @name 老的\n');
    fs.writeFileSync(path.join(bsDir(), 'old.json'), validDoc({ name: '用户改过的' }));
    await expect(ipc.callAsync('pom:booksource-convert', 'old.js', validDoc())).rejects.toThrow(
      /拒绝覆盖/,
    );
    expect(read('old.json').name).toBe('用户改过的');
    // 源文件也**不动**：转换失败不该把用户源移走
    expect(fs.existsSync(path.join(bsDir(), 'old.js'))).toBe(true);
  });

  it('坏 JSON 不落盘、也不移走源文件', async () => {
    fs.writeFileSync(path.join(bsDir(), 'old.js'), '// @name 老的\n');
    await expect(ipc.callAsync('pom:booksource-convert', 'old.js', '{ broken')).rejects.toThrow(
      /不是合法 JSON/,
    );
    expect(fs.existsSync(path.join(bsDir(), 'old.json'))).toBe(false);
    expect(fs.existsSync(path.join(bsDir(), 'old.js'))).toBe(true);
  });

  it('format 不对时拒绝', async () => {
    fs.writeFileSync(path.join(bsDir(), 'old.js'), '// @name 老的\n');
    await expect(
      ipc.callAsync('pom:booksource-convert', 'old.js', JSON.stringify({ format: 'legado' })),
    ).rejects.toThrow(/format/);
  });

  it('信封不过时拒绝，且**不落盘、不归档**（外部评审 P0：否则可用 .js 被移走、换来一份坏 .json）', async () => {
    fs.writeFileSync(path.join(bsDir(), 'old.js'), '// @name 老的\n');
    const doc = JSON.parse(validDoc());
    delete doc.rules.searchPath;
    await expect(
      ipc.callAsync('pom:booksource-convert', 'old.js', JSON.stringify(doc)),
    ).rejects.toThrow(/信封校验失败/);
    expect(fs.existsSync(path.join(bsDir(), 'old.json'))).toBe(false);
    // 关键：源文件留在原位可用，用户没有损失任何东西
    expect(fs.existsSync(path.join(bsDir(), 'old.js'))).toBe(true);
    expect(fs.existsSync(path.join(userData, 'booksources_legacy', 'old.js'))).toBe(false);
  });

  it('信封不过的几种形态都被拒（缺 uuid / 缺 homepage / schemaVersion 不支持）', async () => {
    fs.writeFileSync(path.join(bsDir(), 'old.js'), '// @name 老的\n');
    for (const mutate of [
      (d: Record<string, unknown>) => delete d.uuid,
      (d: Record<string, unknown>) => delete d.homepage,
      (d: Record<string, unknown>) => (d.schemaVersion = 2),
    ]) {
      const doc = JSON.parse(validDoc());
      mutate(doc);
      await expect(
        ipc.callAsync('pom:booksource-convert', 'old.js', JSON.stringify(doc)),
      ).rejects.toThrow(/信封校验失败/);
    }
    expect(fs.existsSync(path.join(bsDir(), 'old.json'))).toBe(false);
  });

  it('非法 fileName 拒绝（不落盘）', async () => {
    // schema 层（safeHandle）就拦下，消息带 channel + 字段，比 handler 里的"非法 fileName"更可定位
    await expect(ipc.callAsync('pom:booksource-convert', '../evil.js', validDoc())).rejects.toThrow(
      /invalid args/,
    );
  });

  it('落盘格式：2 空格缩进 + 结尾换行（与编辑器保存一致，避免整文件 diff）', async () => {
    fs.writeFileSync(path.join(bsDir(), 'old.js'), '// @name 老的\n');
    await ipc.callAsync('pom:booksource-convert', 'old.js', validDoc());
    const raw = fs.readFileSync(path.join(bsDir(), 'old.json'), 'utf-8');
    expect(raw.startsWith('{\n  "format"')).toBe(true);
    expect(raw.endsWith('\n')).toBe(true);
  });

  it('归档移动失败只 warn，.json 已落盘即算迁移成功（数据不丢）', async () => {
    fs.writeFileSync(path.join(bsDir(), 'old.js'), '// @name 老的\n');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // 把归档目标变成一个已存在的目录 → renameSync 必然失败（EISDIR/ENOTEMPTY）
    fs.mkdirSync(path.join(userData, 'booksources_legacy'), { recursive: true });
    fs.mkdirSync(path.join(userData, 'booksources_legacy', 'old.js'));
    const name = (await ipc.callAsync('pom:booksource-convert', 'old.js', validDoc())) as string;
    expect(name).toBe('old.json');
    expect(fs.existsSync(path.join(bsDir(), 'old.json'))).toBe(true);
    expect(warn).toHaveBeenCalled();
  });

  it('归档目标已存在同名目录时：copy 失败则源文件留在原处（不删）', async () => {
    fs.writeFileSync(path.join(bsDir(), 'old.js'), '// @name 老的\n');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fs.mkdirSync(path.join(userData, 'booksources_legacy'), { recursive: true });
    fs.mkdirSync(path.join(userData, 'booksources_legacy', 'old.js')); // 目标是目录
    await ipc.callAsync('pom:booksource-convert', 'old.js', validDoc());
    // copyFileSync 写到目录会失败 → 绝不执行 unlink，源文件保住
    expect(fs.existsSync(path.join(bsDir(), 'old.js'))).toBe(true);
    expect(warn).toHaveBeenCalled();
  });
});

describe('booksource-migration-report：读一次即删', () => {
  it('写入后能读到，读完文件即消失', async () => {
    const report = { migrated: 3, needsManual: false, failed: [] };
    ipc.call('pom:booksource-migration-report-write', report);
    expect(ipc.call('pom:booksource-migration-report-read')).toEqual(report);
    expect(fs.existsSync(path.join(userData, 'booksources_migration_report.json'))).toBe(false);
  });

  it('无报告时返回 null（不是 {} —— 空对象会被误读成"迁了 0 个"）', async () => {
    expect(ipc.call('pom:booksource-migration-report-read')).toBeNull();
  });

  it('第二次读返回 null（确实只读一次）', async () => {
    ipc.call('pom:booksource-migration-report-write', { migrated: 1 });
    ipc.call('pom:booksource-migration-report-read');
    expect(ipc.call('pom:booksource-migration-report-read')).toBeNull();
  });

  it('报告本身是坏 JSON：删掉它并回一个明确失败态（不无限重试坏数据）', async () => {
    const p = path.join(userData, 'booksources_migration_report.json');
    fs.writeFileSync(p, '{ broken');
    const out = ipc.call('pom:booksource-migration-report-read') as Record<string, unknown>;
    expect(fs.existsSync(p)).toBe(false);
    // 坏路径必须返回**同一种形状**（P3.1 统一）：旧实现回 `{needsManual: true, failed:[{fileName,error}]}`，
    // 字段名与结构都不同，渲染端只能崩或显示空
    expect(Object.keys(out).sort()).toEqual([
      'at',
      'converted',
      'failed',
      'needsManual',
      'skipped',
    ]);
    expect(out.failed).toHaveLength(1);
  });

  it('正常写出的报告读回来形状与写出去的一致（消费方只有一套解析）', async () => {
    const report = {
      at: '2026-09-29T00:00:00.000Z',
      converted: [{ fileName: 'a.js', jsonFileName: 'a.json', reason: '纯模板源，直接转换' }],
      needsManual: [{ fileName: 'b.js', reason: '模板外函数: hack' }],
      failed: [],
      skipped: 2,
    };
    ipc.call('pom:booksource-migration-report-write', report);
    const out = ipc.call('pom:booksource-migration-report-read') as typeof report;
    expect(out).toEqual(report);
  });
});

describe('booksource-archive：needs-manual 源只归档、不产 JSON（P3.1）', () => {
  const legacyDir = (): string => path.join(userData, 'booksources_legacy');

  it('.js 与两个 marker 一起搬进 legacy，主目录不留残骸', async () => {
    const js = '// @name 手改的\nfunction hack() {}\n';
    fs.writeFileSync(path.join(bsDir(), 'old.js'), js);
    fs.writeFileSync(path.join(bsDir(), 'old.js.disabled'), '');
    await ipc.callAsync('pom:booksource-archive', 'old.js', '模板外函数: hack');
    expect(fs.readFileSync(path.join(legacyDir(), 'old.js'), 'utf-8')).toBe(js);
    // marker 必须跟着走：留在 legacy 里的源恒为"未启用"，回滚 JS 链路后行为与迁移前不一致
    expect(fs.existsSync(path.join(legacyDir(), 'old.js.disabled'))).toBe(true);
    expect(fs.existsSync(path.join(bsDir(), 'old.js'))).toBe(false);
    expect(fs.existsSync(path.join(bsDir(), 'old.js.disabled'))).toBe(false);
    // 不产 JSON
    expect(fs.existsSync(path.join(bsDir(), 'old.json'))).toBe(false);
  });

  it('只有 .enabled marker 时也照搬（两个后缀都处理）', async () => {
    fs.writeFileSync(path.join(bsDir(), 'old.js'), '// @name x\n');
    fs.writeFileSync(path.join(bsDir(), 'old.js.enabled'), '');
    await ipc.callAsync('pom:booksource-archive', 'old.js', '理由');
    expect(fs.existsSync(path.join(legacyDir(), 'old.js.enabled'))).toBe(true);
  });

  it('文件不存在时抛错（不静默成功 —— 调用方会误以为归档完了）', async () => {
    await expect(ipc.callAsync('pom:booksource-archive', 'nope.js', '理由')).rejects.toThrow(
      /不存在/,
    );
  });

  it('拒绝非 .js 与路径穿越', async () => {
    fs.writeFileSync(path.join(bsDir(), 'a.json'), validDoc());
    await expect(ipc.callAsync('pom:booksource-archive', 'a.json', '理由')).rejects.toThrow(/\.js/);
    await expect(ipc.callAsync('pom:booksource-archive', '../evil.js', '理由')).rejects.toThrow(
      /invalid args/,
    );
  });

  it('归档失败**必须抛**（外部评审 R1）：源还在原处却报成功 → needs-manual 清单出幽灵', async () => {
    // 把 legacy 里的目标占成一个目录 → rename 必失败（非 EXDEV 分支）
    fs.writeFileSync(path.join(bsDir(), 'old.js'), '// @name 手改的\n');
    fs.mkdirSync(path.join(userData, 'booksources_legacy', 'old.js'), { recursive: true });
    await expect(
      ipc.callAsync('pom:booksource-archive', 'old.js', '模板外函数: hack'),
    ).rejects.toThrow(/归档/);
    // 源文件原地不动（数据不丢）
    expect(fs.existsSync(path.join(bsDir(), 'old.js'))).toBe(true);
  });
});

describe('booksource-convert：marker 必须随 .js 一起消失（P3.1 补）', () => {
  it('转换后 .js 的 .disabled marker 不留在 booksources/（否则与同名 .json 的 enabled 各说各话）', async () => {
    fs.writeFileSync(
      path.join(bsDir(), 'old.js'),
      '// @name 老的\n// @url https://old.example.com\n',
    );
    fs.writeFileSync(path.join(bsDir(), 'old.js.disabled'), '');
    await ipc.callAsync('pom:booksource-convert', 'old.js', validDoc());
    expect(fs.existsSync(path.join(bsDir(), 'old.js.disabled'))).toBe(false);
    expect(fs.existsSync(path.join(bsDir(), 'old.js.enabled'))).toBe(false);
    // 禁用状态已经内联进文档
    expect(read('old.json').enabled).toBe(true);
  });

  it('归档失败**不抛**：.json 已可用，抛了反而让这条源永久停在 failed（外部评审 R1 的反面）', async () => {
    fs.writeFileSync(
      path.join(bsDir(), 'old.js'),
      '// @name 老的\n// @url https://old.example.com\n',
    );
    // legacy 目标被目录占住 → rename 必失败
    fs.mkdirSync(path.join(userData, 'booksources_legacy', 'old.js'), { recursive: true });
    const name = (await ipc.callAsync('pom:booksource-convert', 'old.js', validDoc())) as string;
    expect(name).toBe('old.json');
    expect(read('old.json').uuid).toBe('uuid-abc');
    // .js 留在原处 —— 下次启动会因"同 uuid 的 JSON 已存在"被判 skip，不会死循环
    expect(fs.existsSync(path.join(bsDir(), 'old.js'))).toBe(true);
  });
});

describe('booksource-legacy-list：扫归档目录', () => {
  it('归档目录里能扫到 .js，目录不存在返回空', async () => {
    expect(ipc.call('pom:booksource-legacy-list')).toEqual([]);
    fs.mkdirSync(path.join(userData, 'booksources_legacy'), { recursive: true });
    fs.writeFileSync(path.join(userData, 'booksources_legacy', 'old.js'), '// @name 老的\n');
    const items = ipc.call('pom:booksource-legacy-list') as Record<string, unknown>[];
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe('老的');
  });

  it('归档目录里的 .json 不出现（那是新链路，不该混进"旧源"列表）', async () => {
    fs.mkdirSync(path.join(userData, 'booksources_legacy'), { recursive: true });
    fs.writeFileSync(path.join(userData, 'booksources_legacy', 'a.json'), validDoc());
    expect(ipc.call('pom:booksource-legacy-list')).toEqual([]);
  });
});

describe('booksource-eval 已下线', () => {
  it('channel 不再注册（P2 死链删除的回归钉）', async () => {
    expect(() => ipc.call('pom:booksource-eval', 'a.js', '')).toThrow(/未注册/);
  });
});

describe('booksource-save-draft：草稿只收 .json（P3.5 口径）', () => {
  it('拒绝 .js 草稿：草稿目录与主目录同为规则文档，不该存在第二种格式', async () => {
    await expect(ipc.callAsync('pom:booksource-save-draft', 'x.js', '// @name x')).rejects.toThrow(
      /\.json/,
    );
  });

  it('接受 .json 并原子落盘到 booksources_drafts/', async () => {
    await ipc.callAsync('pom:booksource-save-draft', 'x.json', '{"format":"pomreader.booksource"}');
    const p = path.join(userData, 'booksources_drafts', 'x.json');
    expect(fs.readFileSync(p, 'utf-8')).toContain('pomreader.booksource');
  });
});
