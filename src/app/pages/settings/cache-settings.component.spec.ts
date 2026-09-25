import '@angular/compiler';
import { describe, it, expect } from 'vitest';
import { CacheSettingsComponent } from './cache-settings.component';

describe('CacheSettingsComponent', () => {
  // formatSize 是无副作用的纯函数：通过原型调用避免 TestBed init 依赖
  // 与项目其他 spec 一致——直接走 class 路径，不走 TestBed
  const { formatSize } = CacheSettingsComponent.prototype as unknown as {
    formatSize: (bytes: number) => string;
  };

  it('should format bytes correctly', () => {
    expect(formatSize(500)).toBe('500 B');
    expect(formatSize(1024)).toBe('1.0 KB');
    expect(formatSize(1024 * 1024)).toBe('1.0 MB');
    expect(formatSize(1024 * 1024 * 1024)).toBe('1.00 GB');
  });
});