import { Injectable, signal } from '@angular/core';
import { BookSourceMeta } from './js-source/source-meta.types';

/**
 * 书源管理列表页会话级状态（root service，路由切换不销毁）
 *
 * 设计要点：
 * - 过滤词 + 书源列表全部由本服务持有，路由切走再回来直接恢复现场
 * - stale-while-revalidate：组件 init 时若已有缓存立即展示，
 *   同时后台再走一次 IPC 刷新（保证启停/删除结果与磁盘一致）
 * - 启停/删除在服务内直接 patch 缓存，无需回组件层
 */

type PomAdmin = {
  booksourceList?: () => Promise<BookSourceMeta[]>;
  booksourceToggle?: (fileName: string, enabled: boolean, sourceDir?: string) => Promise<void>;
  booksourceDelete?: (fileName: string, sourceDir?: string) => Promise<void>;
};

function pomApi(): PomAdmin | null {
  if (typeof window === 'undefined') return null;
  return (window.pomAPI as unknown as PomAdmin | undefined) ?? null;
}

@Injectable({ providedIn: 'root' })
export class BookSourceListStateService {
  /** 过滤词（输入框双向绑定） */
  readonly filter = signal('');
  /** 书源列表 */
  readonly sources = signal<BookSourceMeta[]>([]);
  /** 是否已至少成功加载过一次 */
  readonly loaded = signal(false);
  /** 当前是否在后台刷新（缓存已展示，不阻塞 UI） */
  readonly refreshing = signal(false);

  /** 拉取全量书源元数据；首次会显示 loading，后续走后台刷新不阻塞 */
  async refresh(showLoading: boolean): Promise<void> {
    const api = pomApi();
    if (!api?.booksourceList) {
      // IPC 不可用时不抛错，由组件用 toast 提示并保持缓存原样
      throw new Error('IPC 不可用');
    }
    if (showLoading) {
      this.refreshing.set(false);
    } else {
      this.refreshing.set(true);
    }
    try {
      const list = await api.booksourceList();
      this.sources.set(Array.isArray(list) ? list : []);
      this.loaded.set(true);
    } finally {
      this.refreshing.set(false);
    }
  }

  /** 启停切换：本地先 patch 缓存，IPC 失败回滚 */
  async toggle(src: BookSourceMeta, next: boolean): Promise<void> {
    const api = pomApi();
    if (!api?.booksourceToggle) throw new Error('IPC 不可用');
    const prev = src.enabled;
    this.patch(src, { enabled: next });
    try {
      await api.booksourceToggle(src.fileName, next, src.sourceDir);
    } catch (e) {
      this.patch(src, { enabled: prev });
      throw e;
    }
  }

  /** 删除：从缓存中移除，IPC 失败则保留条目并向上抛错 */
  async remove(src: BookSourceMeta): Promise<void> {
    const api = pomApi();
    if (!api?.booksourceDelete) throw new Error('IPC 不可用');
    await api.booksourceDelete(src.fileName, src.sourceDir);
    this.sources.update((arr) => arr.filter((s) => s.fileName !== src.fileName));
  }

  /** 不可变更新单个条目 */
  private patch(src: BookSourceMeta, change: Partial<BookSourceMeta>): void {
    this.sources.update((arr) =>
      arr.map((s) => (s.fileName === src.fileName ? { ...s, ...change } : s)),
    );
  }
}