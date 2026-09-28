import { describe, it, expect, beforeAll } from 'vitest';

/**
 * sandbox.worker.ts 直接导入测试（jsdom 无真实 Worker，mock self/postMessage 驱动消息循环）
 *
 * 注意：被测模块启动段会把 fetch/XMLHttpRequest 等 10 个全局 defineProperty 成
 * configurable:false 并冻结 Object/Array/Function 原型。若直接作用在 jsdom window 上，
 * vitest 环境 teardown 删除全局时会抛 TypeError（不可配置属性不可删）。
 * 因此 import 前把全局 self 换成普通对象 fakeSelf —— 硬化全部落在 fakeSelf 上；
 * 原型冻结仍在 realm 内，但不阻塞 teardown 的全局删除（forks pool 本文件独立子进程）。
 * 模块只 import 一次（模块注册表缓存），全部用例共享同一份硬化后状态。
 */

type WorkerListener = (e: { data: unknown }) => void;

const outbound: Array<Record<string, unknown>> = [];
const listeners: WorkerListener[] = [];
const fakeSelf = {
  addEventListener: (_type: string, cb: WorkerListener) => listeners.push(cb),
  postMessage: (m: unknown) => {
    outbound.push(m as Record<string, unknown>);
  },
  // 阶段 1/4 要 delete 的敏感全局（普通可配置属性，delete 必然成功）
  window: {},
  document: {},
  localStorage: {},
  parent: {},
  top: {},
  // 阶段 3/4 navigator Proxy 的包装目标
  navigator: { userAgent: 'fake-worker' },
};

beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  const desc = Object.getOwnPropertyDescriptor(g, 'self');
  if (desc?.configurable) {
    Object.defineProperty(g, 'self', { value: fakeSelf, configurable: true, writable: true });
  } else {
    // self 不可配置但可写（jsdom）→ 直接赋值覆盖
    g['self'] = fakeSelf;
  }
  await import('./sandbox.worker');
});

const send = (data: unknown) => listeners.forEach((cb) => cb({ data }));
const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const lastOfType = (t: string) => [...outbound].reverse().find((m) => m['type'] === t);

describe('sandbox.worker — 启动段', () => {
  it('硬化阶段完成后主动 postMessage worker-ready', () => {
    expect(outbound.some((m) => m['type'] === 'worker-ready')).toBe(true);
  });
  it('硬化阶段有 worker-log 进度上报', () => {
    expect(outbound.some((m) => m['type'] === 'worker-log')).toBe(true);
  });
});

describe('sandbox.worker — load / call 协议', () => {
  it('load 合法源码 → loaded 回执带函数表', () => {
    send({
      type: 'load',
      fileName: 'm1',
      source: 'function search(){ return 1; } function bookInfo(){ return 2; }',
    });
    const msg = lastOfType('loaded');
    expect(msg?.['fileName']).toBe('m1');
    expect(msg?.['fns']).toEqual(expect.arrayContaining(['search', 'bookInfo']));
    expect(msg?.['error']).toBeUndefined();
  });
  it('load 语法错误源码 → loaded 回执带 error（不吞编译错误）', () => {
    send({ type: 'load', fileName: 'bad-src', source: 'function search({' });
    const msg = lastOfType('loaded');
    expect(msg?.['fileName']).toBe('bad-src');
    expect(msg?.['fns']).toEqual([]);
    expect(String(msg?.['error'])).toMatch(/Unexpected/);
  });
  it('call 未加载模块 → result ok:false 「模块未加载」', async () => {
    send({ type: 'call', reqId: 'c1', fileName: 'ghost', fn: 'search', args: [] });
    await tick();
    expect(lastOfType('result')).toMatchObject({ reqId: 'c1', ok: false, error: '模块未加载' });
  });
  it('call 模块中未定义的函数 → result ok:false 「函数 toc 未定义」', async () => {
    send({ type: 'call', reqId: 'c2', fileName: 'm1', fn: 'toc', args: [] });
    await tick();
    expect(lastOfType('result')).toMatchObject({
      reqId: 'c2',
      ok: false,
      error: '函数 toc 未定义',
    });
  });
  it('call 同步函数成功 → result ok:true 带返回值', async () => {
    send({ type: 'call', reqId: 'c3', fileName: 'm1', fn: 'search', args: [] });
    await tick();
    expect(lastOfType('result')).toMatchObject({ reqId: 'c3', ok: true, value: 1 });
  });
  it('call 返回 undefined → value 归一化为 null', async () => {
    send({ type: 'load', fileName: 'm-undef', source: 'function content(){ return undefined; }' });
    send({ type: 'call', reqId: 'c4', fileName: 'm-undef', fn: 'content', args: [] });
    await tick();
    expect(lastOfType('result')).toMatchObject({ reqId: 'c4', ok: true, value: null });
  });
  it('call async 函数 → 等 promise 后回 result', async () => {
    send({
      type: 'load',
      fileName: 'm-async',
      source: 'async function search(){ return "a-ok"; }',
    });
    send({ type: 'call', reqId: 'c5', fileName: 'm-async', fn: 'search', args: [] });
    await tick();
    expect(lastOfType('result')).toMatchObject({ reqId: 'c5', ok: true, value: 'a-ok' });
  });
  it('call 抛错函数 → result ok:false 保留 errorName + stack', async () => {
    send({
      type: 'load',
      fileName: 'm-throw',
      source: 'function search(){ throw new TypeError("boom"); }',
    });
    send({ type: 'call', reqId: 'c6', fileName: 'm-throw', fn: 'search', args: [] });
    await tick();
    const msg = lastOfType('result');
    expect(msg?.['reqId']).toBe('c6');
    expect(msg?.['ok']).toBe(false);
    expect(msg?.['errorName']).toBe('TypeError');
    expect(String(msg?.['error'])).toContain('boom');
  });
  it('invalidate 后 call → 模块未加载', async () => {
    send({ type: 'invalidate', fileName: 'm1' });
    send({ type: 'call', reqId: 'c7', fileName: 'm1', fn: 'search', args: [] });
    await tick();
    expect(lastOfType('result')).toMatchObject({ reqId: 'c7', ok: false, error: '模块未加载' });
  });
  it('非预期消息（data=null）→ worker-log error，不回 result', () => {
    const before = outbound.length;
    send(null);
    const fresh = outbound.slice(before);
    expect(fresh.some((m) => m['type'] === 'worker-log' && m['level'] === 'error')).toBe(true);
    expect(fresh.some((m) => m['type'] === 'result')).toBe(false);
  });
});

