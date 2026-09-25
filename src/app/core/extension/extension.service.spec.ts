import { describe, it, expect, beforeEach } from 'vitest';
import { ExtensionService } from './extension.service';

describe('ExtensionService', () => {
  let service: ExtensionService;
  beforeEach(() => {
    service = new ExtensionService();
  });

  it('should parse basic UserScript header', () => {
    const content = `// ==UserScript==
// @name          去广告
// @namespace     my-ext
// @version       1.0.0
// @description   去除页面广告
// @author        foo
// @match         https://example.com/*
// @match         https://*.example.com/*
// @grant         GM_setValue
// @grant         GM_getValue
// @run-at        document-end
// @category      utility
// ==/UserScript==
(function() { console.log('ad remover'); })();
`;
    const meta = service.parseUserScriptMeta(content, 'ad-remover.js');
    expect(meta.name).toBe('去广告');
    expect(meta.namespace).toBe('my-ext');
    expect(meta.version).toBe('1.0.0');
    expect(meta.matchPatterns).toEqual(['https://example.com/*', 'https://*.example.com/*']);
    expect(meta.grants).toEqual(['GM_setValue', 'GM_getValue']);
    expect(meta.runAt).toBe('document-end');
    expect(meta.category).toBe('utility');
    expect(meta.author).toBe('foo');
    expect(meta.description).toBe('去除页面广告');
    expect(meta.enabled).toBe(true);
  });

  it('should reject non-UserScript content', () => {
    expect(() => service.parseUserScriptMeta('// just a comment', 'x.js')).toThrow();
  });

  it('should handle enabled false', () => {
    const content = `// ==UserScript==
// @name X
// @enabled false
// ==/UserScript==`;
    const meta = service.parseUserScriptMeta(content, 'x.js');
    expect(meta.enabled).toBe(false);
  });

  it('should fallback name to fileName when missing', () => {
    const content = `// ==UserScript==
// @version 0.1
// ==/UserScript==`;
    const meta = service.parseUserScriptMeta(content, 'my-cool-ext.js');
    expect(meta.name).toBe('my-cool-ext');
    expect(meta.version).toBe('0.1');
  });

  it('should filter @grant none sentinel', () => {
    const content = `// ==UserScript==
// @name X
// @grant none
// @grant GM_xmlhttpRequest
// ==/UserScript==`;
    const meta = service.parseUserScriptMeta(content, 'x.js');
    expect(meta.grants).toEqual(['GM_xmlhttpRequest']);
  });

  it('should support @include as alias for @match', () => {
    const content = `// ==UserScript==
// @name X
// @match https://a.example.com/*
// @include https://b.example.com/*
// ==/UserScript==`;
    const meta = service.parseUserScriptMeta(content, 'x.js');
    expect(meta.matchPatterns).toEqual([
      'https://a.example.com/*',
      'https://b.example.com/*',
    ]);
  });
});