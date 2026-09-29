/**
 * 存量 `.js` 书源迁移的**编排 + IO**（书源 JSON 规则化 P3.1）
 *
 * 判定逻辑全在 `core/logic/rule-migrate.ts`（纯函数，可单测）；本服务只做三件事：
 * 读列表 → 逐个读全文并判定 → 按判定调 `convert` / `archive` 落盘，最后写一份报告。
 *
 * ## 为什么不放主进程
 *
 * 方案 D4：主进程 `tsc` 的 `rootDir` 锁死 `electron/`、`exclude: ["../src"]`，
 * import `src/` 的规则解析器会报 `TS6059`，且 tsc 会无视 `--noEmit` 把被拉入的文件
 * 就地输出到 `src/`（落地污染 + 会被误提交）。故主进程只提供 IO channel。
 *
 * ## 时机：串在书源加载**之前**，而不是单独挂一个 APP_INITIALIZER
 *
 * Angular 的 `ApplicationInitStatus.runInitializers` 是 `Promise.all` ——
 * 多个 `APP_INITIALIZER` 按注册顺序**同步调用**但**并发等待**（见
 * `node_modules/@angular/core/fesm2022/_debug_node-chunk.mjs` 的 `runInitializers`）。
 * 单独挂一个迁移 initializer 的话，`loadAllJsAdapters` 可能在迁移落盘前就去读列表，
 * 于是 registry 装的是**迁移前**的源（既有 `.js` 适配器，又有转换后的 `.json`）——
 * 症状是"首启搜索不到某些书源，重启一次又好了"。
 * 故迁移由 `app.config.ts` 的 `initBookSources` 在**同一函数内串行 await**（见 D11）。
 *
 * ## 失败只告警不阻断启动
 *
 * 迁移失败 = 保留旧 `.js` 继续用，用户顶多多看到一行标灰；启动失败 = 应用打不开。
 * 两者代价差着量级，故本服务内部吞掉全部错误，只 `console.warn`。
 */
import { Injectable } from '@angular/core';
import {
  isEmptyReport,
  migrateJsSource,
  normalizeLegacyMeta,
  type MigrationItem,
  type MigrationReport,
} from '../logic/rule-migrate';
import { serializeSourceDoc } from '../logic/source-doc-build';

@Injectable({ providedIn: 'root' })
export class BookSourceMigrateService {
  /** 同一次启动只跑一遍（`initBookSources` 之外若还有别的入口调它也不重复迁移） */
  private started = false;
  private lastReport: MigrationReport | null = null;

  /**
   * 扫 `booksources/` 下的存量 `.js`，逐个判定并落盘
   *
   * @returns 报告；**无任何变更时返回 null**（此时不写报告文件，免得每次启动都动盘）
   */
  async migrate(): Promise<MigrationReport | null> {
    if (this.started) return this.lastReport;
    this.started = true;

    const report: MigrationReport = {
      at: new Date().toISOString(),
      converted: [],
      needsManual: [],
      failed: [],
      skipped: 0,
    };

    const api = typeof window !== 'undefined' ? window.pomAPI : undefined;
    // 浏览器 dev（ng serve）没有 preload 通道：直接跳过，不要因此报错
    if (!api?.booksourceList || !api.booksourceRead || !api.booksourceConvert) {
      return null;
    }

    try {
      const list = await api.booksourceList();
      const { jsMetas, jsonUuids } = partitionSources(list);
      if (jsMetas.length === 0) return null;

      for (const raw of jsMetas) {
        try {
          await this.migrateOne(raw, jsonUuids, report);
        } catch (e) {
          // 单个源失败绝不能中断整批：剩下的源照样迁，失败的这条进报告。
          // 用**已归一过的** fileName 而不是回头再从 raw 取（外部评审 R1）：
          // 读文件阶段就抛错时那条路径根本没走到过 fileNameOf，回退值 '(未知文件)'
          // 会让报告里出现一条无法定位的记录。
          report.failed.push({
            fileName: normalizeLegacyMeta(raw).fileName || '(未知文件)',
            reason: reasonOf(e),
          });
        }
      }
    } catch (e) {
      console.warn('[booksource-migrate] 迁移中止（存量 .js 保持原样，继续可用）:', e);
      return null;
    }

    if (isEmptyReport(report)) return null;
    this.lastReport = report;
    try {
      await api.booksourceMigrationReportWrite?.(report);
    } catch (e) {
      // 报告写不下去只影响"弹窗汇总"，needs-manual 清单另有常驻通道（booksourceLegacyList）
      console.warn('[booksource-migrate] 写迁移报告失败:', e);
    }
    return report;
  }

