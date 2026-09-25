import { Injectable } from '@angular/core';

/** PomAPI 子集（preload.ts 实际暴露为 Promise<unknown>；此处声明窄类型以提供调用方类型提示） */
type PomMarketApi = {
  booksourceFetchRepo?: (repoUrl: string) => Promise<unknown>;
  booksourceInstall?: (downloadUrl: string, fileName: string) => Promise<void>;
};

/** 市场仓库单条书源条目 */
export interface RepoManifestSource {
  /** 书源 UUID；用于与本地已安装项匹配判断升级/降级 */
  uuid?: string;
  name: string;
  url: string;
  version?: string;
  author?: string;
  description?: string;
  /** GitHub raw .js 文件 URL（主进程据此下载） */
  downloadUrl: string;
  /** 主进程落盘文件名 */
  fileName: string;
}

/** 市场仓库清单 */
export interface RepoManifest {
  name: string;
  version: string;
  /** ISO 日期字符串 */
  updatedAt: string;
  sources: RepoManifestSource[];
}

/** 批量安装进度回调载荷 */
export interface InstallProgress {
  total: number;
  done: number;
  failed: number;
  current: string;
}

/** 批量安装结果 */
export interface InstallBatchResult {
  succeeded: string[];
  failed: Array<{ src: RepoManifestSource; error: string }>;
}

/** 版本对比结果：local 相对 remote 的方向 */
export type VersionDiff = 'upgrade' | 'downgrade' | 'same' | 'unknown';

const CONCURRENCY = 3;

function pomApi(): PomMarketApi | null {
  if (typeof window === 'undefined') return null;
  return (window.pomAPI as unknown as PomMarketApi | undefined) ?? null;
}

/**
 * 书源市场服务（实施计划 T-011 + spec FR-2）
 *
 * 职责：
 * - fetchRepo：拉取远端仓库清单 JSON（主进程已校验 HTTP + JSON 合法性）
 * - installOne：单书源一键安装（IPC booksourceInstall）
 * - installBatch：批量安装，3 并发 + 进度回调 + 失败隔离
 * - compareVersion：本地版本 vs 市场版本对比，用于 v2 升级/降级徽标
 */
@Injectable({ providedIn: 'root' })
export class SourceMarketService {
  /** 内置仓库 URL（DM-5 v1 硬编码占位；该地址当前不存在，用户需在界面填写真实仓库 URL） */
  private readonly DEFAULT_REPO_URL = 'https://raw.githubusercontent.com/pomreader/sources/main/repo.json';
  private readonly REPO_URL_STORAGE_KEY = 'pom.source-market.repo-url';

  /** 当前生效的仓库 URL：localStorage 覆盖值优先，缺省回退内置占位 */
  getRepoUrl(): string {
    return this.getSavedRepoUrl() || this.DEFAULT_REPO_URL;
  }

  /** 用户在界面保存过的仓库 URL；未保存过返回 ''（据此判断是否跳过首启自动拉取） */
  getSavedRepoUrl(): string {
    try {
      return localStorage.getItem(this.REPO_URL_STORAGE_KEY) || '';
    } catch {
      return '';
    }
  }

  /** 持久化用户填写的仓库 URL（拉取成功后调用） */
  setRepoUrl(url: string): void {
    try {
      localStorage.setItem(this.REPO_URL_STORAGE_KEY, url);
    } catch {
      /* quota */
    }
  }

  /** 拉取仓库清单；默认走 getRepoUrl()，可注入测试用 repoUrl */
  async fetchRepo(repoUrl?: string): Promise<RepoManifest> {
    const api = pomApi();
    if (!api?.booksourceFetchRepo) {
      throw new Error('booksourceFetchRepo IPC 不可用');
    }
    const raw = await api.booksourceFetchRepo(repoUrl ?? this.getRepoUrl());
    // 主进程仅做 JSON.parse；此处补最小字段校验，避免后续渲染炸
    if (!raw || typeof raw !== 'object') {
      throw new Error('仓库响应非合法对象');
    }
    return raw as RepoManifest;
  }

  /** 单书源一键安装（不校验 UUID 与 fileName 一致性，留给主进程 fileName 安全策略） */
  async installOne(src: RepoManifestSource): Promise<void> {
    const api = pomApi();
    if (!api?.booksourceInstall) {
      throw new Error('booksourceInstall IPC 不可用');
    }
    await api.booksourceInstall(src.downloadUrl, src.fileName);
  }

  /** 批量安装：3 并发分批 + 进度回调 + 单条失败隔离 */
  async installBatch(
    sources: RepoManifestSource[],
    onProgress?: (p: InstallProgress) => void,
  ): Promise<InstallBatchResult> {
    const succeeded: string[] = [];
    const failed: Array<{ src: RepoManifestSource; error: string }> = [];
    let done = 0;
    for (let i = 0; i < sources.length; i += CONCURRENCY) {
      const batch = sources.slice(i, i + CONCURRENCY);
      await Promise.all(
        batch.map(async (src) => {
          try {
            await this.installOne(src);
            succeeded.push(src.fileName);
          } catch (e) {
            failed.push({ src, error: (e as Error).message });
          } finally {
            done++;
            onProgress?.({
              total: sources.length,
              done,
              failed: failed.length,
              current: src.name,
            });
          }
        }),
      );
    }
    return { succeeded, failed };
  }

  /** 版本对比：本地 vs 市场 → upgrade / downgrade / same / unknown（缺字段视为 unknown） */
  compareVersion(local: string, remote: string): VersionDiff {
    if (!local || !remote) return 'unknown';
    const parse = (v: string): number[] =>
      v.split('.').map((n) => parseInt(n, 10) || 0);
    const [l, r] = [parse(local), parse(remote)];
    const len = Math.max(l.length, r.length);
    for (let i = 0; i < len; i++) {
      const a = l[i] || 0;
      const b = r[i] || 0;
      if (a > b) return 'downgrade';
      if (a < b) return 'upgrade';
    }
    return 'same';
  }
}
