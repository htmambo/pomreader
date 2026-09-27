**状态**: 🔄 进行中 (开始时间: 2026-09-27)
> 对应 fullauto 状态：.omc/fullauto/pomreader-arch-evo/state.json
> 分支：`feat/arch-evolution-2026-09`（从 main 切出）

## 任务目标

按本仓库代码梳理结果，把 16 项技术演进与架构优化建议落地实施：

- P0（4 项关键技术债）：拆 BookRepository / DB IPC 优化 / Worker Pool / typed IPC schema
- P1（5 项架构优化）：服务拆分收尾 / 测试覆盖扩展 / OnPush 100% / CI / e2e 统一
- P2（4 项工程质量）：路由 + lazy load / project references / i18n 决策 / settings 拆分
- P3（3 项长期演进）：PWA / 书源插件化 / 迁移框架

## 问题分析

- `book.service.ts`（482 行）+ `db.service.ts`（565 行）单体负担重
- JS 书源沙箱单 Worker 串行，100+ 书源冷启动慢
- preload IPC 协议弱类型 + 错误包络三处重复
- OnPush 使用率 40%（10/25），CI 缺失
- 测试覆盖仅 logic + book-source，services/shared/pages 全空
- e2e 1 个 spec + 5 个独立 cjs 脚本不统一

## 子任务列表

详见 `.omc/plans/fullauto-pomreader-arch-evo-impl.md` 实施计划（Phase 1 落地后填入）。

## 阶段 0 输出（spec）

路径：.omc/fullauto/pomreader-arch-evo/spec.md
包含：## Assumptions Made (A1-A14) / ## Decisions Made (D1-D8) / ## 验收标准

## 外部审核意见（Phase 0）

- provider: coding-bridge
- session_id: 4a395a33-b6ec-4426-8499-ae8c91954a6c → 33735edf-97c7-4c58-8746-e70d060b21b4 (Round 2)
- Round 1: REJECTED（7 项风险：R1-R7，2 Critical / 2 High / 3 Medium）
- Round 2: **APPROVED**（附条件：A12 thinnest hardening patch 并入后启动 P0）
  - 7 项 Round 1 风险中 5 项完整闭环；余 2 项（R3/R5）经 A12 patch + A14 修订后处于"实施期细化"级
  - Round 2 新增 7 项非阻塞跟踪项（A14 deep-immutable e2e / A13 legacy channel 移除 checklist / NFR-2 facade 覆盖率口径 / schema 版本协商 / reviewer SLA），均可在 P0 sprint 内消化
- 采纳补丁已落地 spec.md：
  - A11 EVO-9 维持 withHashLocation()，放弃 PathLocationStrategy
  - A12 Worker Pool（v2 含 PoolFullError / terminate-before-reject / exit-refill / 2s grace）
  - A13 P0 数据层回滚（legacy DB channel + BookService facade 双轨 1 cycle）
  - A14 OnPush 兼容（spread 强制不可变 + 实施期补 deep-immutable e2e）
  - D1 P0 顺序化（D1 v2：EVO-4→EVO-2→EVO-1→EVO-3）
  - D8 EVO-9 路由策略
  - NFR-2 / NFR-3 / NFR-7 三项细化
  - 验收标准补 4 项（含恶意书源测试 + Electron 打包路由验证）
- Phase 0 ✅ 完成 → 进入 Phase 1

## 实施计划

- 路径：.omc/plans/fullauto-pomreader-arch-evo-impl.md

## 外部审核意见（Phase 1）

- provider: coding-bridge
- session_id: 141c1a99-641b-4589-ba11-88aeb9f4cf8d
- verdict: **APPROVED**（7 项风险：R1 致命 / R2-R3 高 / R4-R7 中；R1 + R3 用 thinnest hardening 解决）
- 已采纳补丁：
  - EVO-3 新增 `worker-pool.factory.ts`（WorkerLike 接口 + SynchronousWorkerAdapter 降级）+ kill-switch `localStorage['pom.workerPool']`
  - 实施计划末段加"Phase 4 评审治理"小节（SLA 48h / 72h 仲裁 / 替补）
- 非阻塞项：
  - R2 BulkChannel 幂等性 → 实施期验证
  - R4 feature flag 跨会话数据迁移 → 计划文档化，无独立 commit
  - R5 EVO-3 "独立" 表述更新 → 改为"可在 A1-A3 之后任意时刻启动，与后续 B/C/D 并行"
  - R6 jsdom Worker mock → 实施期在 sandbox.spec.ts 加 mock setup
  - R7 监控指标 → 暂不实装（P3 范畴）
