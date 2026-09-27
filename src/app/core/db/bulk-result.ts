/**
 * PouchDB bulkDocs 错误分类工具（EVO-2）
 *
 * 集中处理 bulkDocs 返回的 `Array<Response | Error>` 错误分类语义：
 * - 409 conflict（_rev 过期）：
 *   - 创建/更新操作 → 视业务决定：默认幂等成功（migrateLegacyChapterIds / chapterPutMany 创建场景）
 *   - 删除操作 → 实际未删除，记录 warning，下一次重试自然清理（chapterPutMany 删除 orphans 场景）
 * - 其它错误 → 致命失败，必须抛出（不可静默）
 *
 * 历史：原本散落在 db.service.ts 的 `migrateLegacyChapterIds` 与 `chapterPutMany` 中，
 * 各自用 `results.filter(...)` + 不同语义判断；抽到此处统一调用。
 */
import type PouchDB from 'pouchdb-browser';

export interface ClassifiedBulkResult {
  /** 致命错误（非 409），必须抛出 */
  fatal: PouchDB.Core.Error[];
  /** 409 冲突：默认归类为「幂等成功 / 接受 warning」 */
  conflicts: PouchDB.Core.Error[];
  /** 成功的响应数量 */
  succeeded: number;
  /** 总数（succeeded + fatal + conflicts） */
  total: number;
}

/**
 * 分类 bulkDocs 返回结果。
 *
 * @param results - PouchDB bulkDocs 返回的 `Array<Response | Error>`
 * @param opts.conflictAsConflict - false（默认）= 409 视为幂等成功；true = 409 视为冲突（caller 自行处理）
 */
export function classifyBulkResults(
  results: ReadonlyArray<PouchDB.Core.Response | PouchDB.Core.Error>,
  opts: { conflictAsConflict?: boolean } = {},
): ClassifiedBulkResult {
  let succeeded = 0;
  const fatal: PouchDB.Core.Error[] = [];
  const conflicts: PouchDB.Core.Error[] = [];

  for (const r of results) {
    if (!('error' in r)) {
      succeeded++;
      continue;
    }
    if (r.status === 409) {
      if (opts.conflictAsConflict) {
        conflicts.push(r);
      }
      // else: 409 视为幂等成功（默认场景：migrateLegacyChapterIds / 创建型 bulkDocs）
      continue;
    }
    fatal.push(r);
  }

  return { fatal, conflicts, succeeded, total: results.length };
}

/**
 * 构造 bulkDocs 致命错误的统一异常消息（与 db.service.ts 原措辞保持一致）。
 */
export function formatBulkFatalMessage(
  op: string,
  classified: ClassifiedBulkResult,
): string {
  const detail = classified.fatal
    .map((f) => `${f.id ?? '?'}[${f.name ?? f.status ?? '?'}]`)
    .join(', ');
  return `${op} failed (${classified.fatal.length}/${classified.total}): ${detail}`;
}