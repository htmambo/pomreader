/**
 * 运行时开关单测（书源 JSON 规则化 P1.7）
 *
 * 重点测 `resolveEngineMode` 的**过渡期兜底**：默认 'rule' 而 P2 之前一个 JSON 源都没有，
 * 这时若机械地"选了 rule 就不装 JS"，用户升级后所有书源会凭空消失。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  BOOK_SOURCE_ENGINE_KEY,
  DEFAULT_BOOK_SOURCE_ENGINE,
  readBookSourceEngine,
  resolveEngineMode,
  writeBookSourceEngine,
  type BookSourceEngine,
} from './feature-flag';

beforeEach(() => localStorage.removeItem(BOOK_SOURCE_ENGINE_KEY));
afterEach(() => localStorage.removeItem(BOOK_SOURCE_ENGINE_KEY));

describe('读写运行时开关', () => {
  it('未设置 → 缺省 rule', () => {
    expect(readBookSourceEngine()).toBe('rule');
    expect(DEFAULT_BOOK_SOURCE_ENGINE).toBe('rule');
  });

  it('写入后读回一致（三个值）', () => {
    for (const v of ['rule', 'js', 'both'] as BookSourceEngine[]) {
      writeBookSourceEngine(v);
      expect(readBookSourceEngine()).toBe(v);
    }
  });

  it('非法值忽略：不写进去（拼错的开关名不该让链路静默变成另一个行为）', () => {
    const warn = console.warn;
    console.warn = () => {};
    writeBookSourceEngine('nope' as BookSourceEngine);
    console.warn = warn;
    expect(localStorage.getItem(BOOK_SOURCE_ENGINE_KEY)).toBeNull();
    expect(readBookSourceEngine()).toBe('rule');
  });

  it('存储里的乱值（旧版本 / 手工改）按缺省处理，不抛', () => {
    localStorage.setItem(BOOK_SOURCE_ENGINE_KEY, 'garbage');
    expect(readBookSourceEngine()).toBe('rule');
  });

  it('localStorage 抛错（隐私模式）时读回缺省而不是崩', () => {
    const get = Storage.prototype.getItem;
    Storage.prototype.getItem = () => {
      throw new Error('denied');
    };
    try {
      expect(readBookSourceEngine()).toBe('rule');
    } finally {
      Storage.prototype.getItem = get;
    }
  });

  it('localStorage 抛错时写入降级为保持原值（不崩）', () => {
    const warn = console.warn;
    console.warn = () => {};
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error('quota');
    };
    try {
      expect(() => writeBookSourceEngine('js')).not.toThrow();
      expect(readBookSourceEngine()).toBe('rule');
    } finally {
      Storage.prototype.setItem = set;
      console.warn = warn;
    }
  });
});

describe('resolveEngineMode —— 装载策略', () => {
  it('js：只装旧链路', () => {
    expect(resolveEngineMode('js', false)).toEqual({ useRule: false, useJs: true });
    expect(resolveEngineMode('js', true)).toEqual({ useRule: false, useJs: true });
  });

  it('both：两条都装', () => {
    expect(resolveEngineMode('both', false)).toEqual({ useRule: true, useJs: true });
    expect(resolveEngineMode('both', true)).toEqual({ useRule: true, useJs: true });
  });

  it('rule + 已有 JSON 源：只装规则链路', () => {
    expect(resolveEngineMode('rule', true)).toEqual({ useRule: true, useJs: false });
  });

  it('rule + **还没有** JSON 源：仍然装 JS（过渡期 fail-open，防书源集体消失）', () => {
    expect(resolveEngineMode('rule', false)).toEqual({ useRule: true, useJs: true });
  });

  it('js 档位是回退通道：hasRuleDocs 不影响它', () => {
    // P2/P3 之后磁盘上全是 .json，'js' 仍必须能手动切回去
    expect(resolveEngineMode('js', true).useJs).toBe(true);
  });
});
