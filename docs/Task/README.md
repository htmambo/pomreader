# Task Index

> 本仓库为 `pomreader` 独立项目仓库（2026-09-25 从父仓 `pomreader` 拆分）。
> 父仓（白虎阅读 macOS DMG Linux 重打包）的任务历史已迁移至父仓 `docs/Task/`。

## Active Tasks

- 📋 [依赖大版本升级（Angular 18→22 + 测试工具链）](Active/POMREADER_DEP_MAJOR_UPGRADE_PLAN.md) — 🔄 In progress 2026-09-28
  - Phase 0：@types/node→24 / jsdom→30 / vitest→3.2 / puppeteer-core→25 / engines 收紧（不依赖 Angular）—— ✅ **全部 6 项收口**
    - P0-0 CI Node 20→24 + `.npmrc` engine-strict / P0-1 @types/node 24.19.0 / P0-2 jsdom 30.1.1 / P0-3 vitest 3.2.7（覆盖率新基线 74.96/81.91/83.14/74.96）/ P0-4 puppeteer-core 25.12.0（`require(esm)` 实测可用，`.cjs` 无需改写）/ P0-5 `engines` 字段
    - 顺带修复 `worker-pool.spec.ts` 的既有 unhandled rejection（vitest 3 起会升级为失败）；4 个脚本 `headless: 'new'` → `true`（v25 类型契约变更，运行时等价）
    - 外部审核 Round 1/5 NEEDS_CHANGES → Round 2/5 APPROVED（三条 risk 均以证据驳回，代码零改动）
    - 遗留人工复核 2 项：reader 页 `.html` 重排后的渲染目视、5 个 `.cjs` 冒烟脚本在有 Chrome 的机器上实跑
  - Phase 1：Angular 18 → 19 — ✅ **完成**，六门全绿 + **e2e 首次实跑 19/19**
    - 版本：Angular 19.2.25 / ng-zorro 19.3.1 / icons-angular 19.0.0 / angular-eslint 19.8.1 / zone.js 0.15.1；TS 保持 5.5.2
    - 修正计划 3 处前提：① 顺序必须 Angular 核心先走（否则 ERESOLVE）；② 35 处 `<span nz-icon>` 的 schematic 迁移**根本不存在**，且经查证无需迁移（v19 属性形态与 inputs 均保留）；③ bundle 预算告警是既有问题（基线 1.77 MB → 现 1.82 MB）
    - icons-angular 必须显式升，否则装出双份导致图标静默失效
  - Phase 2：Angular 19 → 20 — ✅ **完成**，六门全绿 + e2e **19/19 首跑即绿**
    - 版本：Angular 20.3.32 / ng-zorro 20.4.4 / icons-angular 20.0.0 / angular-eslint 20.7.0 / TS **5.8.3（被 compiler-cli@20 peer 强制）**
    - 构建器切至 `@angular/build`，`@angular-devkit/build-angular` 已移除，**`npm ls webpack` 为 `(empty)`**，lockfile 净减约 5400 行；删除 `extract-i18n` 死 target（用户拍板）
    - 抓出 3 件事：① builder 迁移的 schematic 借临时 CLI 22 写入了 `@angular/build@^22.2.0`，因 peer 标 `optional: true` 而 `npm ls` 漏报；② 切构建器暴露了 `pouchdb-browser` 未声明的**幽灵依赖 `events`**（一直由 webpack 顺带供养），已显式声明；③ angular-eslint 20 新增 `prefer-inject` 与项目 vitest 直实例化约定冲突，关闭该规则
    - `ngIf`/`ngFor` deprecated 清理**刻意推迟**到独立 commit
  - Phase 3：Angular 20 → 21 — ✅ **完成**，七门全绿 + e2e **19/19**
    - 版本：Angular 21.2.24 / ng-zorro 21.3.3 / icons-angular 21.0.0 / angular-eslint 21.4.0 / TS **5.9.3（被 compiler-cli@21 peer 强制）**
    - `*ngIf`/`*ngFor` → `@if`/`@for` 由 schematic 自动迁移 20 个组件（原计划「刻意推迟」的项被 ng update 顺带完成）
    - 抓出 5 件事：① **`ng update` 静默把 vitest 3→4**（超 Phase 5 范围，用户拍板接受并就地修 2 个 fixture）；② ng-zorro 21 删 `NzInputNumberLegacyModule`，一处误删被编译器 NG8002 抓回；③ TS 5.9 Buffer 泛型变体检查（13 个 electron 错误），单层 `as Uint8Array` 宽化断言解决；④ schematic 删 `tsconfig.lib` 属语义等价（`es2022.full` 含 dom）；⑤ vitest 4 AST 重映射致 branches 覆盖 75%→64.89%（测量修正非回归），阈值校准到 60 并加 `TODO(Phase 5)` 收紧锚点
  - Phase 4：Angular 21 → 22 + ng-zorro 跟随（TS pin ~6.0，严禁 7.x）
    - ⚠️ **Phase 4 起步前先手过一遍阅读页**：Phase 1 遗留的 effect() 时序风险至今未做人工目视复核，Phase 2/3 均未解决
  - Phase 5：vitest 4 稳定后评估 5 / @angular/build:unit-test、branches 覆盖率收紧回 ~70、zoneless 评估（收尾；vitest-4 部分已被 Phase 3 提前消化）

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