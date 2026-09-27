import { Injectable, Signal, effect } from '@angular/core';
import { Settings } from '../models/settings.model';
import { createSettingsStore, SettingsStore } from '../logic/settings-store';

/**
 * SettingsService — 阅读设置 facade（EVO-12）
 *
 * v2 (EVO-12): signal 状态 + 校验 + 持久化抽到 core/logic/settings-store.ts
 * 本 service 只剩 effect（持久化触发）+ UA 推送
 *
 * 调用方 0 改动：signal 接口与原 service 1:1 对应
 *
 * 静态方法（load / mergeValidated / validateInt / validateFloat）通过 namespace re-export
 * 保持向后兼容（spec.ts 直接调用 SettingsService.load / mergeValidated）
 */
@Injectable({ providedIn: 'root' })
export class SettingsService {
  private readonly store: SettingsStore = createSettingsStore();
  readonly settings: Signal<Settings> = this.store.settings;

  constructor() {
    // signal 变化自动落盘
    effect(() => {
      SettingsStore.persist(this.store.settings());
    });
    // 启动时把当前 fetchUa 推到主进程（主进程 net.request 用）
    const ua = this.store.settings().fetchUa;
    if (ua) {
      void window.pomAPI?.setFetchUA?.(ua).catch(() => undefined);
    }
  }

  update<K extends keyof Settings>(key: K, value: Settings[K]): void {
    this.store.update(key, value);
  }

  resetToDefault(): void {
    this.store.resetToDefault();
  }

  // 静态方法别名（向后兼容：spec.ts 用 SettingsService.load / mergeValidated）
  static load = SettingsStore.load;
  static mergeValidated = SettingsStore.mergeValidated;
  static validateInt = SettingsStore.validateInt;
  static validateFloat = SettingsStore.validateFloat;
}