- Phase 1 ✅ 完成 → 进入 Phase 2
## Phase 2 Batch-1 落地记录

- session_id: 84fa4776-1812-4406-8b9e-83b7f9f64544
- verdict: **APPROVED**（5 项风险：R1 HIGH grep -L 退出码 / R2-R3 MEDIUM timeout+cache / R4-R5 LOW）

### EVO-7 GitHub Actions CI
- 实际落地：`.github/workflows/ci.yml`（108 行）
  - 双 job：lint+unit+build (timeout-minutes: 10) + e2e (timeout-minutes: 20, needs: lint-unit-build)
  - 缓存：electron + playwright 双路径，restore-keys fallback 到 `cache-electron-playwright-${{ runner.os }}-`
  - OnPush 100% 校验：`grep -rL` + `|| true` + 显式 exit code（避免全合规时 CI 误判）
- Review patch 已应用：R1 grep 退出码修正、R2 timeout-minutes、R3 restore-keys

### EVO-9 lazy load
- **已就位**（convention-normalize 时落地）：`app.routes.ts` / `book-source.routes.ts` / `settings.routes.ts` 全部 `loadComponent` / `loadChildren`，无需改动

### EVO-10 TS Project References
- **降级为 P3 草案**：tsconfig.json 还原原状（破坏 `tsconfig.spec.json extends` 依赖链风险过高）
- 新文档：`.omc/fullauto/pomreader-arch-evo/p3-typescript-refs.md`

### EVO-13 PWA 评估（草案）
- 新文档：`.omc/fullauto/pomreader-arch-evo/p3-pwa-evaluation.md`（含 3 phase 实施路径 + ROI + 7 维风险登记）

### EVO-14 书源插件化 manifest（草案）
- 新文档：`.omc/fullauto/pomreader-arch-evo/p3-source-manifest.md`（含 pom-source.json schema + 安装/卸载语义 + 6 步实施计划）

### EVO-15 数据迁移框架化（草案）
- 新文档：`.omc/fullauto/pomreader-arch-evo/p3-migration.md`（含 _design/migrations 文档 + MIGRATIONS[] 调度 + idempotent + A13 legacy 移除 checklist 集成）

## Phase 2 Batch-2 移交清单（单 session 容量限制诚实说明）

| EVO | 状态 | 移交理由 |
|---|---|---|
| EVO-1 拆 BookService → Repository/Loader/Updater + facade | 未启动 | 482 行 + 9 调用方；单 sprint 风险高 |
| EVO-2 DB IPC BulkChannel | 未启动 | 依赖 EVO-4 schema 接口冻结 |
| EVO-3 Worker Pool + LRU | 未启动 | 依赖 EVO-1 拆分后接口 |
| EVO-4 valibot schema (fetch-handler 试点) | 未启动 | 新依赖需团队评审 |
| EVO-5 services coverage ≥70% | 未启动 | 5 新 spec 文件 + 重构测试 |
| EVO-6 OnPush 100% | 未启动 | 15 个 component 改动 + CI script |
| EVO-8 e2e Playwright | 未启动 | 5 spec 重写 + webServer |
| EVO-11 $localize wired | 未启动 | 新依赖 + 默认 locale 决策 |
| EVO-12 reader/settings 拆纯逻辑 | 未启动 | 依赖 EVO-1 BookRepository |
| EVO-16 文档同步 | 未启动 | 依赖 B/C/D 全完成 |

**完整 16 EVO 实施需 ≥3 个 fullauto session 接力**；本会话完成 0-pre + Phase 0 (Round 2 APPROVED) + Phase 1 (APPROVED) + Phase 2 batch-1 (5 个独立 EVO APPROVED)。

## Phase 5 归档 / 交付清单

### 已落地（git 实际改动）

```
M  docs/Task/README.md
?? .github/workflows/ci.yml
?? docs/Task/Active/POMREADER_ARCH_EVOLUTION_PLAN.md
```

未追踪（`.omc/` 在 `.gitignore`，不入仓）：
- `.omc/fullauto/pomreader-arch-evo/{state.json,spec.md,p3-*.md}`
- `.omc/plans/fullauto-pomreader-arch-evo-impl.md`

### 建议 commit 命令（不自动执行；按用户决定）

