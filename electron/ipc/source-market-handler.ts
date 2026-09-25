/**
 * 书源市场 IPC handler（GitHub raw JSON 拉取 + 单书源安装）
 * 复用 safeNetRequest（SSRF + UA + 超时 + 字节上限）
 */
import { IpcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { atomicWrite, safeFileName } from './booksource-meta';
import { safeNetRequest } from './safe-net';

const MARKET_TIMEOUT_MS = 35000;

export function registerSourceMarketHandler(ipcMain: IpcMain, userData: string): void {
  const primary = path.join(userData, 'booksources');
  fs.mkdirSync(primary, { recursive: true });

  ipcMain.handle('pom:booksource-fetch-repo', async (_e, repoUrl: string) => {
    const result = await safeNetRequest(repoUrl, {
      timeoutMs: MARKET_TIMEOUT_MS,
      accept: 'application/json,text/plain,*/*;q=0.8',
    });
    if (result.status < 200 || result.status >= 300) {
      throw new Error(`仓库拉取失败 HTTP ${result.status}`);
    }
    try {
      return JSON.parse(result.body);
    } catch {
      throw new Error('仓库响应非合法 JSON');
    }
  });

  ipcMain.handle(
    'pom:booksource-install',
    async (_e, downloadUrl: string, fileName: string) => {
      const safe = safeFileName(fileName);
      if (!safe) throw new Error('非法 fileName');
      if (!downloadUrl.startsWith('http://') && !downloadUrl.startsWith('https://')) {
        throw new Error('下载 URL 仅支持 http/https');
      }
      const result = await safeNetRequest(downloadUrl, { timeoutMs: MARKET_TIMEOUT_MS });
      if (result.status < 200 || result.status >= 300) {
        throw new Error(`下载失败 HTTP ${result.status}`);
      }
      fs.mkdirSync(primary, { recursive: true });
      atomicWrite(path.join(primary, safe), result.body);
    }
  );
}