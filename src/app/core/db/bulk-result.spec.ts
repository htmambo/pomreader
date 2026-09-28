import { describe, expect, it } from 'vitest';
import { classifyBulkResults, formatBulkFatalMessage } from './bulk-result';

/** 模拟 PouchDB bulkDocs 返回：union 类型不便构造，用 Record 模拟 */
function ok(id = 'doc:1') {
  return { id, rev: '1-abc', ok: true } as unknown as { id: string; rev: string; ok: true };
}
function err(id: string, status: number, name = 'error') {
  return {
    id,
    error: true,
    status,
    name,
    message: `mock ${name}`,
  } as unknown as { id: string; error: true; status: number; name: string; message: string };
}

describe('classifyBulkResults', () => {
  it('全部成功时 succeeded = total，其它为空', () => {
    const r = classifyBulkResults([ok(), ok('doc:2')]);
    expect(r.succeeded).toBe(2);
    expect(r.fatal).toEqual([]);
    expect(r.conflicts).toEqual([]);
    expect(r.total).toBe(2);
  });

  it('默认行为：409 视为幂等成功，不入 conflicts/fatal', () => {
    const r = classifyBulkResults([ok(), err('doc:2', 409)]);
    expect(r.succeeded).toBe(1);
    expect(r.conflicts).toEqual([]);
    expect(r.fatal).toEqual([]);
  });

  it('conflictAsConflict=true：409 归入 conflicts（caller 自行处理）', () => {
    const r = classifyBulkResults([err('doc:1', 409)], { conflictAsConflict: true });
    expect(r.conflicts).toHaveLength(1);
    expect(r.fatal).toEqual([]);
    expect(r.succeeded).toBe(0);
  });

  it('非 409 错误归入 fatal', () => {
    const r = classifyBulkResults([err('doc:1', 500, 'internal')]);
    expect(r.fatal).toHaveLength(1);
    expect(r.fatal[0]).toMatchObject({ id: 'doc:1', status: 500, name: 'internal' });
    expect(r.succeeded).toBe(0);
  });

  it('混合：成功 + 409（默认归成功）+ 500（fatal）', () => {
    const r = classifyBulkResults([ok(), err('doc:2', 409), err('doc:3', 500, 'oops')]);
    // succeeded 只数 ok response；409 默认归「幂等成功」不入 succeeded；500 fatal
    expect(r.succeeded).toBe(1);
    expect(r.fatal).toHaveLength(1);
    expect(r.conflicts).toEqual([]);
    expect(r.total).toBe(3);
  });

  it('空数组返回零计数', () => {
    const r = classifyBulkResults([]);
    expect(r.total).toBe(0);
    expect(r.succeeded).toBe(0);
    expect(r.fatal).toEqual([]);
    expect(r.conflicts).toEqual([]);
  });
});

describe('formatBulkFatalMessage', () => {
  it('格式化 fatal 详情', () => {
    const classified = classifyBulkResults([err('doc:1', 500, 'oops'), ok()]);
    const msg = formatBulkFatalMessage('bulkPut', classified);
    expect(msg).toContain('bulkPut failed');
    expect(msg).toContain('1/2');
    expect(msg).toContain('doc:1');
    expect(msg).toContain('oops');
  });

  it('无 fatal 时格式化结果不包含 "failed"', () => {
    const classified = classifyBulkResults([ok(), ok()]);
    const msg = formatBulkFatalMessage('op', classified);
    expect(msg).toContain('0/2');
  });
});
