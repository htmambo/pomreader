import { describe, it, expect, beforeEach, vi, beforeAll } from 'vitest';
import 'zone.js';
import { TestBed } from '@angular/core/testing';
import {
  BrowserDynamicTestingModule,
  platformBrowserDynamicTesting,
} from '@angular/platform-browser-dynamic/testing';
import { BrowserPouchBackend, createBackend, DbService } from './db.service';
import { Book } from '../models/book.model';

/**
 * DbService spec — PouchDB 后端 CRUD
 *
 * 策略：mock window.pomAPI.dbRequest 走 IPC bridge，让 DbService 走 IpcPouchBackend
 * 而非 PouchDB 直接调用。bridge 内部维护内存 store，模拟 PouchDB allDocs / get /
 * put / bulkDocs / destroy 行为。
 *
 * IPC 协议：{ result: T } 包装。Renderer 端 ipcRenderer.invoke('pom:xxx', a, b, c)
 * → Main 端 ipcMain.handle 收到 (event, a, b, c) 三个独立参数
 * → safeHandle(... rest) 收集为 [a, b, c] 数组 → v.safeParse(schema, args)
 *
 * 覆盖核心 CRUD：bookAll / bookGet / bookPut / bookDelete / chapterAll /
 * chapterPutMany / seedIfEmpty（no-op）/ bookUpdateProgress
 */

type Doc = any;

