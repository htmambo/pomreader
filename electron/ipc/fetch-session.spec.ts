import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock electron BEFORE importing fetch-session
vi.mock('electron', () => ({
  app: { userAgentFallback: '' },
  session: {
    defaultSession: { setUserAgent: vi.fn() },
    fromPartition: vi.fn(() => ({ setUserAgent: vi.fn(), cookies: { get: vi.fn(), set: vi.fn() } })),
  },
}));

import { defaultUA, getUA, setFetchUA, browserHeaders, FETCH_PARTITION } from './fetch-session';

/**
 * fetch-session spec — UA + session + browserHeaders
 *
 * 覆盖：
 * - defaultUA 平台分支（win32 / darwin / linux）
 * - getUA / setFetchUA 自定义与恢复默认
 * - browserHeaders 完整字段 + navigation 模式 + referer 默认值 + chrome 版本提取
 */

describe('defaultUA', () => {
  it('应返回含 Mozilla/5.0 + Chrome/152 + Safari 的 UA 字符串', () => {
    const ua = defaultUA();
    expect(ua).toMatch(/^Mozilla\/5\.0 /);
    expect(ua).toMatch(/Chrome\/152/);
    expect(ua).toMatch(/Safari\/537\.36$/);
  });

  it('应含平台 OS 标识', () => {
    const ua = defaultUA();
    if (process.platform === 'win32') {
      expect(ua).toContain('Windows NT 10.0');
      expect(ua).toContain('Win64; x64');
    } else if (process.platform === 'darwin') {
      expect(ua).toContain('Macintosh');
      expect(ua).toContain('Intel Mac OS X');
    } else {
      expect(ua).toContain('X11');
      expect(ua).toContain('Linux x86_64');
    }
  });
});

describe('getUA / setFetchUA', () => {
  it('默认应返回 defaultUA 结果', () => {
    expect(getUA()).toBe(defaultUA());
  });

  it('setFetchUA 自定义值后 getUA 应返回自定义值', () => {
    setFetchUA('Mozilla/5.0 Custom/1.0');
    expect(getUA()).toBe('Mozilla/5.0 Custom/1.0');
  });

  it('setFetchUA(null) 应恢复默认', () => {
    setFetchUA('custom');
    setFetchUA(null);
    expect(getUA()).toBe(defaultUA());
  });

  it('setFetchUA(空串) 应恢复默认', () => {
    setFetchUA('custom');
    setFetchUA('');
    expect(getUA()).toBe(defaultUA());
  });

  it('setFetchUA 应 trim 前后空格', () => {
    setFetchUA('  custom-ua  ');
    expect(getUA()).toBe('custom-ua');
  });

  afterEach(() => {
    setFetchUA(null);
  });
});

describe('browserHeaders', () => {
  it('基本字段应齐全（User-Agent / Accept / Accept-Language / sec-ch-ua*）', () => {
    const h = browserHeaders('https://example.com/page');
    expect(h['User-Agent']).toBe(defaultUA());
    expect(h['Accept']).toBe('*/*'); // 默认非 navigation
    expect(h['Accept-Language']).toBe('zh-CN,zh;q=0.9,en;q=0.8');
    expect(h['sec-ch-ua']).toMatch(/"Chromium";v="\d+"/);
    expect(h['sec-ch-ua-mobile']).toBe('?0');
    expect(h['sec-ch-ua-platform']).toMatch(/"(Windows|macOS|Linux)"/);
  });

  it('navigation=true 应包含 Sec-Fetch-* 与 Upgrade-Insecure-Requests', () => {
    const h = browserHeaders('https://example.com/page', { navigation: true });
    expect(h['Accept']).toBe(
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    );
    expect(h['Upgrade-Insecure-Requests']).toBe('1');
    expect(h['Sec-Fetch-Dest']).toBe('document');
    expect(h['Sec-Fetch-Mode']).toBe('navigate');
    expect(h['Sec-Fetch-Site']).toBe('same-origin');
    expect(h['Sec-Fetch-User']).toBe('?1');
  });

  it('Referer 默认应填站点首页 origin + /', () => {
    const h = browserHeaders('https://example.com/article/123');
    expect(h['Referer']).toBe('https://example.com/');
  });

  it('显式 referer 优先于 origin 默认', () => {
    const h = browserHeaders('https://example.com/article/123', {
      referer: 'https://other.com/parent',
    });
    expect(h['Referer']).toBe('https://other.com/parent');
  });

  it('Referer 为空字符串时应省略 header', () => {
    const h = browserHeaders('https://example.com/', { referer: '' });
    expect(h['Referer']).toBeUndefined();
  });

  it('非法 URL 不应抛错（origin 为空，Referer header 省略）', () => {
    expect(() => browserHeaders('not-a-url')).not.toThrow();
    const h = browserHeaders('not-a-url');
    // origin 计算失败 → referer 默认值 '' → falsy → header 省略
    expect(h['Referer']).toBeUndefined();
  });

  it('sec-ch-ua 版本号应从当前 UA 提取', () => {
    // UA 必须含 'Chrome/N' 字面量才能被 regex /Chrome\/(\d+)/ 提取
    setFetchUA('Mozilla/5.0 CustomBrowser/999.0 Chrome/200');
    expect(getUA()).toBe('Mozilla/5.0 CustomBrowser/999.0 Chrome/200');
    const h = browserHeaders('https://example.com/');
    expect(h['sec-ch-ua']).toContain('"Chromium";v="200"');
    setFetchUA(null);
  });

  it('FETCH_PARTITION 应为 persist:fetch（共享 session 名）', () => {
    expect(FETCH_PARTITION).toBe('persist:fetch');
  });
});