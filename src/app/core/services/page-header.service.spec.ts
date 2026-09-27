import { describe, it, expect } from 'vitest';
import { PageHeaderService } from './page-header.service';

/**
 * PageHeaderService spec — 全局顶部 header 共享状态
 * 极简：2 个 signal，验证读写契约
 */

describe('PageHeaderService', () => {
  it('初始 title / subtitle 应为空字符串', () => {
    const svc = new PageHeaderService();
    expect(svc.title()).toBe('');
    expect(svc.subtitle()).toBe('');
  });

  it('应能写入并读回 title', () => {
    const svc = new PageHeaderService();
    svc.title.set('书架');
    expect(svc.title()).toBe('书架');
  });

  it('应能写入并读回 subtitle', () => {
    const svc = new PageHeaderService();
    svc.subtitle.set('共 5 本');
    expect(svc.subtitle()).toBe('共 5 本');
  });

  it('title 与 subtitle 应相互独立', () => {
    const svc = new PageHeaderService();
    svc.title.set('A');
    svc.subtitle.set('B');
    expect(svc.title()).toBe('A');
    expect(svc.subtitle()).toBe('B');
  });
});
