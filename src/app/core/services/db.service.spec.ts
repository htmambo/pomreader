import { describe, it, expect, beforeEach, vi, beforeAll } from 'vitest';
import 'zone.js';
import { TestBed } from '@angular/core/testing';
import {
  BrowserDynamicTestingModule,
  platformBrowserDynamicTesting,
} from '@angular/platform-browser-dynamic/testing';
import { DbService } from './db.service';
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

  beforeEach(() => {
    store = new Map<string, Doc>();
    // IPC 协议（IpcPouchBackend 期望）：{ ok, result?, error? }
    // ok=false 时 IpcPouchBackend 抛 res.error；
    // 404 get 等也是 ok=false + error={status:404}（isNotFound 判定依据）

    const ok = (result: any) => ({ ok: true, result });

    const fail = (status: number, name: string, message: string) => ({
      ok: false,
      error: { status, name, message },
    });

    defaultImpl = async (op: string, args: unknown[]) => {
      switch (op) {
        case 'allDocs': {
          const opts = args[0] as { include_docs?: boolean; startkey?: string; endkey?: string };
          const docs = Array.from(store.values()).filter((d) => {
            if (opts.startkey && d._id < opts.startkey) return false;
            if (opts.endkey && d._id >= opts.endkey) return false;
            return true;
          });
          return ok({
            rows: docs.map((doc) => ({ id: doc._id, key: doc._id, doc })),
          });
        }
        case 'get': {
          const id = args[0] as string;
          const doc = store.get(id);
          if (!doc) return fail(404, 'not_found', 'missing');
          return ok(doc);
        }
        case 'put': {
          const doc = args[0] as Doc;
          if (doc._deleted) {
            store.delete(doc._id);
          } else {
            store.set(doc._id, doc);
          }
          return ok({ ok: true, id: doc._id, rev: '1-fake' });
        }
        case 'bulkDocs': {
          const docs = args[0] as Doc[];

          const results: any[] = docs.map((d) => {
            if (d._deleted) {
              store.delete(d._id);
            } else {
              store.set(d._id, d);
            }
            return { ok: true, id: d._id };
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
      bridge.dbRequest.mockImplementation(async (op: string, args: unknown[]) => {
        if (op === 'put') {
          putSeen++;
          if (putSeen === 1) {
            return { ok: false, error: { status: 409, name: 'conflict', message: 'race' } };
          }
        }
        return defaultImpl(op, args);
      });
      await svc.chapterPut({ bookId: 'b1', index: 0, title: 'ch1', content: 'c', loaded: true });
      expect((await svc.chapterGet('b1', 0))?.title).toBe('ch1');
      expect(putSeen).toBe(2);
    });
  });

  describe('chapterPutMany 孤儿清理与批量错误', () => {
    it('新集合小于旧集合时孤儿章节应被删除（换源场景）', async () => {
      await svc.chapterPutMany([makeChapter('b1', 0), makeChapter('b1', 1), makeChapter('b1', 2)]);
      // 换源：新源只有 1 章 → 旧 idx 1/2 成为孤儿
      await svc.chapterPutMany([makeChapter('b1', 0)]);
      const chs = await svc.chapterAll('b1');
      expect(chs).toHaveLength(1);
      expect(chs[0].index).toBe(0);
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
        // 第二次写入：1 个新章 + 1 个孤儿删除；bulkDocs 返回新章 ok + 孤儿 409
        bridge.dbRequest.mockImplementation(async (op: string, args: unknown[]) => {
          if (op === 'bulkDocs') {
            return {
              ok: true,
              result: [
                { ok: true, id: `chapter:b1${SEP}0` },
                {
                  error: true,
                  status: 409,
                  name: 'conflict',
                  message: 'x',
                  id: `chapter:b1${SEP}1`,
                },
              ],
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
      store.set('book:intruder', { _id: 'book:intruder', type: 'chapter', bookId: 'x' });
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
      store.set(`chapter:b1${SEP}9`, { _id: `chapter:b1${SEP}9`, type: 'book', id: 'ghost' });
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

    it('已是新格式的文档不应被重复迁移（无 bulkDocs 调用）', async () => {
      store.set(`chapter:b1${SEP}0`, {
        _id: `chapter:b1${SEP}0`,
        _rev: '1-n',
        type: 'chapter',
        bookId: 'b1',
        index: 0,
        title: 'new fmt',
        content: 'c',
      });
      const svc2 = recreateService();
      const chs = await svc2.chapterAll('b1');
      expect(chs).toHaveLength(1);
      expect(chs[0].title).toBe('new fmt');
      expect(opCalls('bulkDocs')).toHaveLength(0); // oldDocs 为空 → 提前返回
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