describe('sandbox.worker — legado.http 桥接', () => {
  it('legado.http.get → 出站 http 消息；http-result 2xx → fn 拿到 body', async () => {
    send({
      type: 'load',
      fileName: 'm-http',
      source: 'async function search(){ return await legado.http.get("https://x.test/a"); }',
    });
    send({ type: 'call', reqId: 'h1', fileName: 'm-http', fn: 'search', args: [] });
    await tick();
    const httpReq = lastOfType('http');
    expect(httpReq?.['request']).toMatchObject({ url: 'https://x.test/a', method: 'GET' });
    send({
      type: 'http-result',
      reqId: httpReq?.['reqId'],
      status: 200,
      headers: {},
      body: 'BODY',
    });
    await tick();
    expect(lastOfType('result')).toMatchObject({ reqId: 'h1', ok: true, value: 'BODY' });
  });
  it('http-result 非 2xx → fn reject 「HTTP <status>」', async () => {
    send({ type: 'call', reqId: 'h2', fileName: 'm-http', fn: 'search', args: [] });
    await tick();
    const httpReq = lastOfType('http');
    send({ type: 'http-result', reqId: httpReq?.['reqId'], status: 500, headers: {}, body: '' });
    await tick();
    const msg = lastOfType('result');
    expect(msg?.['reqId']).toBe('h2');
    expect(msg?.['ok']).toBe(false);
    expect(String(msg?.['error'])).toContain('HTTP 500');
  });
  it('http-result 未知 reqId → 静默忽略', () => {
    const before = outbound.length;
    send({ type: 'http-result', reqId: 'ghost', status: 200, headers: {}, body: '' });
    expect(outbound.slice(before).some((m) => m['type'] === 'result')).toBe(false);
  });
});

describe('sandbox.worker — legado.query 桥接', () => {
  it('legado.query → 出站 query 消息；query-result ok → fn 拿到 items', async () => {
    send({
      type: 'load',
      fileName: 'm-query',
      source:
        'async function search(){ return await legado.query("<a>t</a>", "a", "https://b/"); }',
    });
    send({ type: 'call', reqId: 'q1', fileName: 'm-query', fn: 'search', args: [] });
    await tick();
    const queryReq = lastOfType('query');
    expect(queryReq).toMatchObject({ html: '<a>t</a>', selector: 'a', baseUrl: 'https://b/' });
    send({ type: 'query-result', reqId: queryReq?.['reqId'], ok: true, items: [{ tag: 'a' }] });
    await tick();
    expect(lastOfType('result')).toMatchObject({ reqId: 'q1', ok: true, value: [{ tag: 'a' }] });
  });
  it('query-result ok:false → fn reject 带选择器错误', async () => {
    send({ type: 'call', reqId: 'q2', fileName: 'm-query', fn: 'search', args: [] });
    await tick();
    const queryReq = lastOfType('query');
    send({ type: 'query-result', reqId: queryReq?.['reqId'], ok: false, error: '选择器为空' });
    await tick();
    const msg = lastOfType('result');
    expect(msg?.['reqId']).toBe('q2');
    expect(msg?.['ok']).toBe(false);
    expect(String(msg?.['error'])).toContain('选择器为空');
  });
  it('query-result 未知 reqId → 静默忽略', () => {
    const before = outbound.length;
    send({ type: 'query-result', reqId: 'ghost', ok: true, items: [] });
    expect(outbound.slice(before).some((m) => m['type'] === 'result')).toBe(false);
  });
});
