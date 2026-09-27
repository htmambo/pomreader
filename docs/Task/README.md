# Task Index

> 本仓库为 `pomreader` 独立项目仓库（2026-09-25 从父仓 `pomreader` 拆分）。
> 父仓（白虎阅读 macOS DMG Linux 重打包）的任务历史已迁移至父仓 `docs/Task/`。

## Active Tasks

- 📋 [依赖大版本升级（Angular 18→22 + 测试工具链）](Active/POMREADER_DEP_MAJOR_UPGRADE_PLAN.md) — Draft 2026-09-27
  - Phase 0：@types/node→24 / jsdom→30 / vitest→3.2 / puppeteer-core→25 / engines 收紧（不依赖 Angular）
  - Phase 1-4：Angular 逐级 18→19→20→21→22 + ng-zorro 跟随（TS pin ~6.0，严禁 7.x）
  - Phase 5：vitest 4/5 或 @angular/build:unit-test、zoneless 评估（收尾）

## Completed Tasks (Archive)

### 2026-09（独立仓库阶段）

#### 基础设施硬化（P1 + P2）

- ✅ [基础设施与文档治理硬化（P1 + P2）](Archive/2026-09/POMREADER_P1_P2_HARDENING_PLAN.md) — Completed 2026-09-27
  - P1：LICENSE (MIT) / CONTRIBUTING.md / CHANGELOG.md / ESLint 依赖补全 / dist-electron 文档化
  - P2：README EVO 锚点 / coverage 数据 / superpowers 链接 / e2e 验证 19/19
  - ESLint 启用配置 + i18n 实际翻译留待 v0.2.0 PR
  - 关键 commit：e012be3 / 73ff7b8 / ecb0a9b / 7c0027f

#### 架构演进（16 项）

- ✅ [技术演进与架构优化（16 项建议落地）](Archive/2026-09/POMREADER_ARCH_EVOLUTION_PLAN.md) — Completed 2026-09-27
  - P0（4 项关键技术债）：拆 BookRepository / DB IPC 优化 / Worker Pool / typed IPC schema
  - P1（5 项架构优化）：服务拆分收尾 / 测试覆盖扩展 / OnPush 100% / CI / e2e 统一
  - P2（4 项工程质量）：路由 + lazy load / project references / i18n 决策 / settings 拆分
  - P3（3 项长期演进）：PWA / 书源插件化 / 迁移框架
  - 全程 fullauto 协作：Phase 0 spec APPROVED + Phase 1 plan APPROVED + Phase 2 落地 + Phase 4 三评审收口
  - 外部审核 9 轮（Round 9 最终 APPROVED），过程发现 2 个真实 bug：safeHandle rest args + forTest stub getter 绑定

#### 历史归档（拆分前父仓记录）

- ✅ [pomreader Angular 仿写 + 行为级重写](Archive/2026-09/POMREADER_UI_CLONE_PLAN.md) — Completed 2026-09-24
  - 子项目 Angular 18 standalone + signals + ng-zorro 18；4 主路由 + 2 弹窗 + 1 抽屉 + 阅读设置
  - 3 个行为级重写算法（chapter-split ≥ 90% 测试 / theme-resolver / online-source-resolver mock）
  - 30/30 单测全绿；prod bundle 611 kB（远低于 1.5 MB 预算）
  - 3 reviewer 全 APPROVED（architect Round 1 / security Round 1 / code-reviewer Round 2）
  - 父设计稿：[2026-09-24-POMREADER_UI_CLONE_DESIGN.md v1.1](../Architecture/2026-09-24-POMREADER_UI_CLONE_DESIGN.md) Round 1 APPROVED

#### 独立仓库阶段归档

- ✅ [规范化与一致性整改（convention-normalize）](Archive/2026-09/CONVENTION_NORMALIZE_PLAN.md) — Completed & Archived 2026-09-27
  - 11 项不一致整改（P1 命名/模板/OnPush + P2 服务/dialog 归位 + P3 目录/格式 + P4 死代码/文档）
  - 14 个原子提交（CC-1..CC-14）+ 1 验证步骤（CC-15）
  - AGENTS.md (73 行 ≤ 80 硬上限) + docs/CONVENTIONS.md (298 行含 15 行 §exceptions 豁免表)
  - 4 个 source-* 重命名为 book-source-* (FR-1) + 3 个 file move + 5 个 template split + OnPush
  - 引入 .prettierrc + format/format:check scripts + Prettier devDependency
  - 全自动 /fullauto 端到端：Phase 0 spec APPROVED + Phase 1 plan APPROVED + Phase 2 14 CCs 完成 + Phase 3 QA 全绿

- ✅ [npm run dev 启动竞态 + watch 重建懒加载失败修复](Archive/2026-09/DEV_STALE_CHUNK_FIX_PLAN.md) — Completed & Archived 2026-09-27
  - 根因：`wait-on electron/www/browser/index.html` 命中上次构建残留 → Electron 加载旧 chunk → 本轮构建清空目录 → 懒加载 404
  - 修复 1：`dev` 脚本前置 `rm -rf electron/www`
  - 修复 2：development 配置 `outputHashing: "none"`
  - 修复 3：`src/main.ts` 监听 `unhandledrejection` 自动重试一次（10s 防死循环）

- ✅ [Book 源搜索桥接（导入搜索联动）](Archive/2026-09/BOOK_SOURCE_SEARCH_BRIDGE_PLAN.md) — Completed & Archived 2026-09-27
- ✅ [BookSource UUID 锚定与稳定性](Archive/2026-09/BOOK_SOURCE_UUID_ANCHOR_PLAN.md) — Completed & Archived 2026-09-27
- ✅ [封面颜色去除（封面生成器纯化）](Archive/2026-09/COVER_COLOR_REMOVAL_PLAN.md) — Completed & Archived 2026-09-27
- ✅ [IPC 循环依赖消除](Archive/2026-09/ELECTRON_IPC_CIRCULAR_DEP_PLAN.md) — Completed & Archived 2026-09-27
- ✅ [Legado 订阅源迁移到独立模块](Archive/2026-09/LEGADO_MIGRATION_PLAN.md) — Completed & Archived 2026-09-27
- ✅ [阅读器 ESC 键处理器](Archive/2026-09/READER_ESC_HANDLER_PLAN.md) — Completed & Archived 2026-09-27
- ✅ [Smart Add CSS 选择器实现](Archive/2026-09/SMART_ADD_CSS_SELECTOR_PLAN.md) — Completed & Archived 2026-09-27

> 命名说明：归档文件名沿用拆分时的 `POMREADER_UI_CLONE_PLAN.md`（已 completed 2026-09-24），未做追溯重命名以保留 git 历史可追溯性。