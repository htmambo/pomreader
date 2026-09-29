import { Injectable, signal } from '@angular/core';
import { type BookSourceMeta } from './source-meta.types';

/**
 * 书源管理列表页会话级状态（root service，路由切换不销毁）
 *
 * P3 起列表数据源切到 JSON 链路（方案 §5）：booksourceListJson / booksourceToggleJson /
 * booksourceDeleteJson（旧 .js channel 不再消费；流式 booksourceListJsonStreaming 语义由
 * 主进程分批推送承担，本服务一次取全量 —— 列表页原本就是非流式消费）。
 *
 * needs-manual 行内状态（§4.3）：legacies 由常驻 pom:booksource-legacy-list 扫描
 * booksources_legacy/ 得出，随 refresh 一并拉取。
 *
 * 设计要点：
 * - 过滤词 + 书源列表全部由本服务持有，路由切走再回来直接恢复现场
 * - stale-while-revalidate：组件 init 时若已有缓存立即展示，
 *   同时后台再走一次 IPC 刷新（保证启停/删除结果与磁盘一致）
 * - 启停/删除在服务内直接 patch 缓存，无需回组件层
 */

/** booksources_legacy/ 中的未迁移 JS 源（LegacyItem 同构，含 legacy 目录绝对路径 sourceDir） */
export interface LegacySourceItem {
  fileName: string;
  enabled: boolean;
  sourceDir: string;
  reason?: string;
}

type PomAdmin = {
  booksourceListJson?: () => Promise<BookSourceMeta[]>;
  booksourceToggleJson?: (fileName: string, enabled: boolean, sourceDir?: string) => Promise<void>;
  booksourceDeleteJson?: (fileName: string, sourceDir?: string) => Promise<void>;
  booksourceLegacyList?: () => Promise<LegacySourceItem[]>;
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
  /** 书源列表（JSON 源） */
  readonly sources = signal<BookSourceMeta[]>([]);
  /** 未迁移 legacy JS 源（needs-manual 行内状态，渲染在列表末尾标灰） */
  readonly legacies = signal<LegacySourceItem[]>([]);
  /** 是否已至少成功加载过一次 */
  readonly loaded = signal(false);
  /** 当前是否在后台刷新（缓存已展示，不阻塞 UI） */
  readonly refreshing = signal(false);

  /** 拉取全量书源元数据 + legacy 清单；首次会显示 loading，后续走后台刷新不阻塞 */
  async refresh(showLoading: boolean): Promise<void> {
    const api = pomApi();
    if (!api?.booksourceListJson) {
      // IPC 不可用时不抛错，由组件用 toast 提示并保持缓存原样
      throw new Error('IPC 不可用');
    }
    if (showLoading) {
      this.refreshing.set(false);
    } else {
      this.refreshing.set(true);
    }
    try {
      const list = await api.booksourceListJson();
      this.sources.set(Array.isArray(list) ? list : []);
      // legacy 清单失败不阻断主列表（needs-manual 行内状态是增强信息）
      try {
        const legacy = await api.booksourceLegacyList?.();
        this.legacies.set(Array.isArray(legacy) ? legacy : []);
      } catch {
        /* legacy 扫描失败静默，保持旧值 */
      }
      this.loaded.set(true);
    } finally {
      this.refreshing.set(false);
    }
  }

  /** 启停切换：本地先 patch 缓存，IPC 失败回滚 */
  async toggle(src: BookSourceMeta, next: boolean): Promise<void> {
    const api = pomApi();
    if (!api?.booksourceToggleJson) throw new Error('IPC 不可用');
    const prev = src.enabled;
    this.patch(src, { enabled: next });
    try {
      await api.booksourceToggleJson(src.fileName, next, src.sourceDir);
    } catch (e) {
      this.patch(src, { enabled: prev });
      throw e;
    }
  }

  /** 删除 JSON 源：从缓存中移除，IPC 失败则保留条目并向上抛错 */
  async remove(src: BookSourceMeta): Promise<void> {
    const api = pomApi();
    if (!api?.booksourceDeleteJson) throw new Error('IPC 不可用');
    await api.booksourceDeleteJson(src.fileName, src.sourceDir);
    this.sources.update((arr) => arr.filter((s) => s.fileName !== src.fileName));
  }

  /**
   * 删除 legacy 源（§4.3 行内「删除」）：复用通用 pom:booksource-delete（按路径删任意文件
   * + 清 marker），传 legacy sourceDir；成功后从 legacies 缓存移除
   */
  async removeLegacy(item: LegacySourceItem): Promise<void> {
    const api = pomApi();
    if (!api?.booksourceDelete) throw new Error('IPC 不可用');
    await api.booksourceDelete(item.fileName, item.sourceDir);
    this.legacies.update((arr) => arr.filter((s) => s.fileName !== item.fileName));
  }

  /** 不可变更新单个条目 */
  private patch(src: BookSourceMeta, change: Partial<BookSourceMeta>): void {
    this.sources.update((arr) =>
      arr.map((s) => (s.fileName === src.fileName ? { ...s, ...change } : s)),
    );
  }
}
