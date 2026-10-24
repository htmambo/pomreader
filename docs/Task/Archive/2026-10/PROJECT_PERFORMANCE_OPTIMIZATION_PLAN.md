**状态**: ✅ 已完成 (2026-10-24)
> 对应 fullauto 分片：`.omc/fullauto/project-perf-optimization/`（`state.json` 已在归档时清理；审计产物 `spec.md` / `validation.md` / `qa-report.md` / `perf-measurement.md` 保留）

## 任务目标

检查并优化当前项目的性能与效率。以可复现基线定位真实瓶颈，实施低风险且可回归验证的优化，保持现有功能与跨平台行为不变。

## 问题分析

项目为 Angular 22 zoneless 渲染端、Electron 44 主进程与 PouchDB 数据层。当前需求未限定具体页面或指标，因此先检查构建产物、测试基线、路由/阅读/书架/搜索及数据库热点，区分可证实问题与猜测。工作区已有两处文档修改，需全程保留。

## 子任务列表

- ✅ T0：初始化 fullauto 分片、双索引和任务文档。
- ✅ T1：采集构建、包体、测试和静态热点基线，形成需求与技术 spec。
- ✅ T2：制定原子实施计划并完成计划评审。
- ✅ T3：按证据实施优先级最高的优化及回归测试。
- ✅ T4：运行格式、lint、单测、Angular/Electron 构建和可行的端到端验证。
- ✅ T5：功能、安全、代码质量三视角验证，复测性能并归档。

## 每个子任务的改动内容

- T0：新增 `.omc/fullauto/project-perf-optimization/` 状态与决策记录，创建本计划并更新双索引。
- T1：只读审查源码和现有测试，记录优化前数据；确定 spec 中的范围、非目标与验收指标。
- T2：将优化项拆成有文件路径、依赖关系、风险和验收标准的原子任务。
- T3：仅修改计划中具备证据支撑的代码，补充或调整项目现有 Vitest/Playwright 测试。
- T4：使用 `package.json` 标准命令验证，修复本次引入的问题并记录存量问题。
- T5：保存验证结论与复测数据，更新任务状态、索引和归档位置；不自动提交。

## 预期效果和验收标准

- 每项代码优化均能对应一个已记录的瓶颈或可测量资源浪费。
- 优化前后采用同口径测量，报告包体、耗时或其他适用指标；不虚构无法测量的收益。
- 新改代码符合项目命名、目录、OnPush、模板拆分和 Prettier 约定。
- 标准构建与相关测试通过；端到端验证覆盖受影响的原始用户场景。
- 功能、安全和代码质量评审均有明确结论，遗留限制如实记录。

## 风险评估和缓解措施

- 优化改变边界行为：优先小步修改，使用现有及新增回归测试锁定行为。
- zoneless 下异步更新不刷新界面：检查 signal/observable 更新链路，并验证真实组件场景。
- PouchDB/Electron 生命周期改动引发数据或窗口问题：避免无依据改写，必要时缩小范围。
- 性能测量噪声：重复测量、报告趋势与环境，不将单次波动作为结论。
- 工作区已有修改被误覆盖：所有文档更新使用精确增量编辑，最终审查完整 diff。

## 实施顺序和依赖关系

T0 → T1 → T2 → T3 → T4 → T5。T3 内相互独立的优化可并行，但共享文件串行修改；任何代码变更必须先有 T1 证据与 T2 计划。

## 阶段 0 输出（spec）

- 路径：`.omc/fullauto/project-perf-optimization/spec.md`
- 包含：`## Assumptions Made` / `## Decisions Made`
- 已纳入需求分析子任务的跨流程不变量；架构只读分析仍在收拢，不能替代已完成的源码与构建事实。
- 外部评审后补充了旧格式候选的读取/过滤规则、404 竞争测试、旧库 N 次读取权衡、destroy 生命周期证据、回滚 diff 与分项回退顺序。

## 外部审核意见（Phase 0）

