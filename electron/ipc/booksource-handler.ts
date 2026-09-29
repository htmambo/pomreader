/**
 * 书源 JS 文件 IPC handler（CRUD + 流式列表 + HTTP 代理 + eval）
 *
 * - 主目录 `<userData>/booksources/`；草稿 `<userData>/booksources_drafts/`
 * - 流式列表：setImmediate 后台扫描 + `app.emit('pom:booksource-batch')` 分批推送
 * - 写文件走 `atomicWrite`（FR-1.5：写入失败时原文件不被截断）
 * - HTTP 代理走 `safeNetRequest`（含 isPrivateHost SSRF 防护）
 */
import { IpcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import {
  JSON_SOURCE_FORMAT,
  atomicWrite,
  isJsonSourceName,
  jsonEnvelopeError,
  safeFileName,
  scanAllSources,
  scanDir,
} from './booksource-meta';
import { isCfChallenge } from './cf-guard';
import { safeNetRequest } from './safe-net';
import { cfFetchHtmlHidden } from './render-handler';
import {
  BooksourceArchiveArgsSchema,
  BooksourceConvertArgsSchema,
  safeHandleWithMeta,
} from './schema';

const PRIMARY_DIR = 'booksources';
const DRAFTS_DIR = 'booksources_drafts';
/** 旧 JS 书源归档目录（P3 迁移把迁完的 `.js` 移到这里；P4 删） */
const LEGACY_DIR = 'booksources_legacy';
/** 迁移报告落盘位置（渲染端读一次即删） */
const MIGRATION_REPORT_FILE = 'booksources_migration_report.json';
const BATCH_SIZE = 50;
const HTTP_TIMEOUT_MS = 15000;

function primaryDir(userData: string): string {
  return path.join(userData, PRIMARY_DIR);
}

function draftsDir(userData: string): string {
  return path.join(userData, DRAFTS_DIR);
}

function legacyDir(userData: string): string {
  return path.join(userData, LEGACY_DIR);
}

function migrationReportPath(userData: string): string {
  return path.join(userData, MIGRATION_REPORT_FILE);
}

/** 解析书源文件绝对路径；sourceDir 必须绝对路径 */
export function resolvePath(
  userData: string,
  fileName: string,
  sourceDir: string | null | undefined,
): string | null {
  const safe = safeFileName(fileName);
  if (!safe) return null;
  if (sourceDir) {
    if (!path.isAbsolute(sourceDir)) return null;
    return path.join(sourceDir, safe);
  }
  return path.join(primaryDir(userData), safe);
}

/** 解析目录：sourceDir 必须绝对，主目录自动创建 */
export function resolveDir(userData: string, sourceDir: string | null | undefined): string | null {
  if (sourceDir) {
    if (!path.isAbsolute(sourceDir)) return null;
    return sourceDir;
  }
  const dir = primaryDir(userData);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readFileOrFail(p: string): string {
  if (!fs.existsSync(p)) {
    throw new Error(`文件不存在: ${p}`);
  }
  return fs.readFileSync(p, 'utf-8');
}

/** 删掉某源的两个启停 marker（幂等；失败只告警） */
function removeMarkers(filePath: string): void {
  for (const suffix of ['.enabled', '.disabled']) {
    const m = filePath + suffix;
    if (!fs.existsSync(m)) continue;
    try {
      fs.rmSync(m, { force: true });
    } catch (e) {
      console.warn(`[booksource] 清理 marker ${path.basename(m)} 失败（可能有残留）:`, e);
    }
  }
}

/**
 * 把一个文件移进 `booksources_legacy/`，跨文件系统时退回 copy + unlink
 *
 * `EXDEV` 不是边角情况：`sourceDir` 可以指向外部盘 / 网络盘（外部目录导入的书源会带着
 * 自己的 sourceDir 迁移），而 legacy 目录恒在 userData 下，跨卷 rename 必失败。
 * 顺序保证「副本完整落盘前绝不 unlink 源文件」—— 源文件丢了就是用户数据丢了。
 *
 * **返回成败而不直接抛**（外部评审 R1）：两个调用点对"归档失败"的处置必须相反 ——
 * · `archive`（needs-manual，**什么都没落盘**）：失败必须抛。源文件留在原处、状态未变，
 *   吞掉的话渲染端会把它记成"已归档"，而 needs-manual 清单是扫 `booksources_legacy/`
 *   得出的 —— 用户收到一句"这个源需要手动处理"，列表里却**根本找不到它**。
 * · `convert`（`.json` **已落盘成功**）：失败只 warn。这里抛会把一次**可用**的迁移
 *   报成 failed，而 `.js` 残留会在下次启动因"同 uuid 的 JSON 已存在"被判 skip，
 *   于是这条源永远停在 failed 上 —— 把一个自愈的小问题变成永久噪声。
 */
function moveToLegacy(
  src: string,
  dest: string,
  label: string,
): { ok: true } | { ok: false; error: string } {
  try {
    fs.renameSync(src, dest);
    return { ok: true };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') {
      return { ok: false, error: `${label}: ${(e as Error).message}` };
    }
  }
  try {
    fs.copyFileSync(src, dest);
    fs.unlinkSync(src);
    return { ok: true };
  } catch (copyErr) {
    // 源文件仍在原处（copy 失败时 unlink 不会执行），数据不丢
    return { ok: false, error: `${label}（跨盘）: ${(copyErr as Error).message}` };
  }
}

export function registerBookSourceHandler(ipcMain: IpcMain, userData: string): void {
  fs.mkdirSync(primaryDir(userData), { recursive: true });
  fs.mkdirSync(draftsDir(userData), { recursive: true });

  ipcMain.handle('pom:booksource-list', () => scanAllSources(primaryDir(userData)));

  // 流式列表：立刻返回，setImmediate 后台扫描 + 分批推送到 renderer（ASSUMPTION-15）
  // Round 2 修复：app.emit 不能跨进程，必须用 event.sender.send + isDestroyed 检查
  ipcMain.handle('pom:booksource-list-streaming', (e, requestId: string) => {
    const dir = primaryDir(userData);
    const sender = e.sender;
    const send = (payload: Record<string, unknown>): void => {
      if (sender.isDestroyed()) return;
      try {
        sender.send('pom:booksource-batch', payload);
      } catch {
        /* 窗口已销毁 */
      }
    };
    setImmediate(() => {
      try {
        const items = scanAllSources(dir);
        const total = items.length;
        for (let i = 0; i < items.length; i += BATCH_SIZE) {
          send({ requestId, items: items.slice(i, i + BATCH_SIZE), done: false, total });
        }
        send({ requestId, items: [], done: true, total });
      } catch (err) {
        send({
          requestId,
          items: [],
          done: true,
          total: 0,
          error: (err as Error).message,
        });
      }
    });
  });

  ipcMain.handle('pom:booksource-read', (_e, fileName: string, sourceDir?: string) => {
    const p = resolvePath(userData, fileName, sourceDir);
    if (!p) throw new Error('非法 fileName');
    return readFileOrFail(p);
  });

  ipcMain.handle(
    'pom:booksource-save',
    (_e, fileName: string, content: string, sourceDir?: string) => {
      const dir = resolveDir(userData, sourceDir);
      if (!dir) throw new Error('sourceDir 必须是绝对路径');
      const safe = safeFileName(fileName);
      if (!safe) throw new Error('非法 fileName');
      fs.mkdirSync(dir, { recursive: true });
      atomicWrite(path.join(dir, safe), content);
    },
  );

  ipcMain.handle('pom:booksource-delete', (_e, fileName: string, sourceDir?: string) => {
    const p = resolvePath(userData, fileName, sourceDir);
    if (!p) throw new Error('非法 fileName');
    if (fs.existsSync(p)) fs.unlinkSync(p);
    for (const suffix of ['.enabled', '.disabled']) {
      const m = p + suffix;
      if (fs.existsSync(m)) fs.unlinkSync(m);
    }
  });

  ipcMain.handle(
    'pom:booksource-toggle',
    (_e, fileName: string, enabled: boolean, sourceDir?: string) => {
      const dir = resolveDir(userData, sourceDir);
      if (!dir) throw new Error('sourceDir 必须是绝对路径');
      const safe = safeFileName(fileName);
      if (!safe) throw new Error('非法 fileName');
      const full = path.join(dir, safe);
      if (isJsonSourceName(safe)) {
        // JSON：启停在文档内 `enabled` 字段 → 读改写（仍走 atomicWrite，失败不截断原文件）。
        // 刻意的取舍：JSON 侧**不**另立 marker 文件 —— 迁移后 `.js` 会被移走，
        // marker 与源文件分家正是"改了一个另一个没跟着变"的来源。
        if (!fs.existsSync(full)) throw new Error(`书源文件不存在: ${safe}`);
        const raw = fs.readFileSync(full, 'utf-8');
        let doc: unknown;
        try {
          doc = JSON.parse(raw);
        } catch (e) {
          // 坏 JSON 上做启停：宁可报"改不了"，也不要静默用 `{}` 覆盖用户的整份文档
          throw new Error(`书源 ${safe} 不是合法 JSON，无法切换启用状态: ${(e as Error).message}`);
        }
        if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
          throw new Error(`书源 ${safe} 顶层不是对象，无法切换启用状态`);
        }
        const next = { ...(doc as Record<string, unknown>), enabled };
        // 2 空格缩进 + 结尾换行：与编辑器保存格式一致，避免无意义的整文件 diff
        atomicWrite(full, JSON.stringify(next, null, 2) + '\n');
        return;
      }
      const enabledMarker = path.join(dir, safe + '.enabled');
      const disabledMarker = path.join(dir, safe + '.disabled');
      // ⚠️ 顺序：**先写后删对立的那个**，不能"先把两个都删了再写"。
      // 两个 marker 都不存在 = 走 header 的 `@enabled` 或缺省 true，也就是"启用"。
      // 所以"先删后写 + 写失败"会让用户**明确禁用过的源静默变回启用**（状态反转，用户不知情）。
      // 先写：写失败 → 抛错，原 marker 完好，状态不变。
      atomicWrite(enabled ? enabledMarker : disabledMarker, '');
      // 写成功后才清理对立的（`rmSync(force)` 而非 `existsSync+unlink`：
      // 避免"检查后再删"之间文件被外部动过而抛 ENOENT）。
      // 删除失败只留下两个 marker 并存 —— `scanDir` 里 `.disabled` 优先于 `.enabled`，
      // 结果是"源仍显示为禁用"，可见且用户再点一次即可自愈，不会静默反转。
      try {
        fs.rmSync(enabled ? disabledMarker : enabledMarker, { force: true });
      } catch (e) {
        console.warn(`[booksource] 清理 ${safe} 的旧 marker 失败（可能有残留，不影响源本身）:`, e);
      }
    },
  );

  /**
   * 书源草稿（`<userData>/booksources_drafts/`）
   *
   * **只收 `.json`**（方案 §3.1「草稿换 JSON 格式」，实施计划 3.5）：草稿目录与主目录
   * 是同一种东西 —— 规则文档，不再是 JS 源码。留着 `.js` 入口的话，将来「保存草稿」
   * 按钮上线时会自然写出 `.js`，于是这个目录里出现两套格式且没有任何工具能读后者。
   *
   * ⚠️ 截至 2026-09-29 渲染端**零调用方**（`rg "saveDraft|drafts" src/` 无命中），
   * 所以"同步换格式"这件事当下没有存量 `.js` 草稿要迁 —— 本次改的是**新写入的口径**。
   * 通道本身保留（预留给后续的草稿功能），不按死代码删：它是一个已实现的存储原语，
   * 删掉只会在下次要加草稿按钮时让人重写一遍。
   */
  ipcMain.handle('pom:booksource-save-draft', (_e, fileName: string, content: string) => {
    const safe = safeFileName(fileName);
    if (!safe) throw new Error('非法 fileName');
    if (!safe.toLowerCase().endsWith('.json')) throw new Error('草稿只接受 .json 规则文档');
    const dir = draftsDir(userData);
    fs.mkdirSync(dir, { recursive: true });
    atomicWrite(path.join(dir, safe), content);
  });

  // 书源 HTTP 代理（沙箱 legado.http 走这里）
  ipcMain.handle(
    'pom:booksource-http-proxy',
    async (
      _e,
      request: {
        url: string;
        method?: string;
        headers?: Record<string, string>;
        body?: string | null;
      },
    ) => {
      const doRequest = () =>
        safeNetRequest(request.url, {
          method: request.method,
          headers: request.headers,
          body: request.body ?? null,
          timeoutMs: HTTP_TIMEOUT_MS,
          accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
        });
      let result = await doRequest();
      let challenged = isCfChallenge(result.status, result.headers, result.body.slice(0, 4096));
      // Tier 1：CF 挑战 → 隐藏窗口真实加载 + 提取 HTML（仅对 GET 类页面有意义；
      // POST 表单/带 body 的接口跳过，自动让 Tier 2 弹窗引导）
      if (challenged && (!request.method || request.method === 'GET') && !request.body) {
        const html = await cfFetchHtmlHidden(request.url);
        if (html) {
          result = {
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
            body: html,
            bytes: Buffer.from(html, 'utf8'),
          };
          challenged = false;
        }
      }
      // 仍是挑战（交互式 Turnstile）：标记 cfChallenge，由渲染端引导用户人工过盾（Tier 2）
      return {
        status: result.status,
        headers: result.headers,
        body: result.body,
        ...(challenged ? { cfChallenge: true } : {}),
      };
    },
  );

  // ── JSON 规则书源（计划 §3.4 / 实施计划 2.2） ─────────────────────────

  /**
   * `convert` 把一个旧 `.js` 书源转成 `.json` 并**移走** `.js`
   *
   * 迁移由渲染端执行（规则解析是纯函数，主进程不能 import `src/`，见 D4/D8），
   * 主进程只负责**落盘**这一侧必须做对的事：原子写 + 移走源文件 + 拒绝覆盖。
   *
   * 不覆盖既有 `.json`：同 uuid 重复转入会静默覆盖用户已编辑过的规则。
   */
  safeHandleWithMeta(
    ipcMain,
    'pom:booksource-convert',
    'BooksourceConvertArgsSchema',
    BooksourceConvertArgsSchema,
    (_e, args) => {
      // v.tuple 的输出就是位置数组，故按数组解构（safeHandle 收的是 args 数组）
      const [jsFileName, json, sourceDir] = args;
      const dir = resolveDir(userData, sourceDir);
      if (!dir) throw new Error('sourceDir 必须是绝对路径');
      const safeJs = safeFileName(jsFileName);
      if (!safeJs) throw new Error('非法 jsFileName');
      if (!safeJs.toLowerCase().endsWith('.js')) throw new Error('convert 只接受 .js 源文件');
      const jsonPath = path.join(dir, safeJs.replace(/\.js$/i, '.json'));
      if (fs.existsSync(jsonPath)) {
        throw new Error(`目标已存在，拒绝覆盖: ${path.basename(jsonPath)}`);
      }
      // 先校验再落盘：坏 JSON 进了 booksources/ 会污染列表
      let parsed: unknown;
      try {
        parsed = JSON.parse(json);
      } catch (e) {
        throw new Error(`转换结果不是合法 JSON: ${(e as Error).message}`);
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('转换结果顶层不是对象');
      }
      const doc = parsed as Record<string, unknown>;
      if (doc.format !== JSON_SOURCE_FORMAT) {
        throw new Error(`转换结果 format 必须是 ${JSON_SOURCE_FORMAT}`);
      }
      // 信封校验**必须在落盘与归档之前**：只查 format 的话，一份缺 `rules.searchPath`
      // 的文档也会被写进 booksources/ 并把可用的 `.js` 移走 —— 源没丢（还在 legacy 目录），
      // 但用户看到的是"迁完了却不能用，且没人告诉他去哪儿捞回来"，这比不迁更糟。
      const envelopeError = jsonEnvelopeError(parsed);
      if (envelopeError) {
        throw new Error(`转换结果信封校验失败，拒绝写入: ${envelopeError}`);
      }
      atomicWrite(jsonPath, JSON.stringify(doc, null, 2) + '\n');
      // 写成功才移走源文件（顺序反了会在写失败时把用户源搞丢）
      const jsPath = path.join(dir, safeJs);
      if (fs.existsSync(jsPath)) {
        fs.mkdirSync(legacyDir(userData), { recursive: true });
        const moved = moveToLegacy(jsPath, path.join(legacyDir(userData), safeJs), safeJs);
        // `.json` 已经落盘且可用，这里**不抛**（见 moveToLegacy 的注释）：
        // 抛了会把一次可用迁移报成 failed，而 `.js` 残留会在下次启动被判 skip，
        // 于是这条源永远停在 failed 上。
        if (!moved.ok) {
          console.warn(
            `[booksource] 归档 ${safeJs} 失败（.json 已写入，不影响可用性；.js 仍在原目录）:`,
            moved.error,
          );
        }
      }
      // 启停状态已经内联进 doc.enabled，marker 必须跟着消失：留着就成无主文件，
      // 而 toggle / delete 的 `p + suffix` 清理路径会误伤同名 `.json` 的状态
      // （`foo.js.enabled` 存在时用户再 toggle `foo.json`，两套状态各说各话）。
      removeMarkers(jsPath);
      return path.basename(jsonPath);
    },
  );

  /**
   * needs-manual 源：只把 `.js` 归档，**不产 JSON**
   *
   * 迁移判定在渲染端（规则解析是纯函数，主进程不能 import `src/`，见 D4/D8），
   * 这里是它的 IO 侧。marker 一并搬走：needs-manual 源在 legacy 目录里必须
   * 仍带着自己的启停状态，否则回滚 JS 链路后行为与迁移前不一致。
   */
  safeHandleWithMeta(
    ipcMain,
    'pom:booksource-archive',
    'BooksourceArchiveArgsSchema',
    BooksourceArchiveArgsSchema,
    (_e, args) => {
      const [jsFileName, , sourceDir] = args;
      const dir = resolveDir(userData, sourceDir);
      if (!dir) throw new Error('sourceDir 必须是绝对路径');
      const safe = safeFileName(jsFileName);
      if (!safe) throw new Error('非法 jsFileName');
      if (!safe.toLowerCase().endsWith('.js')) throw new Error('archive 只接受 .js 源文件');
      const jsPath = path.join(dir, safe);
      if (!fs.existsSync(jsPath)) {
        throw new Error(`待归档文件不存在: ${safe}`);
      }
      fs.mkdirSync(legacyDir(userData), { recursive: true });
      // 这里**必须抛**：什么都没落盘，源文件留在原处、状态未变。吞掉的话渲染端会把它
      // 记成"已归档"，而 needs-manual 清单是扫 `booksources_legacy/` 得出的 ——
      // 用户收到一句"这个源需要手动处理"，列表里却根本找不到它。
      const movedFile = moveToLegacy(jsPath, path.join(legacyDir(userData), safe), safe);
      if (!movedFile.ok) throw new Error(`归档 ${safe} 失败: ${movedFile.error}`);
      for (const suffix of ['.enabled', '.disabled']) {
        const m = path.join(dir, safe + suffix);
        if (!fs.existsSync(m)) continue;
        const movedMarker = moveToLegacy(
          m,
          path.join(legacyDir(userData), safe + suffix),
          safe + suffix,
        );
        if (!movedMarker.ok) {
          // 源文件已经搬走了，此时抛错等于告诉渲染端"什么都没做" —— 只告警
          console.warn(`[booksource] marker ${safe + suffix} 归档失败:`, movedMarker.error);
        }
      }
      return safe;
    },
  );

  /**
   * 迁移报告：读一次即删
   *
   * 落盘而不是直接 IPC 返回，是因为迁移发生在 APP_INITIALIZER（可能早于管理页打开），
   * 那时没有订阅方 —— 落盘让报告不会丢，渲染端下次进管理页再取。
   */
  ipcMain.handle('pom:booksource-migration-report-read', () => {
    const p = migrationReportPath(userData);
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, 'utf-8');
    try {
      fs.unlinkSync(p);
    } catch (e) {
      console.warn('[booksource] 删除迁移报告失败（下次会重复读到同一份）:', e);
    }
    try {
      return JSON.parse(raw);
    } catch {
      // 坏报告也必须是**同一种形状**（渲染端按 MigrationReport 读，无第二套解析）。
      // 早期这里返回 `{needsManual: true, failed:[{fileName, error}]}`：字段名与形状都
      // 和正常报告不同，渲染端要么崩要么显示空 —— 这正是"坏路径返回另一种形状"的典型代价。
      return {
        at: new Date().toISOString(),
        converted: [],
        needsManual: [],
        failed: [{ fileName: '迁移报告本身', reason: '报告不是合法 JSON，请检查用户数据目录' }],
        skipped: 0,
      };
    }
  });

  ipcMain.handle('pom:booksource-migration-report-write', (_e, report: unknown) => {
    atomicWrite(migrationReportPath(userData), JSON.stringify(report, null, 2) + '\n');
  });

  /**
   * 旧 `.js` 书源清单（归档目录）
   *
   * 迁移完成后主目录里已无 `.js`，但用户要能"看迁走了什么、还能不能回退"，
   * 所以归档目录要可扫（列表页只读，不参与匹配）。
   */
  ipcMain.handle('pom:booksource-legacy-list', () => scanDir(legacyDir(userData)));
}
