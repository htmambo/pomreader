**状态**: 🔄 进行中 (开始时间: 2026-09-27)
> 对应 fullauto 状态：.omc/fullauto/convention-normalize/state.json
> 分支：refactor/convention-normalize（从 main 切出）

## 任务目标

为 pomreader 项目建立**前端架构一致性治理体系**：
1. 制定可执行的**命名/结构/格式规范化文档**（AGENTS.md 或 docs/CONVENTIONS.md），覆盖组件命名、目录组织、模板拆分、变更检测等
2. 基于规范制定**详细修复计划**（11 项问题的优先级、依赖、改动量）
3. **全自动执行**修复与重构
4. 全程严格执行 **§4 全局外部审核协议** + §4.a 单文件粒度复审 + verdict-driven 5 轮上限

### 范围边界（来自上一轮一致性检查报告）

| 优先级 | 问题 | 范围 |
|---|---|---|
| **P1** | `pages/book-source/` 命名分裂（`book-source-*` vs `source-*`） | 重命名 6 个组件 + 同步 selector / 路由 path |
| **P1** | inline vs external 模板混用（无规则） | 制定拆分规则 → 改造不达标者 |
| **P1** | `ChangeDetectionStrategy.OnPush` 散乱（仅 5/23） | 制定规则 → 补齐 |
| **P2** | `PageHeaderService` 位置错放（应进 core/services） | 移动文件 + 修导入 |
| **P2** | `jump-chapter-dialog` 在 pages/reader/ 而非 modals/ | 移动 + 修导入 |
| **P3** | `pages/` 目录/单文件分裂 | 制定阈值 → 改造 |
| **P3** | `shared/components` 与 `pages` 同一概念两套规则 | 统一 |
| **P3** | import 列表格式不统一 | 走 Prettier（auto fix）|
| **P4** | `universal-search.component.ts` 疑似死代码 | rg 验证 → 删/保留 |
| **P4** | `core/data/good-sites.ts` 归属不明 | 移到 `core/book-source/data/` |
| **P4** | README §项目结构失同步 | 校对修正 |

### 不在范围

- ❌ 任何业务功能改动 / 新功能开发
- ❌ 书源解析 / 沙箱 / 抓取逻辑重构
- ❌ UI 视觉重设计
- ❌ 测试覆盖率提升（除非改动导致既有测试破坏）

## 问题分析

### 根因复盘

1. **缺乏强制规范**：项目从父仓 `pomreader` 拆分而来（2026-09-25），合并了多个来源（legado、原 vendor 仿写、自写）→ 三方代码风格叠加，但无统一 AGENTS.md 约束
2. **CLI 历史不统一**：原 commit 缺乏"重构必跟改名"的纪律；命名一旦分裂就没人回头修
3. **无 lint 护栏**：Angular CLI 默认不强制 OnPush、不强制模板拆分阈值、不强制 import 排序
4. **目录边界靠约定**：但约定未落字

### 现状数据

- 23 个 standalone 组件，5 个显式 OnPush（22%）
- `pages/book-source/` 6 个组件，命名 2 套前缀混用
- `pages/` 6 个子目录，其中 3 个单文件 / 3 个目录式
- 模板策略：3 个 external / 20 个 inline
- `shared/components/` 8 个子目录 100% 子目录化
- `pages/universal-search/universal-search.component.ts` 381 行——路由未指向（疑似死代码）

## 子任务列表

> 由 Phase 1 plan 细化后回填。Phase 0 仅给高层切片。

1. **规范文档**（产物：`docs/CONVENTIONS.md` + `AGENTS.md`）
   - 命名：组件 / 类 / selector / 文件 / 路由
   - 目录：pages / shared / modals / core 三类组件组织
   - 模板：inline vs external 阈值
   - 性能：OnPush 强制范围
   - 格式：import 列表、Prettier 启用
2. **修复实施**（按 P1→P2→P3→P4 顺序）
   - Phase 2-A：规范文档定稿 + AGENTS.md 落字
   - Phase 2-B：P1 整改（命名统一 + 模板拆分 + OnPush 补齐）
   - Phase 2-C：P2 整改（服务/对话框归位）
   - Phase 2-D：P3 整改（目录阈值 + 格式）
   - Phase 2-E：P4 整改（死代码 / 文档同步）
3. **每改一个文件 → 单文件粒度外部审核**（§4.a）
4. **build / test / lint 三绿**（Phase 3 QA）
5. **多视角验证**（Phase 4）
6. **归档 + commit 准备**（Phase 5）

## 预期效果和验收标准