describe('DbService', () => {
  let store: Map<string, Doc>;

  let bridge: any;
  let svc: DbService;
  /** 默认 IPC 实现（内存 store 路由）；测试可包装它注入一次性故障 */
  let defaultImpl: (op: string, args: unknown[]) => Promise<unknown>;

  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserDynamicTestingModule, platformBrowserDynamicTesting());
  });

  beforeEach(async () => {
    store = new Map<string, Doc>();
    // IPC 协议（IpcPouchBackend 期望）：{ ok, result?, error? }
    // ok=false 时 IpcPouchBackend 抛 res.error；
    // 404 get 等也是 ok=false + error={status:404}（isNotFound 判定依据）

    const ok = (result: any) => ({ ok: true, result });

    const fail = (status: number, name: string, message: string) => ({
      ok: false,
      error: { status, name, message },
    });

    const writeDoc = (doc: Doc) => {
      const currentRev = store.get(doc._id)?._rev as string | undefined;
      const generation = currentRev ? Number.parseInt(currentRev, 10) + 1 : 1;
      const stored = { ...doc, _rev: `${generation}-memory` };
      store.set(doc._id, stored);
      return { ok: true, id: doc._id, rev: stored._rev };
    };

    defaultImpl = async (op: string, args: unknown[]) => {
      switch (op) {
        case 'allDocs': {
          // 缺省参数：真实 PouchDB 的 allDocs 不传 options 时返回仅元数据行
          const opts = (args[0] ?? {}) as {
            include_docs?: boolean;
            startkey?: string;
            endkey?: string;
            keys?: string[];
          };
          if (opts.keys) {
            // keys 模式：命中返回该文档；缺失 id 返回无 doc 的 error 行
            // （真实 PouchDB 语义：已删文档返回 doc=null，缺失 key 返回 error 行）
            const rows = opts.keys.map((key) => {
              const doc = store.get(key);
              if (!doc) return { key, error: 'not_found' };
              return {
                id: doc._id,
                key: doc._id,
                value: { rev: doc._rev },
                ...(opts.include_docs ? { doc } : {}),
              };
            });
            return ok({ rows });
          }
          const docs = Array.from(store.values()).filter((d) => {
            if (opts.startkey && d._id < opts.startkey) return false;
            if (opts.endkey && d._id >= opts.endkey) return false;
            return true;
          });
          // 与真实 PouchDB 对齐：行恒含 { id, key, value:{rev} }，
          // 仅在 include_docs 时才带 doc —— DbService 依赖「不传 include_docs
          // 就拿不到正文」这一语义（迁移扫描 / 孤儿比对只取 id+rev）
          return ok({
            rows: docs.map((doc) => ({
              id: doc._id,
              key: doc._id,
              value: { rev: doc._rev ?? '1-fake' },
              ...(opts.include_docs ? { doc } : {}),
            })),
          });
        }
        case 'get': {
          const id = args[0] as string;
          const doc = store.get(id);
          if (!doc) return fail(404, 'not_found', 'missing');
          return ok({ ...doc });
        }
        case 'put': {
          const doc = args[0] as Doc;
          if (doc._deleted) {
            store.delete(doc._id);
            return ok({ ok: true, id: doc._id, rev: doc._rev });
          }
          return ok(writeDoc(doc));
        }
        case 'bulkDocs': {
          const docs = args[0] as Doc[];
          const results: any[] = docs.map((doc) => {
            if (doc._deleted) {
              store.delete(doc._id);
              return { ok: true, id: doc._id, rev: doc._rev };
            }
            return writeDoc(doc);
          });
          return ok(results);
        }
        case 'destroy':
          store.clear();
          return ok({ ok: true });
        default:
          return fail(500, 'unknown_op', op);
      }
    };

    bridge = {
      dbRequest: vi.fn(defaultImpl),
    };

    (globalThis as any).window = { pomAPI: bridge };

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [DbService],
    });
    svc = TestBed.inject(DbService);
    // 冲刷一次性启动迁移（_id 迁移 + 正文拆分迁移）：
    // 迁移是后台任务，若不冲刷就会与用例内的 mock / 调用计数断言抢跑
    // （mockImplementationOnce 会被迁移的前置 IPC 消费掉）。
    await svc.chapterAll('__flush_migration__');
    // 冲刷产生的 IPC 调用不计入各用例的断言 → 清空调用日志
    bridge.dbRequest.mockClear();
  });

  afterEach(() => {
    delete (globalThis as any).window;
  });

  function makeBook(overrides: Partial<Book> = {}): Book {
    return {
      id: 'book-1',
      title: 'Test',
      author: 'Author',
      chapterCount: 0,
      totalChars: 0,
      importedAt: '2026-01-01T00:00:00Z',
      source: 'local-txt',
      ...overrides,
    };
  }

  function makeChapter(bookId: string, idx: number): Doc {
    return {
      _id: `chapter:${bookId}:${idx}`,
      type: 'chapter',
      bookId,
      index: idx,
      title: `ch${idx + 1}`,
      content: `content ${idx + 1}`,
      loaded: true,
    };
  }

  describe('bookPut / bookGet / bookAll', () => {
    it('bookPut 后 bookGet 应返回该书', async () => {
      const book = makeBook({ id: 'b1', title: '书1' });
      await svc.bookPut(book);
      const got = await svc.bookGet('b1');
      expect(got?.title).toBe('书1');
    });

    it('bookGet 不存在的 id 应返回 null', async () => {
      const got = await svc.bookGet('nonexistent');
      expect(got).toBeNull();
    });

    it('bookAll 应返回所有 books', async () => {
      await svc.bookPut(makeBook({ id: 'b1' }));
      await svc.bookPut(makeBook({ id: 'b2' }));
      const all = await svc.bookAll();
      expect(all).toHaveLength(2);
      expect(all.map((b) => b.id).sort()).toEqual(['b1', 'b2']);
    });
  });

  describe('bookDelete', () => {
    it('应删除书 + 级联删除章节', async () => {
      await svc.bookPut(makeBook({ id: 'b1' }));
      await svc.chapterPutMany([makeChapter('b1', 0), makeChapter('b1', 1)]);
      await svc.bookDelete('b1');
      expect(await svc.bookGet('b1')).toBeNull();
      expect(await svc.chapterAll('b1')).toHaveLength(0);
    });
  });

  describe('bookUpdateProgress', () => {
    it('应更新 progress + lastReadAt', async () => {
      await svc.bookPut(makeBook({ id: 'b1' }));
      await svc.bookUpdateProgress('b1', 5, 100);
      const got = await svc.bookGet('b1');
      expect(got?.progress?.chapterIndex).toBe(5);
      expect(got?.progress?.scrollOffset).toBe(100);
      expect(got?.lastReadAt).toBeDefined();
    });
  });

  describe('chapterPutMany / chapterAll', () => {
    it('chapterPutMany 后 chapterAll 应返回该书所有章节', async () => {
      await svc.chapterPutMany([makeChapter('b1', 0), makeChapter('b1', 1)]);
      const chs = await svc.chapterAll('b1');
      expect(chs).toHaveLength(2);
    });

    it('空数组 chapterPutMany 应直接返回', async () => {
      await expect(svc.chapterPutMany([])).resolves.toBeUndefined();
    });

    it('chapterGet 应返回单个章节', async () => {
      await svc.chapterPutMany([makeChapter('b1', 0)]);
      const ch = await svc.chapterGet('b1', 0);
      expect(ch?.title).toBe('ch1');
    });
  });

  // ===== Phase 5 覆盖率收紧补充：错误路径 / 重试 / 迁移 / 过滤分支 =====
  const SEP = String.fromCharCode(0x1f); // CHAPTER_SEP（Unit Separator）

  /** 重新构建 DbService 实例（构造函数会重新跑 migrateLegacyChapterIds） */
  function recreateService(): DbService {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [DbService],
    });
    return TestBed.inject(DbService);
  }

  function opCalls(op: string): unknown[][] {
    return bridge.dbRequest.mock.calls.filter((c: unknown[]) => c[0] === op);
  }

  /**
   * 章节相关 get 调用（排除迁移标记 `meta:migration:*` 的存在性探测）。
   * 迁移标记是启动期一次性探针，与「读取章节正文」无关；
   * 断言「不读正文」时应排除，否则会被标记探针误伤。
   */
  function chapterGetCalls(): unknown[][] {
    return opCalls('get').filter((c: unknown[]) => {
      const args = c[1] as unknown[] | undefined;
      const id = args?.[0];
      return typeof id === 'string' && !id.startsWith('meta:migration:');
    });
  }

  describe('bookGet / IPC 错误路径', () => {
    it('bookGet 遇到非 404 错误应原样抛出', async () => {
      bridge.dbRequest.mockImplementationOnce(async () => ({
        ok: false,
        error: { status: 500, name: 'io_error', message: 'disk full' },
      }));
      await expect(svc.bookGet('b1')).rejects.toMatchObject({ status: 500 });
    });

    it('IPC 返回 ok:false 且无 error 包络时应抛通用 Error', async () => {
      bridge.dbRequest.mockImplementationOnce(async () => ({ ok: false }));
      await expect(svc.bookGet('b1')).rejects.toThrow('db get failed');
    });
  });

  describe('bookPut 冲突重试与字段处理', () => {
    it('已有 progress 且新 book 无 progress 时应保留旧 progress', async () => {
      await svc.bookPut(
        makeBook({
          id: 'b1',
          progress: { chapterIndex: 7, scrollOffset: 42, updatedAt: '2026-03-01T00:00:00Z' },
        }),
      );
      // 再次写入：不带 progress 的编辑（模拟书籍信息编辑路径）
      await svc.bookPut(makeBook({ id: 'b1', title: '改名后' }));
      const got = await svc.bookGet('b1');
      expect(got?.title).toBe('改名后');
      expect(got?.progress?.chapterIndex).toBe(7);
      expect(got?.progress?.scrollOffset).toBe(42);
    });

    it('新 book 显式携带 progress 时应覆盖旧 progress', async () => {
      await svc.bookPut(
        makeBook({
          id: 'b1',
          progress: { chapterIndex: 7, updatedAt: '2026-03-01T00:00:00Z' },
        }),
      );
      await svc.bookPut(
        makeBook({
          id: 'b1',
          progress: { chapterIndex: 2, updatedAt: '2026-03-02T00:00:00Z' },
        }),
      );
      const got = await svc.bookGet('b1');
      expect(got?.progress?.chapterIndex).toBe(2);
    });

    it('应 strip 遗留 coverColor 字段（不写入 store）', async () => {
      const legacy = { ...makeBook({ id: 'b1' }), coverColor: '#ff0000' } as Book & {
        coverColor?: string;
      };
      await svc.bookPut(legacy);
      expect('coverColor' in (store.get('book:b1') as Doc)).toBe(false);
    });

    it('put 返回 409 时应重试一次并成功写入', async () => {
      let putSeen = 0;
      bridge.dbRequest.mockImplementation(async (op: string, args: unknown[]) => {
        if (op === 'put') {
          putSeen++;
          if (putSeen === 1) {
            return { ok: false, error: { status: 409, name: 'conflict', message: 'rev mismatch' } };
          }
        }
        return defaultImpl(op, args);
      });
      await svc.bookPut(makeBook({ id: 'b1', title: '冲突重试' }));
      const got = await svc.bookGet('b1');
      expect(got?.title).toBe('冲突重试');
      expect(opCalls('put')).toHaveLength(2); // 首次 409 + 重试成功
    });

    it('put 返回非 409 错误应直接抛出且不重试', async () => {
      bridge.dbRequest.mockImplementation(async (op: string, args: unknown[]) => {
        if (op === 'put') {
          return { ok: false, error: { status: 500, name: 'io_error', message: 'disk full' } };
        }
        return defaultImpl(op, args);
      });
      await expect(svc.bookPut(makeBook({ id: 'b1' }))).rejects.toMatchObject({ status: 500 });
      expect(opCalls('put')).toHaveLength(1); // 不重试
    });

    it('读取现有文档遇非 404 错误应抛出（不当作新文档处理）', async () => {
      bridge.dbRequest.mockImplementationOnce(async () => ({
        ok: false,
        error: { status: 500, name: 'io_error', message: 'read fail' },
      }));
      await expect(svc.bookPut(makeBook({ id: 'b1' }))).rejects.toMatchObject({ status: 500 });
    });
  });

  describe('bookUpdateProgress 边界', () => {
    it('书不存在时应抛出（get 404 直接传播）', async () => {
      await expect(svc.bookUpdateProgress('ghost', 1)).rejects.toMatchObject({ status: 404 });
    });

    it('put 409 时应重试一次并写入最新进度', async () => {
      await svc.bookPut(makeBook({ id: 'b1' }));
      let putSeen = 0;
      bridge.dbRequest.mockImplementation(async (op: string, args: unknown[]) => {
        if (op === 'put') {
          putSeen++;
          if (putSeen === 1) {
            return { ok: false, error: { status: 409, name: 'conflict', message: 'race' } };
          }
        }
        return defaultImpl(op, args);
      });
      await svc.bookUpdateProgress('b1', 3, 99);
      const got = await svc.bookGet('b1');
      expect(got?.progress?.chapterIndex).toBe(3);
      expect(got?.progress?.scrollOffset).toBe(99);
      expect(putSeen).toBe(2); // 首次 409 + 重试成功
    });

    it('不传 scrollOffset 时 progress.scrollOffset 应为 undefined', async () => {
      await svc.bookPut(makeBook({ id: 'b1' }));
      await svc.bookUpdateProgress('b1', 4);
      const got = await svc.bookGet('b1');
      expect(got?.progress?.chapterIndex).toBe(4);
      expect(got?.progress?.scrollOffset).toBeUndefined();
    });
  });

  describe('bookDelete 部分失败', () => {
    it('bulkDocs 返回非 409 致命错误时应抛 partial failure', async () => {
      await svc.bookPut(makeBook({ id: 'b1' }));
      await svc.chapterPutMany([makeChapter('b1', 0)]);
      bridge.dbRequest.mockImplementation(async (op: string, args: unknown[]) => {
        if (op === 'bulkDocs') {
          return {
            ok: true,
            result: [{ error: true, status: 500, name: 'io_error', message: 'x', id: 'book:b1' }],
          };
        }
        return defaultImpl(op, args);
      });
      await expect(svc.bookDelete('b1')).rejects.toThrow(/bookDelete partial failure/);
    });

    it('bulkDocs 返回 409（_rev 过期 = 未删除）时同样应抛，不得静默', async () => {
      await svc.bookPut(makeBook({ id: 'b1' }));
      await svc.chapterPutMany([makeChapter('b1', 0)]);
      bridge.dbRequest.mockImplementation(async (op: string, args: unknown[]) => {
        if (op === 'bulkDocs') {
          return {
            ok: true,
            result: [{ error: true, status: 409, name: 'conflict', message: 'x', id: 'book:b1' }],
          };
        }
        return defaultImpl(op, args);
      });
      await expect(svc.bookDelete('b1')).rejects.toThrow(/bookDelete partial failure/);
    });
  });

  describe('chapterGet 错误路径', () => {
    it('章节不存在应返回 null', async () => {
      expect(await svc.chapterGet('b1', 99)).toBeNull();
    });

    it('非 404 错误应原样抛出', async () => {
      bridge.dbRequest.mockImplementationOnce(async () => ({
        ok: false,
        error: { status: 500, name: 'io_error', message: 'disk full' },
      }));
      await expect(svc.chapterGet('b1', 0)).rejects.toMatchObject({ status: 500 });
    });
  });

  describe('chapterPut 单章写入', () => {
    it('chapterPut 后 chapterGet 应返回该章', async () => {
      await svc.chapterPut({
        bookId: 'b1',
        index: 2,
        title: '单章',
        content: '正文',
        loaded: true,
      });
      const ch = await svc.chapterGet('b1', 2);
      expect(ch?.title).toBe('单章');
      expect(ch?.content).toBe('正文');
    });

    it('put 409 时应重试一次并成功', async () => {
      let putSeen = 0;
      let bodyPutSeen = 0;
      bridge.dbRequest.mockImplementation(async (op: string, args: unknown[]) => {
        if (op === 'put') {
          const doc = args[0] as Doc;
          // 正文已拆到独立文档（A2）：元数据 put 与正文 put 分别计数
          if (String(doc._id).startsWith('chapter-body:')) {
            bodyPutSeen++;
          } else {
            putSeen++;
            if (putSeen === 1) {
              return { ok: false, error: { status: 409, name: 'conflict', message: 'race' } };
            }
          }
        }
        return defaultImpl(op, args);
      });
      await svc.chapterPut({ bookId: 'b1', index: 0, title: 'ch1', content: 'c', loaded: true });
      expect((await svc.chapterGet('b1', 0))?.title).toBe('ch1');
      expect(putSeen).toBe(2); // 元数据 put：首次 409 + 重试成功
      expect(bodyPutSeen).toBe(1); // 正文独立文档：单独一次 put
    });
  });

  describe('chapterPutMany 孤儿清理与批量错误', () => {
    it('新集合小于旧集合时孤儿章节应被删除（换源场景）', async () => {
      await svc.chapterPutMany([makeChapter('b1', 0), makeChapter('b1', 1), makeChapter('b1', 2)]);
      // 换源：新源只有 1 章 → 旧 idx 1/2 成为孤儿
      bridge.dbRequest.mockClear();
      await svc.chapterPutMany([makeChapter('b1', 0)]);
      const chs = await svc.chapterAll('b1');
      expect(chs).toHaveLength(1);
      expect(chs[0].index).toBe(0);
      const batch = opCalls('bulkDocs')[0][1][0] as Doc[];
      // A2：正文已拆到独立 chapter-body 文档 → 章节孤儿与正文孤儿各自打墓碑
      expect(batch.filter((doc) => doc._deleted).map((doc) => doc._id)).toEqual([
        `chapter-body:b1${SEP}1`,
        `chapter-body:b1${SEP}2`,
        `chapter:b1${SEP}1`,
        `chapter:b1${SEP}2`,
      ]);
    });

    it('相同 ID 集合刷新时不读取任何已有章节正文', async () => {
      await svc.chapterPutMany([makeChapter('b1', 0), makeChapter('b1', 1)]);
      bridge.dbRequest.mockClear();
      await svc.chapterPutMany([makeChapter('b1', 0), makeChapter('b1', 1)]);
      expect(chapterGetCalls()).toHaveLength(0);
      // 两次范围扫描，都只取 id+rev，不拉正文：
      // [0] 章节元数据（include_docs:false）[1] 正文文档（不传 include_docs）
      expect(opCalls('allDocs')).toHaveLength(2);
      expect(opCalls('allDocs')[0][1]).toEqual([expect.objectContaining({ include_docs: false })]);
      const bodyScan = opCalls('allDocs')[1][1][0] as {
        include_docs?: boolean;
        startkey?: string;
      };
      expect(bodyScan.startkey).toBe(`chapter-body:b1${SEP}`);
      expect(bodyScan.include_docs).toBeUndefined();
    });

    it('缩短集合时只批量读取孤儿候选', async () => {
      await svc.chapterPutMany([makeChapter('b1', 0), makeChapter('b1', 1), makeChapter('b1', 2)]);
      bridge.dbRequest.mockClear();
      await svc.chapterPutMany([makeChapter('b1', 0)]);
      expect(opCalls('allDocs')[0][1]).toEqual([expect.objectContaining({ include_docs: false })]);
      // 候选正文一次性批量取：一次请求覆盖全部孤儿，不逐个 get
      // （[1] 是正文文档范围扫描，[2] 才是按 id 批量取章节孤儿）
      expect(opCalls('allDocs')[2][1]).toEqual([
        expect.objectContaining({
          keys: [`chapter:b1${SEP}1`, `chapter:b1${SEP}2`],
          include_docs: true,
        }),
      ]);
      expect(chapterGetCalls()).toHaveLength(0);
    });

    it('同前缀非 chapter 文档不应作为孤儿删除', async () => {
      await svc.chapterPutMany([makeChapter('b1', 0)]);
      const intruderId = `chapter:b1${SEP}9`;
      store.set(intruderId, {
        _id: intruderId,
        _rev: '1-intruder',
        type: 'book',
        id: 'intruder',
      });
      bridge.dbRequest.mockClear();
      await svc.chapterPutMany([makeChapter('b1', 0)]);
      const batch = opCalls('bulkDocs')[0][1][0] as Doc[];
      expect(batch.some((doc) => doc._deleted)).toBe(false);
      expect(store.has(intruderId)).toBe(true);
    });

    it('已删除的孤儿候选不应再打墓碑', async () => {
      await svc.chapterPutMany([makeChapter('b1', 0), makeChapter('b1', 1)]);
      const orphanId = `chapter:b1${SEP}1`;
      // PouchDB keys 模式：已删文档返回 doc=null（正文与 _rev 均不返回）
      bridge.dbRequest.mockImplementation(async (op: string, args: unknown[]) => {
        const opts = (args[0] ?? {}) as { keys?: string[] };
        if (op === 'allDocs' && opts.keys?.includes(orphanId)) {
          return {
            ok: true,
            result: {
              rows: [
                {
                  id: orphanId,
                  key: orphanId,
                  value: { rev: '2-dead', deleted: true },
                  doc: null,
                },
              ],
            },
          };
        }
        return defaultImpl(op, args);
      });
      bridge.dbRequest.mockClear();
      await svc.chapterPutMany([makeChapter('b1', 0)]);
      const batch = opCalls('bulkDocs')[0][1][0] as Doc[];
      // 章节元数据孤儿不应打墓碑（正文文档的清理由 A2 的正文孤儿逻辑单独负责）
      expect(batch.filter((doc) => doc._deleted && String(doc._id).startsWith('chapter:'))).toEqual(
        [],
      );
    });

    it('孤儿 tombstone 应使用候选读取时的最新 revision', async () => {
      await svc.chapterPutMany([makeChapter('b1', 0), makeChapter('b1', 1)]);
      const orphanId = `chapter:b1${SEP}1`;
      bridge.dbRequest.mockImplementation(async (op: string, args: unknown[]) => {
        const result = await defaultImpl(op, args);
        if (op === 'allDocs') {
          const current = store.get(orphanId);
          store.set(orphanId, { ...current, _rev: '9-latest' });
        }
        return result;
      });
      bridge.dbRequest.mockClear();
      await svc.chapterPutMany([makeChapter('b1', 0)]);
      const batch = opCalls('bulkDocs')[0][1][0] as Doc[];
      expect(batch).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ _id: orphanId, _rev: '9-latest', _deleted: true }),
        ]),
      );
    });

    it('孤儿候选扫描后 404 应幂等跳过', async () => {
      await svc.chapterPutMany([makeChapter('b1', 0), makeChapter('b1', 1)]);
      const orphanId = `chapter:b1${SEP}1`;
      bridge.dbRequest.mockImplementation(async (op: string, args: unknown[]) => {
        const result = await defaultImpl(op, args);
        if (op === 'allDocs') store.delete(orphanId);
        return result;
      });
      bridge.dbRequest.mockClear();
      await expect(svc.chapterPutMany([makeChapter('b1', 0)])).resolves.toBeUndefined();
      const batch = opCalls('bulkDocs')[0][1][0] as Doc[];
      expect(batch.filter((doc) => doc._deleted && String(doc._id).startsWith('chapter:'))).toEqual(
        [],
      );
    });

    it('孤儿候选批量读取的非 404 错误应抛出', async () => {
      await svc.chapterPutMany([makeChapter('b1', 0), makeChapter('b1', 1)]);
      bridge.dbRequest.mockImplementation(async (op: string, args: unknown[]) => {
        const opts = (args[0] ?? {}) as { keys?: string[] };
        if (op === 'allDocs' && opts.keys) {
          return { ok: false, error: { status: 500, name: 'io_error', message: 'read fail' } };
        }
        return defaultImpl(op, args);
      });
      await expect(svc.chapterPutMany([makeChapter('b1', 0)])).rejects.toMatchObject({
        status: 500,
      });
    });

    it('bulkDocs 返回非 409 致命错误时应抛出', async () => {
      bridge.dbRequest.mockImplementation(async (op: string, args: unknown[]) => {
        if (op === 'bulkDocs') {
          return {
            ok: true,
            result: [
              { error: true, status: 500, name: 'io_error', message: 'x', id: `chapter:b1${SEP}0` },
            ],
          };
        }
        return defaultImpl(op, args);
      });
      await expect(svc.chapterPutMany([makeChapter('b1', 0)])).rejects.toThrow(
        /chapter bulk write failed/,
      );
    });

    it('孤儿删除 409 应 console.warn 但不阻塞主流程', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await svc.chapterPutMany([makeChapter('b1', 0), makeChapter('b1', 1)]);
        // 第二次写入：1 个新章（+ 正文文档）+ 孤儿删除（章节文档 + 正文文档）；
        // bulkDocs 逐文档返回：写入成功、删除 409（_rev 过期 = 未删除）
        bridge.dbRequest.mockImplementation(async (op: string, args: unknown[]) => {
          if (op === 'bulkDocs') {
            const docs = args[0] as Doc[];
            return {
              ok: true,
              result: docs.map((d) =>
                d._deleted
                  ? {
                      error: true,
                      status: 409,
                      name: 'conflict',
                      message: 'x',
                      id: d._id,
                    }
                  : { ok: true, id: d._id },
              ),
            };
          }
          return defaultImpl(op, args);
        });
        await expect(svc.chapterPutMany([makeChapter('b1', 0)])).resolves.toBeUndefined();
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(/orphan deletes lost _rev race/));
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe('allDocs 过滤与排序分支', () => {
    it('bookAll 应忽略 book: 前缀下非 book 类型文档', async () => {
      await svc.bookPut(makeBook({ id: 'b1' }));
      store.set('book:intruder', {
        _id: 'book:intruder',
        _rev: '1-intruder',
        type: 'chapter',
        bookId: 'x',
      });
      const all = await svc.bookAll();
      expect(all).toHaveLength(1);
      expect(all[0].id).toBe('b1');
    });

    it('chapterAll 应按 index 升序返回（与写入顺序无关）', async () => {
      await svc.chapterPutMany([makeChapter('b1', 2), makeChapter('b1', 0), makeChapter('b1', 1)]);
      const chs = await svc.chapterAll('b1');
      expect(chs.map((c) => c.index)).toEqual([0, 1, 2]);
    });

    it('chapterAll 应忽略 chapter: 前缀下非 chapter 类型文档', async () => {
      await svc.chapterPutMany([makeChapter('b1', 0)]);
      store.set(`chapter:b1${SEP}9`, {
        _id: `chapter:b1${SEP}9`,
        _rev: '1-ghost',
        type: 'book',
        id: 'ghost',
      });
      const chs = await svc.chapterAll('b1');
      expect(chs).toHaveLength(1);
    });

    it('bookGet 返回的 Book 不应携带遗留 coverColor 字段', async () => {
      store.set('book:b1', {
        _id: 'book:b1',
        _rev: '1-x',
        type: 'book',
        ...makeBook({ id: 'b1' }),
        coverColor: '#00ff00',
      });
      const got = await svc.bookGet('b1');
      expect(got).not.toBeNull();
      expect('coverColor' in (got as Book & { coverColor?: string })).toBe(false);
    });
  });

  describe('migrateLegacyChapterIds 旧 _id 迁移', () => {
    function makeLegacyChapter(bookId: string, idx: number): Doc {
      return {
        _id: `chapter:${bookId}:${idx}`, // 旧冒号分隔格式
        _rev: `1-legacy${idx}`,
        type: 'chapter',
        bookId,
        index: idx,
        title: `legacy ch${idx}`,
        content: `legacy content ${idx}`,
        loaded: true,
      };
    }

    it('旧冒号格式 _id 应迁移为 Unit Separator 格式且可正常读取', async () => {
      store.set('chapter:b1:0', makeLegacyChapter('b1', 0));
      store.set('chapter:b1:1', makeLegacyChapter('b1', 1));
      const svc2 = recreateService();
      const chs = await svc2.chapterAll('b1'); // await ensureMigrated → 迁移完成
      expect(chs).toHaveLength(2);
      expect(chs.map((c) => c.index)).toEqual([0, 1]);
      // 旧 _id 已 tombstone，新 _id 已写入
      expect(store.has('chapter:b1:0')).toBe(false);
      expect(store.has(`chapter:b1${SEP}0`)).toBe(true);
      // 新 _id 可 get
      const ch = await svc2.chapterGet('b1', 1);
      expect(ch?.title).toBe('legacy ch1');
      // 迁移后不应有重复章节（chapter 前缀范围只有 2 条）
      expect(Array.from(store.keys()).filter((k) => k.startsWith('chapter:b1')).length).toBe(2);
    });

    it('不符合 chapter:{bookId}:{idx} 正则的旧文档应被清理而不迁移', async () => {
      store.set('chapter:weird', {
        _id: 'chapter:weird',
        _rev: '1-w',
        type: 'chapter',
        bookId: 'weird',
        index: 0,
        title: 'orphan',
        content: '',
      });
      const svc2 = recreateService();
      await svc2.chapterAll('b1'); // 触发迁移 await
      expect(store.has('chapter:weird')).toBe(false);
    });

    it('已是新格式的文档不应读取正文或重复迁移', async () => {
      // 新格式 = 新 _id + 正文在独立的 chapter-body 文档（不再内联 content）
      store.set(`chapter:b1${SEP}0`, {
        _id: `chapter:b1${SEP}0`,
        _rev: '1-n',
        type: 'chapter',
        bookId: 'b1',
        index: 0,
        title: 'new fmt',
      });
      bridge.dbRequest.mockClear();
      const svc2 = recreateService();
      const chs = await svc2.chapterAll('b1');
      expect(chs).toHaveLength(1);
      expect(chs[0].title).toBe('new fmt');
      expect(opCalls('allDocs')[0][1]).toEqual([expect.objectContaining({ include_docs: false })]);
      expect(chapterGetCalls()).toHaveLength(0);
      expect(opCalls('bulkDocs')).toHaveLength(0);
      // 没有旧格式候选 → 不发起批量正文请求
      expect(opCalls('allDocs').some((call) => (call[1][0] as { keys?: string[] })?.keys)).toBe(
        false,
      );
    });

    it('旧新格式混合时只读取并迁移旧格式候选', async () => {
      const newId = `chapter:b1${SEP}0`;
      store.set(newId, {
        ...makeChapter('b1', 0),
        _id: newId,
        _rev: '1-new',
        title: 'new fmt',
        content: 'new content',
      });
      store.set('chapter:b1:1', makeLegacyChapter('b1', 1));
      bridge.dbRequest.mockClear();
      const svc2 = recreateService();
      const chs = await svc2.chapterAll('b1');
      expect(chs.map((chapter) => chapter.title)).toEqual(['new fmt', 'legacy ch1']);
      // A2：正文已拆到独立 chapter-body 文档 → chapterAll 只回元数据（content 恒为 ''）
      expect(chs.map((chapter) => chapter.content)).toEqual(['', '']);
      // 旧格式候选一次性批量取正文：一次请求，不逐个 get
      expect(opCalls('allDocs')[1][1]).toEqual([
        expect.objectContaining({ keys: ['chapter:b1:1'], include_docs: true }),
      ]);
      expect(chapterGetCalls()).toHaveLength(0);
      // 旧 _id 迁移（旧文档墓碑 + 新 _id 写入）在一次 bulkDocs 内完成
      expect(opCalls('bulkDocs')[0][1][0]).toEqual([
        expect.objectContaining({ _id: 'chapter:b1:1', _deleted: true }),
        expect.objectContaining({ _id: `chapter:b1${SEP}1` }),
      ]);
      expect(store.has('chapter:b1:1')).toBe(false);
      expect(store.has(`chapter:b1${SEP}1`)).toBe(true);
      // 正文迁移到 chapter-body 文档，内容无损
      expect(store.get(`chapter-body:b1${SEP}0`)?.content).toBe('new content');
      expect(store.get(`chapter-body:b1${SEP}1`)?.content).toBe('legacy content 1');
    });

    it('不含新分隔符的非 chapter 文档不应迁移或删除', async () => {
      const foreignId = 'chapter:b1:legacy';
      store.set(foreignId, {
        _id: foreignId,
        _rev: '1-foreign',
        type: 'book',
        id: 'foreign',
      });
      bridge.dbRequest.mockClear();
      const svc2 = recreateService();
      await expect(svc2.chapterAll('b1')).resolves.toEqual([]);
      // 候选正文照常批量取，但类型不是 chapter → 不迁移、不删除
      expect(opCalls('allDocs')[1][1]).toEqual([
        expect.objectContaining({ keys: [foreignId], include_docs: true }),
      ]);
      expect(chapterGetCalls()).toHaveLength(0);
      expect(opCalls('bulkDocs')).toHaveLength(0);
      expect(store.has(foreignId)).toBe(true);
    });

    it('迁移候选扫描后 404 应跳过并继续迁移后续章节', async () => {
      store.set('chapter:b1:0', makeLegacyChapter('b1', 0));
      store.set('chapter:b1:1', makeLegacyChapter('b1', 1));
      bridge.dbRequest.mockImplementation(async (op: string, args: unknown[]) => {
        const result = await defaultImpl(op, args);
        if (op === 'allDocs') store.delete('chapter:b1:0');
        return result;
      });
      bridge.dbRequest.mockClear();
      const svc2 = recreateService();
      const chapters = await svc2.chapterAll('b1');
      expect(chapters.map((chapter) => chapter.index)).toEqual([1]);
      // 扫描后被删的候选在批量取正文时查不到 → 跳过，后续候选继续迁移
      expect(opCalls('allDocs')[1][1]).toEqual([
        expect.objectContaining({ keys: ['chapter:b1:0', 'chapter:b1:1'] }),
      ]);
      expect(chapterGetCalls()).toHaveLength(0);
      expect(store.has(`chapter:b1${SEP}0`)).toBe(false);
      expect(store.has(`chapter:b1${SEP}1`)).toBe(true);
      expect(store.has('chapter:b1:1')).toBe(false);
      // A2：正文已拆到独立 chapter-body 文档 → 元数据不再内联正文，正文按需取
      expect(chapters[0].content).toBe('');
      expect(await svc2.chapterContent('b1', 1)).toBe('legacy content 1');
    });

    it('迁移候选批量读取的非 404 错误应警告且后续书籍读写可用', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        store.set('chapter:b1:0', makeLegacyChapter('b1', 0));
        bridge.dbRequest.mockImplementation(async (op: string, args: unknown[]) => {
          const opts = (args[0] ?? {}) as { keys?: string[] };
          if (op === 'allDocs' && opts.keys) {
            return { ok: false, error: { status: 500, name: 'io_error', message: 'read fail' } };
          }
          return defaultImpl(op, args);
        });
        const svc2 = recreateService();
        await expect(svc2.chapterAll('b1')).resolves.toEqual([]);
        expect(warn).toHaveBeenCalledWith(
          '[DbService] legacy chapter _id migration failed:',
          expect.objectContaining({ status: 500 }),
        );
        await svc2.bookPut(makeBook({ id: 'b1' }));
        await expect(svc2.bookGet('b1')).resolves.toMatchObject({ id: 'b1' });
      } finally {
        warn.mockRestore();
      }
    });

    it('迁移 bulkDocs 出现非 409 失败应 console.warn 但不中断启动', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        store.set('chapter:b1:0', makeLegacyChapter('b1', 0));
        bridge.dbRequest.mockImplementation(async (op: string, args: unknown[]) => {
          if (op === 'bulkDocs') {
            return {
              ok: true,
              result: [
                { error: true, status: 500, name: 'io_error', message: 'x', id: 'chapter:b1:0' },
              ],
            };
          }
          return defaultImpl(op, args);
        });
        const svc2 = recreateService();
        await svc2.chapterAll('b1'); // 等迁移 promise 结束（不抛）
        expect(warn).toHaveBeenCalledWith(
          '[DbService] legacy chapter migration partial failure:',
          expect.anything(),
        );
      } finally {
        warn.mockRestore();
      }
    });

    it('迁移 allDocs 抛错应捕获并 console.warn，后续读操作不受影响', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        bridge.dbRequest.mockImplementationOnce(async () => ({
          ok: false,
          error: { status: 500, name: 'io_error', message: 'allDocs boom' },
        }));
        const svc2 = recreateService();
        // 迁移失败被 catch；chapterAll 仍正常（空库返回 []）
        await expect(svc2.chapterAll('b1')).resolves.toEqual([]);
        expect(warn).toHaveBeenCalledWith(
          '[DbService] legacy chapter _id migration failed:',
          expect.anything(),
        );
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe('目录/正文分离存储（A2）', () => {
    const bodyId = (bookId: string, idx: number) => `chapter-body:${bookId}${SEP}${idx}`;
    const metaId = (bookId: string, idx: number) => `chapter:${bookId}${SEP}${idx}`;

    it('chapterAll 只返回元数据（不含正文）', async () => {
      await svc.chapterPutMany([makeChapter('b1', 0)]);
      const chs = await svc.chapterAll('b1');
      expect(chs[0].title).toBe('ch1');
      expect(chs[0].content).toBe('');
    });

    it('chapterContent 应从独立正文文档读回；缺失时返回 null', async () => {
      await svc.chapterPutMany([makeChapter('b1', 0)]);
      expect(await svc.chapterContent('b1', 0)).toBe('content 1');
      expect(await svc.chapterContent('b1', 9)).toBeNull();
    });

    it('chapterGet 应合并元数据 + 正文', async () => {
      await svc.chapterPutMany([makeChapter('b1', 0)]);
      const ch = await svc.chapterGet('b1', 0);
      expect(ch?.title).toBe('ch1');
      expect(ch?.content).toBe('content 1');
    });

    it('旧格式（正文内联在元数据文档里）应仍可读', async () => {
      store.set(metaId('b1', 0), {
        _id: metaId('b1', 0),
        _rev: '1-old',
        type: 'chapter',
        bookId: 'b1',
        index: 0,
        title: '旧格式',
        content: '内联正文',
        loaded: true,
      });
      const ch = await svc.chapterGet('b1', 0);
      expect(ch?.content).toBe('内联正文');
    });

    it('正文拆分迁移：内联正文搬到独立文档 + 元数据剥离 content + 写迁移标记', async () => {
      store.set(metaId('b1', 0), {
        _id: metaId('b1', 0),
        _rev: '1-old',
        type: 'chapter',
        bookId: 'b1',
        index: 0,
        title: '待迁移',
        content: '旧正文',
        loaded: true,
      });
      const svc2 = recreateService();
      await svc2.chapterAll('b1'); // 等迁移 promise 结束
      expect(store.get(bodyId('b1', 0))?.content).toBe('旧正文');
      expect(store.get(metaId('b1', 0))?.content).toBeUndefined();
      expect(store.has('meta:migration:chapter-body-v1')).toBe(true);
    });

    it('chapterBodiesClear 应删除正文文档并把 loaded 复位为 false', async () => {
      await svc.chapterPutMany([makeChapter('b1', 0)]);
      await svc.chapterBodiesClear('b1');
      expect(await svc.chapterContent('b1', 0)).toBeNull();
      expect((await svc.chapterAll('b1'))[0].loaded).toBe(false);
    });

    it('bookDelete 应级联删除正文文档', async () => {
      await svc.bookPut(makeBook({ id: 'b1' }));
      await svc.chapterPutMany([makeChapter('b1', 0)]);
      await svc.bookDelete('b1');
      expect(await svc.chapterContent('b1', 0)).toBeNull();
    });

    it('防数据丢失：整书重写目录（loaded=true）不应把已抓取的正文当孤儿删除', async () => {
      await svc.chapterPutMany([makeChapter('b1', 0)]);
      expect(await svc.chapterContent('b1', 0)).toBe('content 1');
      // 「更新章节」路径：目录从 db 读回（正文恒为 ''）后整体重写
      const dir = await svc.chapterAll('b1');
      expect(dir[0].content).toBe('');
      expect(dir[0].loaded).toBe(true);
      await svc.chapterPutMany(dir);
      expect(await svc.chapterContent('b1', 0)).toBe('content 1');
    });

    it('换源场景：新目录 loaded=false 应让旧源正文失效', async () => {
      await svc.chapterPutMany([makeChapter('b1', 0)]);
      await svc.chapterPutMany([
        {
          bookId: 'b1',
          index: 0,
          title: '新源',
          content: '',
          sourceUrl: 'http://new/1',
          loaded: false,
        },
      ]);
      expect(await svc.chapterContent('b1', 0)).toBeNull();
    });
  });

  describe('destroy / seedIfEmpty', () => {
    it('destroy 应清空全部数据', async () => {
      await svc.bookPut(makeBook({ id: 'b1' }));
      await svc.chapterPutMany([makeChapter('b1', 0)]);
      await svc.destroy();
      expect(await svc.bookAll()).toHaveLength(0);
      expect(await svc.chapterAll('b1')).toHaveLength(0);
    });

    it('destroy IPC 失败应抛出', async () => {
      bridge.dbRequest.mockImplementationOnce(async () => ({
        ok: false,
        error: { status: 500, name: 'io_error', message: 'destroy fail' },
      }));
      await expect(svc.destroy()).rejects.toMatchObject({ status: 500 });
    });

    it('seedIfEmpty 应为 no-op 并返回 seeded:false', async () => {
      await expect(svc.seedIfEmpty()).resolves.toEqual({ seeded: false, bookCount: 0 });
    });
  });
});
/**
 * 浏览器后端动态加载（独立 describe）。
 *
 * ⚠️ 这里刻意**不**用 vi.doMock('pouchdb-browser') + vi.resetModules()：
 * 动态 import 的模块拦截依赖 Vite 依赖预打包状态，而预打包缓存是否命中取决于
 * vitest 的 worker 调度 —— 同一份代码在不同调度下会随机出现「mock 未生效、
 * 真实 pouchdb-browser 被实例化」（表现为 'Invalid Adapter: undefined'），
 * 且失败点随代码量变化而漂移，无法稳定复现。
 *
 * 改为直接构造 BrowserPouchBackend 并注入受控 loader：
 * 断言落在真正的被测单元上，完全不依赖模块拦截与 worker 调度；
 * DbService 层的后端接线由 createBackend() 的实例断言覆盖。
 */
