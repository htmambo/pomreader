import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import 'zone.js';
import { TestBed } from '@angular/core/testing';
import {
  BrowserDynamicTestingModule,
  platformBrowserDynamicTesting,
} from '@angular/platform-browser-dynamic/testing';
import { NzMessageService } from 'ng-zorro-antd/message';
import { ToastService } from './toast.service';

/**
 * ToastService spec — 全局消息提示转发契约
 * 四个级别必须 1:1 转发到 NzMessageService（warn → nz.warning）
 */

describe('ToastService', () => {
  let svc: ToastService;
  let nzMock: any;

  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserDynamicTestingModule, platformBrowserDynamicTesting());
  });

  beforeEach(() => {
    nzMock = {
      info: vi.fn(),
      success: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
    };
    TestBed.configureTestingModule({
      providers: [ToastService, { provide: NzMessageService, useValue: nzMock }],
    });
    svc = TestBed.inject(ToastService);
  });

  it('info 应转发到 NzMessageService.info', () => {
    svc.info('提示');
    expect(nzMock.info).toHaveBeenCalledWith('提示');
    expect(nzMock.success).not.toHaveBeenCalled();
    expect(nzMock.warning).not.toHaveBeenCalled();
    expect(nzMock.error).not.toHaveBeenCalled();
  });

  it('success 应转发到 NzMessageService.success', () => {
    svc.success('成功');
    expect(nzMock.success).toHaveBeenCalledWith('成功');
    expect(nzMock.info).not.toHaveBeenCalled();
  });

  it('warn 应转发到 NzMessageService.warning（方法名映射）', () => {
    svc.warn('警告');
    expect(nzMock.warning).toHaveBeenCalledWith('警告');
    expect(nzMock.error).not.toHaveBeenCalled();
  });

  it('error 应转发到 NzMessageService.error', () => {
    svc.error('失败');
    expect(nzMock.error).toHaveBeenCalledWith('失败');
    expect(nzMock.info).not.toHaveBeenCalled();
  });
});