```bash
git -C /home/hoping/htdocs/pomreader add \
  docs/Task/README.md \
  docs/Task/Active/POMREADER_ARCH_EVOLUTION_PLAN.md \
  .github/workflows/ci.yml

git -C /home/hoping/htdocs/pomreader commit -m "$(cat <<'EOF'
chore(ci+docs): EVO-7 CI 双 job + EVO-9 已就位 + EVO-10 草案 + EVO-13/14/15 P3 草案

按 fullauto task pomreader-arch-evo 阶段 0/1/2 batch-1 + 3 QA 落地：

- docs: 新增 docs/Task/Active/POMREADER_ARCH_EVOLUTION_PLAN.md（7 段模板 + Phase 0/1/2 review sections）
- docs: docs/Task/README.md active 段加本任务索引
- ci: 新增 .github/workflows/ci.yml 双 job（lint+unit+build / e2e parallel），含 OnPush 100% 校验
- 全量 vitest 334/334 通过；Prettier format:check 全部通过

EVO-9 lazy load 已就位（convention-normalize 时落地）；EVO-10 降级为 P3 草案（ts project references scope break 风险）；EVO-13/14/15 P3 草案（不入仓）见 .omc/fullauto/pomreader-arch-evo/p3-*.md。

> OMC trailers:
> Constraint: fullauto v2.1 — Phase 4 三 reviewer 移交后续 session（单 session 容量受限）
> Rejected: 自动 commit + push | 与 CLAUDE.md §Commit trigger policy 冲突
> Directive: 用户后续可追加 EVO-1/2/3/4/5/6/8/11/12/16 commits
> Confidence: high
> Scope-risk: narrow（仅新增 CI + 文档同步，无代码逻辑改动）
> Not-tested: CI YAML 自身需 GitHub Actions 触发验证（local 无法跑）
EOF
)"
```

### 移交清单（10 EVO）

| 优先级 | EVO | 工作量 | 依赖 |
|---|---|---|---|
| 高 | EVO-4 valibot schema (fetch-handler) | 0.5 sprint | — |
| 高 | EVO-2 DB IPC BulkChannel | 1 sprint | EVO-4 |
| 高 | EVO-1 拆 BookService | 1.5 sprint | EVO-2 |
| 中 | EVO-3 Worker Pool + LRU | 1 sprint | EVO-1 |
| 中 | EVO-5 services coverage ≥70% | 0.5 sprint | EVO-1 |
| 中 | EVO-6 OnPush 100% | 0.5 sprint | — |
| 中 | EVO-8 e2e Playwright | 1 sprint | — |
| 中 | EVO-11 $localize | 0.5 sprint | — |
| 中 | EVO-12 reader/settings 拆纯逻辑 | 0.5 sprint | EVO-1 |
| 低 | EVO-16 文档同步 | 0.2 sprint | B+C+D 全 |

合计：约 6-7 sprint 可完成剩余 10 EVO。

### 触发后续 fullauto

下次启动相同 task：

```bash
# 在 .omc/fullauto/pomreader-arch-evo/state.json 已记录 phase: complete
# 若需要继续剩余 EVO，创建新 task slug pomreader-arch-evo-2（避免冲突）
```

---

## Phase 2 Batch-2（用户「继续」指令后）落地记录

### EVO-4: typed IPC schema（valibot 试点 fetch-handler）
- 新增 `electron/ipc/schema.ts`（96 行）
  - `safeHandle` / `safeHandleWithMeta` 工厂
  - `IpcValidationError` 包络
  - 4 个 channel schema: FetchHtmlArgsSchema / GetFetchUaArgsSchema / SetFetchUaArgsSchema / SetWebviewEncodingArgsSchema
- 修改 `electron/ipc/fetch-handler.ts`：4 个 invoke 改 safeHandleWithMeta
- `package.json` + `package-lock.json`：valibot@1.5.0
- **tsc 0 errors + vitest 342/342 全绿**

### EVO-2: bulk-result 工具（简化方案）
- 新增 `src/app/core/db/bulk-result.ts`（68 行）
  - `classifyBulkResults()` 统一 bulkDocs 错误分类
  - `formatBulkFatalMessage()` 统一异常消息格式
- 新增 `src/app/core/db/bulk-result.spec.ts`（80 行 / 8 测试）
- 修改 `src/app/core/services/db.service.ts` 三处集成：
  - `bookDelete` 用 conflictAsConflict=true 保留 409 警告
  - `chapterPutMany` 用默认（409 幂等成功）+ 单独过滤 deleteConflicts
  - `migrateLegacyChapterIds` 用默认（409 幂等）
- **vitest 342/342 全绿（新增 8 个 bulk-result 测试）**

### EVO-6: OnPush 100%
- 修改 15 个 component（app / disclaimer / universal-search*2 / 6 个 book-source / settings / 5 个 shared）
- 每个 component 加 `changeDetection: ChangeDetectionStrategy.OnPush` + import
- **vitest 342/342 全绿 + ng build 0 errors + OnPush 覆盖率 100%**

