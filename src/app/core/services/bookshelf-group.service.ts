import { Injectable, computed, inject, signal, type Signal } from '@angular/core';

import { DbService } from './db.service';
import { BookService } from './book.service';
import { type BookshelfGroup } from '../models/bookshelf-group.model';
import { newGroupId, validateGroupName } from '../logic/bookshelf-group-name';

/**
 * BookshelfGroupService — 书架分类（legado 分组语义）
 *
 * 数据落点：PouchDB `group:{id}` 文档（DbService.groupAll / groupPut / groupDelete）；
 * 书籍归属走 Book.groupIds（多分类），由 BookService.updateBookGroups 落盘。
 *
 * 状态：`_groups` signal 为分类唯一真相源，书架页与弹窗都读它；
 * 写操作先落库再更新 signal（不做乐观更新——分类数据量小，串行写更简单且不会回滚）。
 */
@Injectable({ providedIn: 'root' })
export class BookshelfGroupService {
  private readonly db = inject(DbService);
  private readonly bookService = inject(BookService);

  private readonly _groups = signal<BookshelfGroup[]>([]);
  readonly groups: Signal<BookshelfGroup[]> = this._groups.asReadonly();
  /** 分类 id 列表（countByGroup 的入参，避免每次调用重新 map） */
  readonly groupIds: Signal<string[]> = computed(() => this._groups().map((g) => g.id));

  private loadState: 'idle' | 'loading' | 'ready' = 'idle';

  /** 一次性加载分类（书架页 ngOnInit 调用；重复调用直接返回） */
  async load(): Promise<void> {
    if (this.loadState === 'loading' || this.loadState === 'ready') return;
    this.loadState = 'loading';
    try {
      this._groups.set(await this.db.groupAll());
      this.loadState = 'ready';
    } catch (e) {
      this.loadState = 'idle'; // 允许下次重试
      throw e;
    }
  }

  /** 新建分类；重名 / 空名 / 超长抛 Error（弹窗先校验，这里兜底） */
  async create(rawName: string): Promise<BookshelfGroup> {
    const check = validateGroupName(rawName, this._groups());
    if (!check.ok) throw new Error(check.reason);
    const group: BookshelfGroup = {
      id: newGroupId(),
      name: check.name,
      createdAt: new Date().toISOString(),
    };
    await this.db.groupPut(group);
    this._groups.update((list) => [...list, group]);
    return group;
  }

  /** 重命名分类；非法名抛 Error */
  async rename(id: string, rawName: string): Promise<void> {
    const current = this._groups().find((g) => g.id === id);
    if (!current) throw new Error('分类不存在');
    const check = validateGroupName(rawName, this._groups(), id);
    if (!check.ok) throw new Error(check.reason);
    if (check.name === current.name) return;
    const next = { ...current, name: check.name };
    await this.db.groupPut(next);
    this._groups.update((list) => list.map((g) => (g.id === id ? next : g)));
  }

  /**
   * 删除分类 + 级联解绑书籍（把各书 groupIds 里的该 id 摘掉）。
   * 返回被解绑的书本数，供调用方 toast 汇报。
   */
  async remove(id: string): Promise<number> {
    await this.db.groupDelete(id);
    const affected = this.bookService.books().filter((b) => (b.groupIds ?? []).includes(id));
    for (const book of affected) {
      await this.bookService.updateBookGroups(
        book.id,
        (book.groupIds ?? []).filter((g) => g !== id),
      );
    }
    this._groups.update((list) => list.filter((g) => g.id !== id));
    return affected.length;
  }
}