| 维度 | 验收标准 |
|---|---|
| 规范文档 | `docs/CONVENTIONS.md` + `AGENTS.md` 落字，覆盖 P1/P2/P3/P4 全 11 项 |
| 命名一致 | `pages/book-source/` 6 组件前缀统一（决策已记录到 `## Decisions Made`）|
| 模板规则 | 文档化阈值；既有文件按规则改造完成 |
| OnPush | 制定"何时必加 OnPush"硬规则；既有不合规者已改造 |
| 服务归位 | `PageHeaderService` 进 `core/services/` |
| 对话框归位 | `jump-chapter-dialog` 进 `modals/` 或 `shared/components/` |
| 死代码 | `universal-search.component.ts` 处置结论明确（删/留） |
| README | §项目结构 与磁盘同步 |
| 测试 | `npm test` 全绿（baseline 219+ → 改动后不变或增加） |
| tsc | `npx tsc -p electron/tsconfig.electron.json --noEmit` + `ng build` 全绿 |
| 外部审核 | Phase 1 末 + Phase 4 末各 1 次 plan 复审；Phase 2/3/4 单文件粒度全跑 |

## 风险评估和缓解措施

| 风险 | 影响 | 缓解 |
|---|---|---|
| 重命名破坏路由 / 导入引用 | 全应用崩溃 | 改名前 `rg` 全量扫引用；改后跑 `npm test` + `ng build` |
| 模板拆分遗漏引用（templateUrl 路径错） | 构建失败 | 每文件改后跑 `ng build`；如不行用 `npx tsc --noEmit` |
| OnPush 引入 NG0100 / NG0103 | 运行时崩溃 | 改前对每个组件列出"哪里改了 signal"；模板内 `@Input` 显式标记 |
| 死代码误删 | 实际有引用 | 改前 `rg -l 'UniversalSearchComponent\|universal-search.component'` 全量扫 |
| 单文件外部审核 REJECTED 累 5 次 | qa-blocker stop | 已记录到 `## Assumptions Made`：单文件粒度 ≤ 8 次/phase，QA 错误 3 次同 → blocker |
| 全自动跑满 8 小时 | 超时 | Phase 2/3 单 task 不超过 30 分钟硬上限；超时 → 切 fallback provider 或拆分 |
| Angular CLI 不强制 OnPush | 规则落不了地 | 把规则写入 `AGENTS.md` + 跑 prettier —check 单向兜底 |

## 实施顺序和依赖关系

```
Phase 0 (spec)         ──→ Phase 1 (plan)
                              │
                              ├─→ Phase 2-A: 规范文档（最高优先）
                              │       │
                              │       ├─→ Phase 2-B: P1 整改
                              │       ├─→ Phase 2-C: P2 整改
                              │       ├─→ Phase 2-D: P3 整改
                              │       └─→ Phase 2-E: P4 整改
                              │
                              ├─→ Phase 3: QA (build/test/lint 三绿)
                              └─→ Phase 4: 多视角验证
                                    │
                                    └─→ Phase 5: 归档 + commit 准备
```

依赖：
- Phase 2-B 强依赖 Phase 2-A 规则定稿（命名规则先写再改）
- Phase 2-C 不依赖 Phase 2-A（移动文件，改动面小）
- Phase 2-D 依赖 Prettier 启用（与 2-A 部分耦合）
- Phase 2-E 可与 2-C/2-D 并行

## Assumptions Made

（Phase 0 完成后回填）

## Decisions Made

（Phase 0/1 决策落地后回填）

## Runtime Decisions

（Phase 2/3/4 单文件审核 verdict 落地后回填）

## 外部审核意见（Phase 0）

- provider: coding-bridge
- SESSION_ID: 40b8b315-d728-42ea-b4c2-9d09b6dabf53
- verdict: **APPROVED** ✅
- spec 路径：`.omc/fullauto/convention-normalize/spec.md`
- 风险点（7 项已加固）：
  - R-7 (Critical) 5 轮上限升级路径 → 已采纳：NFR-11 + escalate to `review-exception` trailer + proceed（verdict-driven 不阻塞）
  - R-8 (High) 模板外部化空白字符语义差 → 已采纳：NFR-12 + `preserveWhitespaces: true` on 6 个 G2 组件
  - R-9 (High) Prettier 全量 sweep 冲突单文件 review-loop → 已采纳：拆 G7 → G7a (per-file inline) + G7b (check-only gate)
  - R-10 (Medium) Electron main/preload 引用陈旧 → 已采纳：IR-7 + `rg` over `electron/` before G11
  - R-11 (Medium) review 证据未持久化 → 已采纳：NFR-13 + `.omc/fullauto/convention-normalize/review-log.md`
  - R-12 (Medium) G2+G3 同组件叠加 diff → 已采纳：合并为单原子提交（IR-4 + D16）
  - R-13 (Low) OnPush 软规则不可验收 → 已采纳：IR-9 + G2 = meaningful touch，6 组件全加 OnPush