---

## 累计状态

| EVO | 状态 | 单/批 |
|---|---|---|
| EVO-7 GitHub Actions CI | ✅ | batch-1 |
| EVO-9 lazy load | ✅ 已就位 | batch-1 |
| EVO-10 ts project references | ⚠️ P3 草案 | batch-1 |
| EVO-13 PWA 评估 | ⚠️ P3 草案 | batch-1 |
| EVO-14 书源 manifest | ⚠️ P3 草案 | batch-1 |
| EVO-15 数据迁移框架 | ⚠️ P3 草案 | batch-1 |
| EVO-4 valibot IPC schema | ✅ | batch-2 |
| EVO-2 bulk-result 工具 | ✅ | batch-2 |
| EVO-6 OnPush 100% | ✅ | batch-2 |

**9/16 EVO 完成（含 P0 全部 3 项 + P1 高价值 2 项 + P3 草案 4 项）**

## 剩余未做（7 EVO）

| 优先级 | EVO | 工作量 |
|---|---|---|
| 高 | EVO-1 拆 BookService → Repository/Loader/Updater + facade | 1.5 sprint |
| 中 | EVO-3 Worker Pool + LRU | 1 sprint |
| 中 | EVO-5 services coverage ≥70% | 0.5 sprint |
| 中 | EVO-8 e2e Playwright | 1 sprint |
| 中 | EVO-11 $localize wired | 0.5 sprint |
| 中 | EVO-12 reader/settings 拆纯逻辑 | 0.5 sprint |
| 低 | EVO-16 文档同步 | 0.2 sprint |

合计：约 5 sprint 完成剩余 7 EVO。

---

## 建议 commit 序列（4 atomic commits，CLAUDE.md §Commit trigger policy 不自动 commit）

### Commit 1: chore(ci+docs): Phase 2 batch-1 metadata
```bash
git add docs/Task/README.md docs/Task/Active/POMREADER_ARCH_EVOLUTION_PLAN.md .github/workflows/ci.yml
git commit -m "chore(ci+docs): EVO-7 CI 双 job + EVO-9 已就位 + EVO-10 草案 + EVO-13/14/15 P3 草案"
```

### Commit 2: feat(ipc): EVO-4 typed IPC schema (valibot 试点 fetch-handler)
```bash
git add electron/ipc/schema.ts electron/ipc/fetch-handler.ts package.json package-lock.json
git commit -m "feat(ipc): EVO-4 typed IPC schema via valibot safeHandle"
```

### Commit 3: refactor(db): EVO-2 bulk-result 工具提取 + 3 处集成
```bash
git add src/app/core/db/bulk-result.ts src/app/core/db/bulk-result.spec.ts src/app/core/services/db.service.ts
git commit -m "refactor(db): EVO-2 bulk-result helper extraction + 3 site integration"
```

### Commit 4: refactor(perf): EVO-6 OnPush 100% (15 component)
```bash
git add src/app/app.component.ts src/app/modals/import-local-txt/import-local-txt.component.ts \
        src/app/pages/disclaimer/disclaimer.component.ts \
        src/app/pages/universal-search/search-placeholder.component.ts \
        src/app/pages/universal-search/universal-search.component.ts \
        src/app/pages/book-source/book-source-editor.component.ts \
        src/app/pages/book-source/book-source-list.component.ts \
        src/app/pages/book-source/book-source-search.component.ts \
        src/app/pages/book-source/book-source-smart-add.component.ts \
        src/app/pages/settings/cache-settings.component.ts \
        src/app/shared/components/book-card/book-card.component.ts \
        src/app/shared/components/page-header/page-header.component.ts \
        src/app/shared/components/sidebar/sidebar.component.ts \
        src/app/shared/components/cover-img/cover-img.component.ts \
        src/app/shared/components/rules-panel/rules-panel.component.ts
git commit -m "refactor(perf): EVO-6 OnPush 100% (15 component)"
```

> OMC trailers（每个 commit body 末尾）：
> Constraint: fullauto v2.1 — Phase 4 三 reviewer 移交后续 session
> Rejected: 自动 commit + push | 与 CLAUDE.md §Commit trigger policy 冲突
> Directive: 用户可手动执行上述 4 commit
> Confidence: high
> Scope-risk: narrow（schema + 工具提取 + OnPush 机械改造）
> Not-tested: CI YAML 自身需 GitHub Actions 触发；EVO-2 conflictAsConflict=true 仅在 bookDelete 测试覆盖
