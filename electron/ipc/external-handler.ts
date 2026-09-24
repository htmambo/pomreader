import { IpcMain, shell } from 'electron';

export function registerExternalHandler(ipcMain: IpcMain): void {
  ipcMain.handle('pom:open-external', async (_e, url: string) => {
    await shell.openExternal(url);
  });
}
