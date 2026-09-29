# T-12 书源导入 / 导出 / 订阅 bundle 实施

> 状态：**Done（2026-09-30 完成）** · 创建：2026-09-30
> 设计依据：[2026-09-28-BOOKSOURCE_IMPORT_EXPORT_DESIGN.md](../../Architecture/2026-09-28-BOOKSOURCE_IMPORT_EXPORT_DESIGN.md)（2026-09-29 已按 JSON 契约修订）
> 上游跟踪：[BOOKSOURCE_JSON_RULES_FOLLOWUPS.md](../../Active/BOOKSOURCE_JSON_RULES_FOLLOWUPS.md) T-12 / T-15
> 分支：`feat/booksource-json-rules`（随主方案同分支推进）

## 范围

按设计文档 §10 分两期：

- **Phase 1（备份还原，独立可用）**：bundle 纯函数内核 + IPC handler + preload 通道 + 导入/导出弹窗 + 列表页按钮 + `pom:booksource-updated` 刷新
- **Phase 2（订阅自动更新）**：订阅状态文件 + 主进程调度 + 订阅管理弹窗（T-15 分享/订阅的落地点）

## 与设计的落地偏差（实施时确认）

- 纯函数内核放 `electron/ipc/booksource-bundle.ts`（与 `booksource-meta.ts` 同目录；仓内无 `electron/shared/`，不为单文件新造目录）。

## 验收

- [x] Phase 1：导出勾选调源 → 单文件 bundle；导入解析 → 分类预览 → 应用落盘；`parseBundle` 整体拒绝恶意/损坏 bundle；单测覆盖设计 §9 表格
- [x] Phase 2：订阅 CRUD + 到期调度 + `applied` 基线冲突判定 + 失败不阻断同跳其他订阅
- [x] `npx vitest run` 全绿、双 tsconfig tsc 0 错误、`npm run build` 成功、`npm run format:check` 过
- [x] 文档同步：CHANGELOG / README 结构树（如有目录变化）/ CONVENTIONS 留痕（如需）

## 完成记录（2026-09-30）

- Phase 1：`16f3666`（后端）/ `4069bc8`（前端）；Phase 2：`0c5f759`（后端）/ `1edd378`（前端）；冲突判定方向修正：`24e5a7e`。
- 落地追加偏差：open 通道返回 `{ error, entries }` 单对象；`readLocalSources` 上移至 `booksource-meta.ts`；diffBundle baseline 分支曾误比远端 hash，已在 `24e5a7e` 修为比本地 hash（设计 §6.2 措辞同步更正）。
- 已知留白：冲突解决 UI 未做（设计未定义）；立即检查 toast 与广播 toast 可能双弹（未做抑制）。