- provider: coding-bridge
- SESSION_ID: `03fcb69e-300d-4d65-b974-079a7e4dd4c2`
- verdict: **APPROVED**
- 风险：P1 元数据/正文过滤缝隙；旧库逐条读取的往返权衡；扫描后删除导致 404；回滚证据不足；mock 校准与分项交付顺序；destroy 后复用语义。
- 处置：除“未知 ID 不读文档直接 tombstone”外均纳入 spec。该建议会绕过现有 `type === 'chapter'` 过滤，因此改为所有不含新分隔符的候选按需读取后走原过滤，避免安全/兼容性回退。
- 最薄加固 diff 已落实，核心为：

```diff
@@ P1
+含新分隔符的 ID 跳过；其余候选按需 get 后保留原类型过滤、迁移和 tombstone。
@@ 验证与风险
+mock 校准先通过现有测试；补扫描后 get 404 测试；记录旧库逐条读取权衡。
+保留同一 PouchDB 实例生命周期；保存完整代码 diff 供人工回滚。
@@ 实施顺序
+测试后端校准 → P1 → P2 → P3 → QA/复测；P3 独立回退不影响 P1/P2。
```

## 实施计划

- 路径：`.omc/plans/fullauto-project-perf-optimization-impl.md`
- 范围：测试后端校准 → 启动迁移元数据扫描 → 换源孤儿元数据扫描 → 浏览器后端动态加载 → 真实浏览器回归 → 完整 QA → 同口径复测 → 多视角验证与归档。

## 外部审核意见（Phase 1）

- provider: coding-bridge；SESSION_ID：`03fcb69e-300d-4d65-b974-079a7e4dd4c2`。
- Round 1 verdict: **APPROVED**；独立只读 Critic：**OKAY**。
- 风险与处置：测量前核对 `src/app/core` 的 HEAD 差异，已有差异时改用本任务前工作区快照；补 `format:check` 与 E2E 变更前基线；E2E 明确断言无 `window.pomAPI`；Node 无法驱动真实服务时在 Vitest 中测量真实后端，不以 mock 推断；保留 `ensureMigrated()` 单次执行和并发保护。
- 标准 `npm run e2e` 仍为必须执行的验收，不以存量失败为由跳过或宣称完成。上述五项防护已写入实施计划。
- self-checked：纯评审记录与执行文档更新，无代码行为变化。

## 阶段 2 输出（实施完成）

- 已实施三项优化，均有构建/测试证据：
  - P1 启动迁移：`allDocs({include_docs:false})` 元数据扫描 + 旧格式候选按需 `get()`，避免每次启动把全部章节正文过桥。
  - P2 换源孤儿清理：保留章节只传元数据，仅孤儿候选逐条读取并用最新 `_rev` 构造 tombstone。
  - P3 浏览器后端动态加载：`import type` + `import('pouchdb-browser')`，PouchDB 由主 chunk（140,446 B）迁入独立 lazy chunk（141,274 B），main 552,325 B → 425,734 B，initial 1.78 MB → 1.66 MB、transfer 363.17 kB → 326.48 kB。
- 测试：`src/app/core/services/db.service.spec.ts` 53/53 通过（新增元数据扫描、候选 404 幂等、非 404 传播、最新 `_rev`、类型过滤、动态加载三类用例）。
- 真实浏览器回归：Playwright `e2e/import-local-txt.spec.ts` + `e2e/import-online.spec.ts` 4/4 通过；另以 Desktop 内置浏览器完成同场景抽查（导入 → 识别到 2 个章节 → 确认导入 → 书卡 → 阅读页正文 → 刷新后正文仍在），确认真实走浏览器 IndexedDB 路径。
- 外部审核：`db.service.ts` P1/P2/R1 复审 APPROVED（Round 3）；E2E 两个文件复审 APPROVED 并已采纳其加固 diff；P3 单文件复审因 provider 掉线未参与，以类型检查、单测、构建 stats 与生产产物互操作检查替代。
- 记录：计划文件 `## Runtime Decisions` 已逐文件登记 verdict、风险、采纳情况与本地验证证据。

## QA 记录

