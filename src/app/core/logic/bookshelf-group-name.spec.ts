import { describe, it, expect } from 'vitest';
import { newGroupId, validateGroupName } from './bookshelf-group-name';
import { type BookshelfGroup } from '../models/bookshelf-group.model';

const EXISTING: BookshelfGroup[] = [
  { id: 'g1', name: '经典武侠', createdAt: '2026-01-01T00:00:00.000Z' },
  { id: 'g2', name: '架空穿越', createdAt: '2026-01-02T00:00:00.000Z' },
];

describe('validateGroupName', () => {
  it('合法名返回去空白后的 name', () => {
    expect(validateGroupName('  科幻  ', EXISTING)).toEqual({ ok: true, name: '科幻' });
  });

  it('空 / 纯空白 → 拒绝', () => {
    expect(validateGroupName('', EXISTING)).toEqual({ ok: false, reason: '分类名不能为空' });
    expect(validateGroupName('   ', EXISTING).ok).toBe(false);
  });

  it('超过 12 字 → 拒绝（中文按字计）', () => {
    expect(validateGroupName('书'.repeat(13), EXISTING).ok).toBe(false);
    expect(validateGroupName('书'.repeat(12), EXISTING).ok).toBe(true);
  });

  it('与既有分类重名 → 拒绝', () => {
    expect(validateGroupName('经典武侠', EXISTING)).toEqual({
      ok: false,
      reason: '已存在同名分类「经典武侠」',
    });
  });

  it('重名判定忽略大小写与空白', () => {
    const en: BookshelfGroup[] = [{ id: 'g3', name: 'SciFi', createdAt: 'x' }];
    expect(validateGroupName(' scifi ', en).ok).toBe(false);
  });

  it('改名自身不算重名（传 selfId）', () => {
    expect(validateGroupName('经典武侠 新', EXISTING, 'g1')).toEqual({
      ok: true,
      name: '经典武侠 新',
    });
  });
});

describe('newGroupId', () => {
  it('每次生成不同 id', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newGroupId()));
    expect(ids.size).toBe(50);
  });

  it('id 非空', () => {
    expect(newGroupId().length).toBeGreaterThan(0);
  });
});
