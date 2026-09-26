import { describe, it, expect, beforeEach } from 'vitest';
import { AiDraftService, MockTemplateProvider } from './ai-draft.service';

describe('AiDraftService', () => {
  let service: AiDraftService;

  beforeEach(() => {
    service = new AiDraftService();
  });

  it('should generate mock template containing key sections', async () => {
    const code = await service.generate({ name: '测试书源', url: 'https://example.test' });
    expect(code).toContain('@name');
    expect(code).toContain('@url');
    expect(code).toContain('function search');
    expect(code).toContain('function bookInfo');
    expect(code).toContain('function toc');
    expect(code).toContain('function chapterContent');
    expect(code).toContain('legado.http.get');
    expect(code).toContain('https://example.test');
  });

  it('should default author to "AI Draft" when omitted', async () => {
    const code = await service.generate({ name: 'X', url: 'https://example.test' });
    expect(code).toContain('@author        AI Draft');
  });

  it('should respect custom author', async () => {
    const code = await service.generate({ name: 'X', url: 'https://example.test', author: '果农' });
    expect(code).toContain('@author        果农');
  });

  it('should suggest safe file name', () => {
    expect(service.suggestFileName('书源!@# 测试')).toMatch(/^[\w一-鿿-]+\.js$/);
    expect(service.suggestFileName('')).toMatch(/^source-\d+\.js$/);
    expect(service.suggestFileName('normal_name-1')).toBe('normal_name-1.js');
  });

  it('should allow custom provider', async () => {
    service.setProvider({ generate: async () => 'custom code' });
    expect(await service.generate({ name: 'X', url: 'Y' })).toBe('custom code');
  });

  it('MockTemplateProvider can be used standalone', async () => {
    const p = new MockTemplateProvider();
    const code = await p.generate({ name: 'A', url: 'https://a.test' });
    expect(code).toContain('// @name          A');
    expect(code).toContain('https://a.test');
  });
});