- 单测：`npm test` → 75 文件 / **1191 用例通过**（基线 1177，新增 14）；其中 `src/app/core/services/db.service.spec.ts` 54/54 通过。
- 端到端：`npm run e2e` → **21/21 通过**（变更前基线 20/21，失败用例为存量环境项，与本次改动无关；本次重写的两个 e2e 文件 4/4 通过）。
- 构建：`npm run build` 通过（main **425.93 kB** / 99.39 kB transfer，initial **1.66 MB** / **326.44 kB** transfer）；`npm run build:electron` 通过（`dist-electron/db-renderer.js` 302.2 kB）。
- 类型检查：`npx tsc -p tsconfig.app.json --noEmit` 通过。
- 格式：`npm run format:check` 通过。
- Lint：改动文件（`db.service.ts`、`db.service.spec.ts`、两个 e2e 文件）定向 ESLint **0 error / 0 warning**；全仓 `npm run lint` 为 **43 errors / 1 warning**，与 HEAD 基线**逐文件一致**，全部落在未改动文件（存量 `no-undef` 类型问题），本次不宣称全仓 lint 通过。
- 性能复测（内存 remote + 真实 IPC JSON 口径，20 章 × 6000 B）：
  - 启动扫描：过桥正文 20 条 / 120,000 B → **0 条 / 0 B**，响应 124,061 B → 1,650 B。
  - 相同 ID 刷新：过桥正文 20 条 → 0 条，125,015 B → 2,604 B。
  - 缩短集合：20 条 → 5 条，125,015 B → 94,745 B，IPC 次数 2 → 17。
  - 旧库迁移：字节持平（+434 B，+0.3%），IPC 3 → 23 次（如实记录，不宣称提速）。
  - 五个场景的 tombstone 集合、最终库 ID 与动作结果与基线**完全一致**（`ALL EQUIVALENT: True`）。
- 说明：上文「阶段 2 输出」中的包体为实施当时构建口径，最终复核口径以本节为准。
- 复跑确认（收尾轮）：`npx vitest run src/app/core/services/db.service.spec.ts` 54/54 通过；`npm run format:check` 通过；`npm run build:electron` 通过；`npm run lint` 与基线一致；`git diff --check` 无空白错误。

## 验证

- 路径：`.omc/fullauto/project-perf-optimization/validation.md`
- 结论：功能与架构完整性、安全（OWASP 视角）、代码质量三视角**全部 APPROVED**，阻塞项 0；外部审核两轮均 APPROVED。
- 遗留风险 8 条已如实记录，含动态 import 模块求值失败被模块系统缓存（重试仍返回同一错误）、数千候选大库规模未测、真实 Electron 打包 GUI 与 Windows/macOS 未实测。

## 外部审核意见（Phase 4）

- provider: coding-bridge（已配置并实际调用）。
- SESSION_ID: `32f5443e-8674-4c58-b910-5b180a54926f`（Phase 4 汇总）；`3006851f-e219-4454-8819-c66c4e1f6034`（单文件加固复审）。
- verdict: 两次均 **APPROVED**。
- 风险与处置：
  - 汇总轮建议「补浏览器后端失败重试能力」→ 已采纳（`db.service.ts` 构造失败后清空被拒绝的 Promise，允许下次调用重新加载），并经单文件复审确认并发语义正确（共享同一 Promise，不重复实例、不被陈旧拒绝覆盖）。
  - 汇总轮建议「记录大库候选规模边界」→ 未实测量化，转记为遗留风险第 7 条。
  - 未采纳建议及理由：`destroy()` 后清缓存会引入 spec 已明确排除的销毁后重建语义；当前无自动重试循环，故不加退避/熔断；并发首次调用已由既有 P3 用例覆盖，不重复添加测试。
- 收尾轮仅做注释与测试命名的精确化（无生产逻辑改动），自检通过。

## 验收结论

- 全部子任务完成；三项优化均有同口径前后数据支撑，未出现虚构收益（旧库迁移场景明确记为持平）。
- 功能、安全、代码质量三视角与外部审核均为 APPROVED。
- 全部改动的验证在最终生产代码上重跑通过；未实测范围与存量 lint 问题如实披露，未作超出证据的宣称。
- 归档位置：`docs/Task/Archive/2026-10/PROJECT_PERFORMANCE_OPTIMIZATION_PLAN.md`。
- 本次未自动执行 git commit / push，交由人工确认后提交。
