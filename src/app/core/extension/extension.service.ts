import { Injectable } from '@angular/core';
import { ExtensionMeta } from './extension.types';

/**
 * 扩展系统服务（实施计划 T-010 + spec FR-4）
 *
 * 设计要点：
 * - parseUserScriptMeta 纯函数：扫 `// ==UserScript==` 块（前 100 行），不依赖 IO
 * - CRUD 走 `window.pomAPI.extension*`（preload 暴露 → 主进程 extension-handler）
 * - eval：v1 仅返回元数据，args 不实际执行（DM-4 推迟 UI hooks）；
 *   v2 UI hooks 完成后改用 Renderer 端 SandboxService eval
 * - 浏览器降级模式（无 pomAPI）返回空数组 / 抛错，UI 不崩
 */

@Injectable({ providedIn: 'root' })
export class ExtensionService {
  /**
   * 解析 UserScript 头部注释（`// ==UserScript==` 到 `// ==/UserScript==` 之间，前 100 行）
   * 多行 @key value 同 @name 取首条；@match/@grant 可多值
   */
  parseUserScriptMeta(
    content: string,
    fileName: string,
    enabledOverride = true,
    fileSize = 0,
    modifiedAt = 0,
  ): ExtensionMeta {
    const lines = content.split(/\r?\n/).slice(0, 100);
    const inBlock = lines.some((line) => line.includes('==UserScript=='));
    if (!inBlock) throw new Error('不是合法的 UserScript 文件（缺 ==UserScript== 标记）');

    const fields: Partial<ExtensionMeta> = {
      matchPatterns: [],
      grants: [],
      enabled: enabledOverride,
      fileName,
      fileSize,
      modifiedAt,
    };

    let inUserScript = false;
    for (const line of lines) {
      const trimmed = line.trimStart();
      if (trimmed.includes('==UserScript==')) {
        inUserScript = true;
        continue;
      }
      if (trimmed.includes('==/UserScript==')) break;
      if (!inUserScript) continue;
      if (!trimmed.startsWith('//')) continue;
      const body = trimmed.replace(/^\/+/, '').trimStart();
      if (!body.startsWith('@')) continue;
      const rest = body.slice(1);
      const sepIdx = rest.search(/\s/);
      if (sepIdx === -1) continue;
      const key = rest.slice(0, sepIdx).trim();
      const value = rest.slice(sepIdx + 1).trim();
      if (!value) continue;
      switch (key) {
        case 'name':
          if (!fields.name) fields.name = value;
          break;
        case 'namespace':
          if (!fields.namespace) fields.namespace = value;
          break;
        case 'version':
          if (!fields.version) fields.version = value;
          break;
        case 'description':
          if (!fields.description) fields.description = value;
          break;
        case 'author':
          if (!fields.author) fields.author = value;
          break;
        case 'match':
        case 'include':
          fields.matchPatterns!.push(value);
          break;
        case 'grant':
          // 过滤 `none` 哨兵值（legado 约定）
          if (value !== 'none') fields.grants!.push(value);
          break;
        case 'run-at':
          if (!fields.runAt) fields.runAt = value;
          break;
        case 'category':
          if (!fields.category) fields.category = value;
          break;
        case 'enabled':
          fields.enabled = !/^(false|0|no)$/i.test(value);
          break;
      }
    }

    return {
      fileName,
      name: fields.name || fileName.replace(/\.js$/, ''),
      namespace: fields.namespace || '',
      version: fields.version || '1',
      description: fields.description || '',
      author: fields.author || '',
      matchPatterns: fields.matchPatterns!,
      grants: fields.grants!,
      runAt: fields.runAt || 'document-end',
      category: fields.category || 'general',
      enabled: fields.enabled!,
      fileSize,
      modifiedAt,
    };
  }

  async list(): Promise<ExtensionMeta[]> {
    if (!window.pomAPI?.extensionList) return [];
    return (await window.pomAPI.extensionList()) as ExtensionMeta[];
  }

  async read(fileName: string): Promise<string> {
    if (!window.pomAPI?.extensionRead) throw new Error('IPC 不可用');
    return await window.pomAPI.extensionRead(fileName);
  }

  async save(fileName: string, content: string): Promise<void> {
    if (!window.pomAPI?.extensionSave) throw new Error('IPC 不可用');
    await window.pomAPI.extensionSave(fileName, content);
  }

  async delete(fileName: string): Promise<void> {
    if (!window.pomAPI?.extensionDelete) throw new Error('IPC 不可用');
    await window.pomAPI.extensionDelete(fileName);
  }

  /**
   * **eval-only stub（Round 1 CR3 修复）**：v1 仅返回元数据，args 不实际执行
   * v2 UI hooks 完成后改用 sandbox eval
   */
  async eval(
    fileName: string,
    _args: unknown[],
  ): Promise<{ meta: ExtensionMeta; hookCount: number }> {
    const content = await this.read(fileName);
    const meta = this.parseUserScriptMeta(content, fileName);
    return { meta, hookCount: 0 };
  }
}