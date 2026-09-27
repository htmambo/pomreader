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
 * chapterPutMany / seedIfEmpty / bookUpdateProgress
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = any;

describe('DbService', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let store: Map<string, Doc>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let bridge: any;
  let svc: DbService;

  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserDynamicTestingModule, platformBrowserDynamicTesting());
  });

  beforeEach(() => {
    store = new Map<string, Doc>();
    // IPC 协议（IpcPouchBackend 期望）：{ ok, result?, error? }
    // ok=false 时 IpcPouchBackend 抛 res.error；
    // 404 get 等也是 ok=false + error={status:404}（isNotFound 判定依据）
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ok = (result: any) => ({ ok: true, result });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fail = (status: number, name: string, message: string) => ({
      ok: false,
      error: { status, name, message },
    });

    bridge = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      dbRequest: vi.fn(async (op: string, args: unknown[]) => {
        switch (op) {
          case 'allDocs': {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const id = args[0] as string;
            const doc = store.get(id);
            if (!doc) return fail(404, 'not_found', 'missing');
            return ok(doc);
          }
          case 'put': {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const doc = args[0] as Doc;
            if (doc._deleted) {
              store.delete(doc._id);
            } else {
              store.set(doc._id, doc);
            }
            return ok({ ok: true, id: doc._id, rev: '1-fake' });
          }
          case 'bulkDocs': {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const docs = args[0] as Doc[];
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
      }),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).window = { pomAPI: bridge };

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [DbService],
    });
    svc = TestBed.inject(DbService);
  });

  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
});