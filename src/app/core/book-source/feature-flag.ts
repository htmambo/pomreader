/**
 * 书源引擎运行时开关（方案 §3.3 / P1）
 *
 * JSON 规则书源改造过渡期的运行时开关：'rule'（仅 JSON）| 'js'（仅 JS）| 'both'（并存），
 * 存 localStorage 'pom.bookSource.engine'，缺省 'rule'。
 * 由 BookSourceRegistry.loadAllJsAdapters / loadAllRuleAdapters 在加载时读取；
 * P4 删除 JS 链路时本模块一并删除。
 *
 * 历史说明：原编译期常量 BOOK_SOURCE_FEATURE_FLAGS（F10：全仓仅 registry 一处消费，
 * 其余页面绕过，实际关不掉）已删除，运行时开关取代之（`rg BOOK_SOURCE_FEATURE_FLAGS`
 * 确认唯一消费点为 book-source.registry.ts:67 后删除，2026-09-29）。
 */

export type BookSourceEngine = 'rule' | 'js' | 'both';

const STORAGE_KEY = 'pom.bookSource.engine';
const DEFAULT_ENGINE: BookSourceEngine = 'rule';

function isBookSourceEngine(value: unknown): value is BookSourceEngine {
  return value === 'rule' || value === 'js' || value === 'both';
}

/** 读取运行时引擎开关；localStorage 不可达（SSR/测试）或存值非法 → 缺省 'rule' */
export function getBookSourceEngine(): BookSourceEngine {
  try {
    if (typeof localStorage === 'undefined') return DEFAULT_ENGINE;
    const raw = localStorage.getItem(STORAGE_KEY);
    return isBookSourceEngine(raw) ? raw : DEFAULT_ENGINE;
  } catch {
    return DEFAULT_ENGINE;
  }
}

export function setBookSourceEngine(engine: BookSourceEngine): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORAGE_KEY, engine);
  } catch {
    // localStorage 不可写（隐私模式等）→ 静默忽略，保持缺省行为
  }
}

/** JSON 规则链路是否启用（'rule' | 'both'） */
export function ruleEngineEnabled(): boolean {
  const engine = getBookSourceEngine();
  return engine === 'rule' || engine === 'both';
}

/** JS 沙箱链路是否启用（'js' | 'both'） */
export function jsEngineEnabled(): boolean {
  const engine = getBookSourceEngine();
  return engine === 'js' || engine === 'both';
}
