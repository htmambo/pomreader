import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import 'zone.js';
import { TestBed } from '@angular/core/testing';
import {
  BrowserDynamicTestingModule,
  platformBrowserDynamicTesting,
} from '@angular/platform-browser-dynamic/testing';
import { signal } from '@angular/core';
import { BookshelfGroupService } from './bookshelf-group.service';
import { DbService } from './db.service';
import { BookService } from './book.service';
import { type BookshelfGroup } from '../models/bookshelf-group.model';
import { type Book } from '../models/book.model';

/**
 * BookshelfGroupService spec — 书架分类 CRUD + 删除时的级联解绑
 *
 * 注入两个 fake：
 * - DbService：记录 groupPut / groupDelete 调用，groupAll 返回预置数据
 * - BookService：books() 返回预置书籍，updateBookGroups 记录入参
 */

function book(id: string, groupIds?: string[]): Book {
  return {
    id,
    title: id,
    author: 'a',
    chapterCount: 1,
    totalChars: 1,
    importedAt: '2026-01-01T00:00:00.000Z',
    source: 'local-txt',
    groupIds,
  };
}

const G1: BookshelfGroup = { id: 'g1', name: '经典武侠', createdAt: '2026-01-01T00:00:00.000Z' };
const G2: BookshelfGroup = { id: 'g2', name: '架空穿越', createdAt: '2026-01-02T00:00:00.000Z' };

describe('BookshelfGroupService', () => {
  let svc: BookshelfGroupService;
  let dbMock: {
    groupAll: ReturnType<typeof vi.fn>;
    groupPut: ReturnType<typeof vi.fn>;
    groupDelete: ReturnType<typeof vi.fn>;
  };
  let bookMock: { books: ReturnType<typeof signal>; updateBookGroups: ReturnType<typeof vi.fn> };

  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserDynamicTestingModule, platformBrowserDynamicTesting());
  });

  beforeEach(() => {
    dbMock = {
      groupAll: vi.fn().mockResolvedValue([G1, G2]),
      groupPut: vi.fn().mockResolvedValue(undefined),
      groupDelete: vi.fn().mockResolvedValue(undefined),
    };
    bookMock = {
      books: signal<Book[]>([book('a', ['g1', 'g2']), book('b', ['g2']), book('c')]),
      updateBookGroups: vi.fn().mockResolvedValue(undefined),
    };
    TestBed.configureTestingModule({
      providers: [
        BookshelfGroupService,
        { provide: DbService, useValue: dbMock },
        { provide: BookService, useValue: bookMock },
      ],
    });
    svc = TestBed.inject(BookshelfGroupService);
  });

  it('load 后 groups 按 db 顺序填充，groupIds 派生同步', async () => {
    await svc.load();
    expect(svc.groups().map((g) => g.id)).toEqual(['g1', 'g2']);
    expect(svc.groupIds()).toEqual(['g1', 'g2']);
  });

  it('load 只生效一次（重复调用不再打 db）', async () => {
    await svc.load();
    await svc.load();
    expect(dbMock.groupAll).toHaveBeenCalledTimes(1);
  });

  it('load 失败后允许重试', async () => {
    dbMock.groupAll.mockRejectedValueOnce(new Error('boom'));
    await expect(svc.load()).rejects.toThrow('boom');
    dbMock.groupAll.mockResolvedValue([G1]);
    await svc.load();
    expect(svc.groups()).toEqual([G1]);
  });

  it('create 落库并追加到 signal', async () => {
    await svc.load();
    const created = await svc.create('科幻');
    expect(dbMock.groupPut).toHaveBeenCalledWith(created);
    expect(svc.groups().map((g) => g.name)).toEqual(['经典武侠', '架空穿越', '科幻']);
  });

  it('create 拒绝空名 / 重名 / 超长名', async () => {
    await svc.load();
    await expect(svc.create('  ')).rejects.toThrow('分类名不能为空');
    await expect(svc.create('经典武侠')).rejects.toThrow('已存在同名分类');
    await expect(svc.create('书'.repeat(13))).rejects.toThrow(/不能超过 12/);
    expect(dbMock.groupPut).not.toHaveBeenCalled();
  });

  it('rename 更新 signal 且保留 createdAt', async () => {
    await svc.load();
    await svc.rename('g1', ' 武侠经典 ');
    expect(svc.groups()[0]).toEqual({ ...G1, name: '武侠经典' });
    expect(dbMock.groupPut).toHaveBeenCalledWith({ ...G1, name: '武侠经典' });
  });

  it('rename 同名（去空白后一致）不写库', async () => {
    await svc.load();
    await svc.rename('g1', ' 经典武侠 ');
    expect(dbMock.groupPut).not.toHaveBeenCalled();
  });

  it('rename 未知 id 抛错', async () => {
    await svc.load();
    await expect(svc.rename('nope', 'x')).rejects.toThrow('分类不存在');
  });

  it('remove 删除文档 + 级联从书籍摘掉该分类，并返回解绑数', async () => {
    await svc.load();
    const affected = await svc.remove('g2');
    expect(dbMock.groupDelete).toHaveBeenCalledWith('g2');
    // a（g1,g2）→ 只剩 g1；b（g2）→ 空数组；c 无归属不参与
    expect(bookMock.updateBookGroups).toHaveBeenCalledTimes(2);
    expect(bookMock.updateBookGroups).toHaveBeenNthCalledWith(1, 'a', ['g1']);
    expect(bookMock.updateBookGroups).toHaveBeenNthCalledWith(2, 'b', []);
    expect(affected).toBe(2);
    expect(svc.groups().map((g) => g.id)).toEqual(['g1']);
  });

  it('remove 无人归属的分类时不触发任何书籍写入', async () => {
    await svc.load();
    const empty = await svc.create('科幻'); // 还没有书归入
    expect(await svc.remove(empty.id)).toBe(0);
    expect(bookMock.updateBookGroups).not.toHaveBeenCalled();
    expect(svc.groups().map((g) => g.id)).toEqual(['g1', 'g2']);
  });
});
