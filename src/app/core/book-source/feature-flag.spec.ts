import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getBookSourceEngine,
  jsEngineEnabled,
  ruleEngineEnabled,
  setBookSourceEngine,
} from './feature-flag';

const STORAGE_KEY = 'pom.bookSource.engine';

describe('feature-flag（书源引擎运行时开关）', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('未存值时缺省返回 rule', () => {
    expect(getBookSourceEngine()).toBe('rule');
  });

  it('set 后 get 往返一致（rule / js / both）', () => {
    for (const engine of ['rule', 'js', 'both'] as const) {
      setBookSourceEngine(engine);
      expect(localStorage.getItem(STORAGE_KEY)).toBe(engine);
      expect(getBookSourceEngine()).toBe(engine);
    }
  });

  it('存值为非法字符串时回落缺省 rule', () => {
    localStorage.setItem(STORAGE_KEY, 'not-an-engine');
    expect(getBookSourceEngine()).toBe('rule');
  });

  it('localStorage 不可达时返回缺省 rule，set 不抛错', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(getBookSourceEngine()).toBe('rule');
    expect(() => setBookSourceEngine('both')).not.toThrow();
  });

  it('ruleEngineEnabled：rule / both 为 true，js 为 false', () => {
    expect(ruleEngineEnabled()).toBe(true); // 缺省 rule
    setBookSourceEngine('both');
    expect(ruleEngineEnabled()).toBe(true);
    setBookSourceEngine('js');
    expect(ruleEngineEnabled()).toBe(false);
  });

  it('jsEngineEnabled：js / both 为 true，rule 为 false', () => {
    setBookSourceEngine('js');
    expect(jsEngineEnabled()).toBe(true);
    setBookSourceEngine('both');
    expect(jsEngineEnabled()).toBe(true);
    setBookSourceEngine('rule');
    expect(jsEngineEnabled()).toBe(false);
  });
});
