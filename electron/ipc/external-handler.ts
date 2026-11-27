import { IpcMain, shell } from 'electron';
import { URL } from 'url';

/**
 * 外链走系统浏览器。
 *
 * 只允许 http(s)：`shell.openExternal` 对任意协议都会转交操作系统，
 * `file:` / `smb:` 以及系统注册的自定义协议在部分平台可触发本机应用执行。
 */
export function registerExternalHandler(ipcMain: IpcMain): void {
  ipcMain.handle('pom:open-external', async (_e, url: string) => {
    if (typeof url !== 'string' || url.length > 2048) {
      throw new Error('invalid-url');
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error('invalid-url');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`unsupported protocol: ${parsed.protocol}`);
    }
    await shell.openExternal(parsed.toString());
  });
}
