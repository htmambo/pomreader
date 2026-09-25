import { Component, Input, signal, computed, inject, OnChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { CoverService } from '../../../core/cover/cover.service';

/**
 * CoverImg — 统一封面渲染组件（实施计划 T-009 + spec FR-3.6）
 *
 * URL 协议识别：
 * - local://     → window.electronAPI.convertFileSrc 转 file://
 * - http(s)://   → CoverService.resolve（IPC 下载 + 本地缓存 + fallback data:）
 * - data:        → 直传（inline SVG / base64）
 * - 其他（asset:// / 相对路径） → 直传，<img> 自处理
 *
 * 加载态：CSS skeleton；失败：首字 + 纯色
 */

interface ElectronAPI {
  convertFileSrc?(filePath: string): string;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

@Component({
  selector: 'app-cover-img',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div
      class="cover-img"
      [style.background-color]="fallbackColor"
      [style.aspect-ratio]="aspectRatio"
      [attr.aria-label]="title || '封面'"
    >
      @if (loading()) {
        <div class="skeleton"></div>
      } @else if (displaySrc()) {
        <img
          [src]="displaySrc()"
          [alt]="title"
          (error)="onError()"
          loading="lazy"
        />
      } @else {
        <span class="fallback-text">{{ firstChar }}</span>
      }
    </div>
  `,
  styles: [
    `
      .cover-img {
        width: 100%;
        overflow: hidden;
        position: relative;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 4px;
      }
      .cover-img img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
      }
      .skeleton {
        position: absolute;
        inset: 0;
        background: rgba(0, 0, 0, 0.12);
        animation: cover-pulse 1.5s ease-in-out infinite;
      }
      .fallback-text {
        font-size: 2.5rem;
        color: #fff;
        font-weight: bold;
        text-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
      }
      @keyframes cover-pulse {
        0%, 100% { opacity: 0.12; }
        50% { opacity: 0.32; }
      }
    `,
  ],
})
export class CoverImgComponent implements OnChanges {
  @Input() src: string | undefined | null = '';
  @Input() title = '';
  @Input() fallbackColor = '#177ddc';
  @Input() aspectRatio = '3 / 4';

  private readonly cover = inject(CoverService);

  /** 异步解析后的最终 src（local:// → file:// 或 http(s) → localRef） */
  resolvedSrc = signal<string | null>(null);
  loading = signal(false);
  failed = signal(false);

  /** 实际给 <img> 的 src：失败 → null，否则 resolvedSrc 或原 src */
  displaySrc = computed(() => {
    if (this.failed()) return null;
    return this.resolvedSrc() ?? this.src ?? null;
  });

  get firstChar(): string {
    const t = (this.title || '').trim();
    return t.charAt(0) || '?';
  }

  ngOnChanges(): void {
    // src 变化时重置并重新解析
    this.failed.set(false);
    this.resolvedSrc.set(null);
    void this.resolveIfNeeded();
  }

  private async resolveIfNeeded(): Promise<void> {
    const src = (this.src ?? '').trim();
    if (!src) return;

    // data: / file:// / http://localhost → 直传，不走 IPC
    if (
      src.startsWith('data:') ||
      src.startsWith('file://') ||
      src.startsWith('http://localhost') ||
      src.startsWith('https://localhost')
    ) {
      this.resolvedSrc.set(null);
      return;
    }

    // local:// → electron convertFileSrc
    if (src.startsWith('local://')) {
      const api = window.electronAPI;
      if (api?.convertFileSrc) {
        const abs = src.replace(/^local:\/\//, '');
        this.resolvedSrc.set(api.convertFileSrc(abs));
      } else {
        // ng serve 模式无 electron → 触发 fallback
        this.failed.set(true);
      }
      return;
    }

    // http(s):// → CoverService（IPC 下载 + 缓存 + fallback）
    if (src.startsWith('http://') || src.startsWith('https://')) {
      this.loading.set(true);
      try {
        const localRef = await this.cover.resolve(src);
        if (localRef.startsWith('data:')) {
          // IPC 不可用或失败 → fallback 已是 data:，不再加载 <img>
          this.failed.set(true);
        } else {
          this.resolvedSrc.set(localRef);
        }
      } catch {
        this.failed.set(true);
      } finally {
        this.loading.set(false);
      }
      return;
    }

    // 其他（asset:// / 相对路径）→ 直传
    this.resolvedSrc.set(null);
  }

  onError(): void {
    this.failed.set(true);
    this.resolvedSrc.set(null);
  }
}