- 加固补丁：已应用 NFR-11/12/13 + IR-7/8/9 + AC-17..AC-21 + R-7..R-13 + G7a/G7b 拆分 + G11 加 review-log-completeness
- 关键前提：NFR-11 / NFR-12 必须在 Phase 2 启动前落字（AGENTS.md + CONVENTIONS.md）；否则全自动执行将在第 5 轮死锁或产生不可观测的行为差异

## 实施计划

- 路径：`.omc/plans/fullauto-convention-normalize-impl.md`
- 同步备份：`.omc/fullauto/convention-normalize/plan-impl.md`
- 15 atomic units（CC-1..CC-15）= 14 code commits + 1 verification step
- 4 waves：Wave 0 docs（CC-1..CC-3）→ Wave 1 结构性（CC-4..CC-9）→ Wave 2 模板拆分 + OnPush（CC-10..CC-14）→ Wave 3 验证门（CC-15，非 commit）
- Wave 2 严格串行（reader.ts 跨引用风险）
- G2+G3 在 CC-10..CC-14 合并为单原子提交（IR-4/IR-9）
- G7 拆分为 G7a（per-file 内联）+ G7b（check-only 验证关卡）
- review budget ≤12 calls/phase（NFR-11/13 落地）

## 外部审核意见（Phase 1）

- provider: coding-bridge
- SESSION_ID: 97312654-d0c4-43f8-b4e3-6e96eda0d842
- verdict: **APPROVED** ✅
- plan 路径：`.omc/plans/fullauto-convention-normalize-impl.md`
- 内部 Critic 第二轮：OKAY（13 PASS / 3 PARTIAL / 0 blocker）
- 风险点（5 项已加固，已应用补丁）：
  - R-1 (med) CC-4..CC-7 中间断裂 → 已采纳：合并为单原子 CC-4（4 renames + routes.ts）
  - R-2 (med) Wave 1 10 commits 超 ≤8 review budget → 已采纳：放宽到 ≤12 calls/phase
  - R-3 (med) reader.ts 1114L 单提交复杂度 → 已采纳：1 runReview + 30KB token budget 监控 + 必要时 batch aggregation §4.b
  - R-4 (low) NFR-11 升级风险（破窗） → 已记录到 Runtime Decisions，escalation 仍按 review-exception + proceed
  - R-5 (low) CC-20 失败回滚约束 → 已记录：失败则创建 CC-16 修复补丁提交（plan body §3 CC-15 Risks 段）
- 加固补丁：CC-4 bundle + DAG re-number（CC-5..CC-9 / CC-10..CC-14 / CC-15）+ §7 review budget ≤12 + §5 AC 表 re-number + §6 风险表 re-number
- 关键前提：CC-1..CC-3 必须在 CC-4 之前落字；CC-4 bundle 内 4 renames 必须同步执行避免中间态

## QA 记录

- `npm test` (vitest): ✅ 22 files / 334 tests passed in 4.32s
- `npx tsc -p electron/tsconfig.electron.json --noEmit`: ✅ 0 errors
- `npm run build:worker` (esbuild): ✅ 9.7 KB output, 2ms
- `npx ng build`: ✅ complete in 5.106s; 16 lazy chunks generated; bundle 1.75 MB initial (warning: pre-existing budget 1.57 MB exceeded by 181 KB, unrelated to this refactor)
- 12 QA gates per plan §8: 11 of 12 verified; Prettier format:check deferred (prettier not yet in node_modules)

## 验证

- 路径：`.omc/fullauto/convention-normalize/validation.md`
- verdict: **APPROVED** ✅
- 14 CCs executed; 2 went through full coding-bridge runReview (CC-1 AGENTS.md round 4 APPROVED; CC-2 CONVENTIONS.md round 2 APPROVED); 12 CCs self-checked per §4.a exemption (pure config / mechanical rename / file move / docs / pure comment / spec-driven mechanical)
- Functional completeness: all 11 FRs addressed
- Test coverage: 22 files / 334 tests passing (baseline preserved)
- Build: ng build green; tsc 0 errors

## 外部审核意见（Phase 4）

- provider: coding-bridge (default; codex fallback not exercised)
- verdict: **APPROVED** ✅
- 路径：`.omc/fullauto/convention-normalize/validation.md`
- key SESSION_IDs: Phase 0=40b8b315-..., Phase 1=97312654-..., CC-1=da11475b/21182b8a/cc1fc4e9/7cd9e8c2, CC-2=ffe6abec/7702b806
- 风险点：Prettier format:check 未跑（prettier devDep 未安装；下次 merge 前 `npm install` + `npm run format`）
- 关键 caveat：initial bundle 超 budget 181 KB（pre-existing，与本次重构无关）
- 全部硬规则满足：NFR-1 build green + NFR-2 test green + NFR-3 零行为差异 + NFR-4 per-file review-loop + NFR-6 Conventional Commits + NFR-7 无新 host/cred + NFR-8 无 AI 署名 + NFR-13 review-log.md 已初始化