describe('DbService 浏览器后端动态加载', () => {
  afterEach(() => {
    delete (globalThis as any).window;
  });

  /** 浏览器后端的 loader 类型（取构造签名，避免引用未导出的文档联合类型） */
  type BrowserLoader = ConstructorParameters<typeof BrowserPouchBackend>[0];

  /** 记录构造次数与库名的假数据库 */
  function fakeDb(ctor: (name: string) => void) {
    class FakePouch {
      constructor(name: string) {
        ctor(name);
      }
      allDocs = vi.fn(async () => ({ rows: [] }));
      get = vi.fn(async () => ({}));
      put = vi.fn(async () => ({ ok: true, id: 'x', rev: '1-x' }));
      bulkDocs = vi.fn(async () => []);
      destroy = vi.fn(async () => {});
    }
    return new FakePouch('pomreader') as unknown as Awaited<ReturnType<BrowserLoader>>;
  }

  it('Electron 环境应走 IPC 后端，不触发 pouchdb-browser 动态加载', () => {
    (globalThis as any).window = {
      pomAPI: { dbRequest: vi.fn(async () => ({ ok: true, result: { rows: [] } })) },
    };
    expect(createBackend()).not.toBeInstanceOf(BrowserPouchBackend);
  });

  it('非 Electron 环境应走浏览器后端', () => {
    (globalThis as any).window = {};
    expect(createBackend()).toBeInstanceOf(BrowserPouchBackend);
  });

  it('浏览器后端并发首次调用只构造一个数据库实例', async () => {
    const ctor = vi.fn();
    const backend = new BrowserPouchBackend(async () => fakeDb(ctor));
    await Promise.all([backend.allDocs({}), backend.allDocs({}), backend.allDocs({})]);

    expect(ctor).toHaveBeenCalledTimes(1);
    expect(ctor).toHaveBeenCalledWith('pomreader');
  });

  it('浏览器后端 destroy 后应丢弃已销毁实例并重新打开', async () => {
    const ctor = vi.fn();
    const backend = new BrowserPouchBackend(async () => fakeDb(ctor));
    await backend.allDocs({});
    expect(ctor).toHaveBeenCalledTimes(1);

    // 销毁后的实例不可复用：后端须丢弃缓存，下次调用重新打开同名空库
    await backend.destroy();
    await backend.allDocs({});
    expect(ctor).toHaveBeenCalledTimes(2);
    expect(ctor).toHaveBeenLastCalledWith('pomreader');
  });

  it('浏览器后端模块加载失败应沿 Promise 链传播', async () => {
    const backend = new BrowserPouchBackend(() => Promise.reject(new Error('pouchdb load failed')));
    const error = await backend.allDocs({}).then(
      () => null,
      (e: unknown) => e,
    );
    const chain: string[] = [];
    let current: unknown = error;
    while (current && chain.length < 5) {
      chain.push(current instanceof Error ? current.message : String(current));
      current = current instanceof Error ? (current as { cause?: unknown }).cause : undefined;
    }
    expect(chain.join(' | ')).toContain('pouchdb load failed');
  });

  it('浏览器后端构造失败后应允许下次调用重试', async () => {
    // 用「是否失败」开关而非「第 N 次构造失败」计数：
    // 构造次数会随调用方时序漂移，计数式写法会随之失配；
    // 开关式写法只验证「失败可重试」语义。
    let shouldFail = true;
    let attempts = 0;
    const backend = new BrowserPouchBackend(async () => {
      attempts += 1;
      if (shouldFail) throw new Error('pouchdb construct failed');
      return fakeDb(() => {});
    });

    await expect(backend.allDocs({})).rejects.toThrow('pouchdb construct failed');
    const attemptsAfterFirst = attempts;
    // 失败后缓存被清空：再次调用会重新加载（本例仍失败）
    await expect(backend.allDocs({})).rejects.toThrow('pouchdb construct failed');
    // 确实重新构造了（而不是复用同一个被拒的 promise）
    expect(attempts).toBeGreaterThan(attemptsAfterFirst);
    // 恢复后重试成功，证明失败不会毒化整个会话
    shouldFail = false;
    await expect(backend.allDocs({})).resolves.toEqual({ rows: [] });
  });

  it('数据库不可用时启动迁移失败应告警但不中断启动', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      (globalThis as any).window = {
        pomAPI: {
          dbRequest: vi.fn(async () => ({
            ok: false,
            error: { status: 500, name: 'io_error', message: 'disk full' },
          })),
        },
      };
      vi.resetModules();

      const { DbService: FreshDbService } = await import('./db.service');
      const svc = new FreshDbService();

      // 迁移失败只告警、不抛出未捕获异常（DB 全挂时读操作同样失败，但不应崩掉启动）
      await svc.chapterAll('b1').catch(() => null);
      expect(warn).toHaveBeenCalledWith(
        '[DbService] legacy chapter _id migration failed:',
        expect.anything(),
      );
    } finally {
      warn.mockRestore();
    }
  });
});