  private async migrateOne(
    raw: unknown,
    jsonUuids: Set<string>,
    report: MigrationReport,
  ): Promise<void> {
    const api = window.pomAPI!;
    const meta = normalizeLegacyMeta(raw);
    const sourceDir = sourceDirOf(raw) ?? undefined;
    const content = await api.booksourceRead!(meta.fileName, sourceDir);
    const result = migrateJsSource({
      fileName: meta.fileName,
      content,
      meta,
      existingUuids: jsonUuids,
    });

    if (result.outcome === 'skip') {
      report.skipped++;
      return;
    }
    if (result.outcome === 'needs-manual') {
      // 归档而非丢弃：`.js` 进 `booksources_legacy/`，用户仍能在列表页看到并捞回
      await api.booksourceArchive?.(meta.fileName, result.item.reason, sourceDir);
      report.needsManual.push(result.item);
      return;
    }
    await api.booksourceConvert!(meta.fileName, serializeSourceDoc(result.doc), sourceDir);
    report.converted.push(result.item);
    // 同一批里两个 `.js` 撞同一个 uuid：后者降级为 skip，而不是覆盖先迁出来的文档
    jsonUuids.add(result.doc.uuid);
  }

  /**
   * 读一次迁移报告（主进程侧"读即删"）
   *
   * 列表页用它在首次进入管理页时弹一次汇总。坏形状的报告退化成"只有 failed"的一份，
   * 不抛 —— 弹窗是锦上添花，不能因为它把管理页搞崩。
   */
  async readReport(): Promise<MigrationReport | null> {
    const api = typeof window !== 'undefined' ? window.pomAPI : undefined;
    if (!api?.booksourceMigrationReportRead) return null;
    try {
      const raw = await api.booksourceMigrationReportRead();
      if (!raw || typeof raw !== 'object') return null;
      return normalizeReport(raw);
    } catch (e) {
      console.warn('[booksource-migrate] 读迁移报告失败:', e);
      return null;
    }
  }
}

/** 把 IPC 回来的列表拆成「待迁移的 `.js`」与「已存在的 JSON uuid 集合」 */
function partitionSources(list: unknown): {
  jsMetas: unknown[];
  jsonUuids: Set<string>;
} {
  const jsMetas: unknown[] = [];
  const jsonUuids = new Set<string>();
  const items = Array.isArray(list) ? list : [];
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    const rec = raw as Record<string, unknown>;
    // `format: 'json'` 是 `parseJsonMeta` 加的**新增**字段（`baseJsonMeta`），
    // 用它分派而不是猜后缀 —— `.json` 源也可能带 marker 时代的残留文件
    if (rec['format'] === 'json') {
      const uuid = rec['uuid'];
      if (typeof uuid === 'string' && uuid) jsonUuids.add(uuid);
      continue;
    }
    if (typeof rec['fileName'] === 'string' && rec['fileName'].toLowerCase().endsWith('.js')) {
      jsMetas.push(raw);
    }
  }
  return { jsMetas, jsonUuids };
}

/** 报告归一：主进程已保证形状一致，这里只防"未来新增字段 / 外部改动"导致的崩 */
export function normalizeReport(raw: unknown): MigrationReport {
  const rec = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    at: typeof rec['at'] === 'string' ? rec['at'] : '',
    converted: itemsOf(rec['converted']),
    needsManual: itemsOf(rec['needsManual']),
    failed: itemsOf(rec['failed']),
    skipped: typeof rec['skipped'] === 'number' ? rec['skipped'] : 0,
  };
}

function itemsOf(raw: unknown): MigrationItem[] {
  if (!Array.isArray(raw)) return [];
  const out: MigrationItem[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const fileName = rec['fileName'];
    if (typeof fileName !== 'string' || !fileName) continue;
    const jsonFileName = rec['jsonFileName'];
    out.push({
      fileName,
      reason: typeof rec['reason'] === 'string' ? rec['reason'] : '',
      ...(typeof jsonFileName === 'string' && jsonFileName ? { jsonFileName } : {}),
    });
  }
  return out;
}

function sourceDirOf(raw: unknown): string | null {
  const rec = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return typeof rec['sourceDir'] === 'string' && rec['sourceDir'] ? rec['sourceDir'] : null;
}

function reasonOf(e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e) {
    return String((e as { message: unknown }).message);
  }
  return String(e);
}
