# Task Index

> 本仓库为 `pomreader` 独立项目仓库（2026-09-25 从父仓 `pomreader` 拆分）。
> 父仓（白虎阅读 macOS DMG Linux 重打包）的任务历史已迁移至父仓 `docs/Task/`。

## Active Tasks

- [性能优化第三轮 — 后续跟进项](Active/PERFORMANCE_ROUND3_FOLLOWUPS.md) — 2026-11-22 终验外部评审（APPROVED）转出的 4 项待办：F-1 应用内存打点（新增第二个隐藏 BrowserWindow）/ F-2 超大目录（>3000 章）虚拟滚动方案重评 / F-3 真实环境数据闭环（冷启动耗时、webview 存活、CF 端到端、3000 章目录计时）/ F-4 F10 超时行为变更的用户反馈跟踪
- [工程基线后续优化项](Active/ENGINEERING_BASELINE_FOLLOWUPS.md) — 2026-11-12 规范债收口任务外部审查确认为真实但超出范围的 3 项预存技术债：S-1 Sass `@import`→`@use` 迁移 / S-2 CSS 资源路径改相对路径 / S-3 CI lint 与 Playwright 安装并行化，各附触发条件与「本次不做」理由
- [书源 JSON 规则化 — 二期及后续跟进项](Active/BOOKSOURCE_JSON_RULES_FOLLOWUPS.md) — 跟踪主方案（[2026-09-29 书源 JSON 规则化改造方案 v2.1](../Architecture/2026-09-29-BOOKSOURCE-JSON-RULES-PLAN.md)）v1 明确不做的 17 项（T-1..T-17，表达力扩展 / 引擎运行时 / 生态工具 / 机制验证），含触发条件与激活规则
  - 主方案 v2.1 已过两轮评审（17 条事实基线 + 结构白名单迁移判据 + 离线差分测试）；其中 T-12（导入导出 bundle）**前置未完成** —— [2026-09-28 导入导出设计](../Architecture/2026-09-28-BOOKSOURCE_IMPORT_EXPORT_DESIGN.md) 仍按旧 `.js` 契约，需先修订

## Completed Tasks (Archive)

### 2026-11

- ✅ [安全与性能硬化（2026-11 静态审查整改）](Archive/2026-11/SECURITY_PERF_HARDENING_PLAN.md) — Completed 2026-11-27
  - 安全：fetch 重定向逐跳 SSRF 校验、`isPrivateHost` IPv6/6to4/NAT64/.localhost、window.open 与导航护栏、session 权限收口、openExternal 仅 http(s)、zip 解压上限、CSP、preload 通道白名单、pom-local realpath
  - 性能：主题纹理改相对资源（打包态不再 404）、main chunk 268K→208K（动画异步）、章节正文缓存离开阅读页释放、书架视口外跳渲染
  - 复审：security-reviewer 2 HIGH（manual 模式 3xx 走 `redirect` 事件、window.open 绕过）+ 1 MEDIUM 全部修复；code-reviewer APPROVED；lint 0、双端 tsc 0、1237 单测全绿、双构建通过
  - 未验证：真实 Electron 窗口 CSP 运行态、动画首交互、万章书架滚动

- ✅ [打包脚本合并（build-mac.sh + build-linux.sh → build-release.sh）](Archive/2026-11/BUILD_SCRIPTS_MERGE_PLAN.md) — Completed 2026-11-22
  - **合并动机**：两个脚本是同一条打包流水线的两份实现，已出现 4 处实质漂移（产物汇总两套写法、全失败守卫两套判据、结果表两套列宽、`--arch=` 解析两种形态）—— 改一次通用逻辑要改两处。**结构调整任务，无运行时性能收益，不计入性能优化账**
  - **单一入口** `scripts/build-release.sh`（`--platform mac|linux`）：共享骨架（参数解析 / 前置检查 / 构建 / 打包循环 / 产物校验 / 结果报表 / 收尾）+ 平台函数组（mac 1 维 arch、linux 2 维 distro×arch + deb 跨发行版复用）；用「扁平目标清单」（`key|outdir|builder_args|exts|distro|arch`）吸收 1 维 / 2 维差异
  - **11 个 `npm run dist:*` 命令与产物路径逐字不变**（`npm run dist` 未触及，其产物仍落 `release/` 根）；显式豁免 3 项终端辅助输出变更（mac 结果表样式 / usage 文案 / 提示措辞）
  - **验证**：§4.0 合并前后**输出级 diff**（同一套桩，6 条 electron-builder 实参逐字一致、ubuntu 复用目标无 builder 调用）+ linux 真机实跑（`dist:linux:all` exit 0，四目标齐全，deepin/ubuntu 的 .deb 字节一致；`--appimage` 产出 pacman + AppImage 双产物）+ 失败路径三态（die / `--keep-going` / 全失败守卫跳过 `verify:package`）+ mac 分支桩 dry-run（bash 3.2 兼容、builder 实参、参数校验）；lint 0 error、format:check 通过、单测 76 文件 / 1223 用例全绿
  - **未实测项**：真机 macOS 打包（dmg 产出 / Rosetta 识别 / 签名公证提示）；`--arch armv7l` 交叉构建 —— **上游限制**，Electron 44.4.5 不发布 linux-armv7l 预编译包（HTTP 404），脚本按预期报错退出，与旧脚本同构
  - **外部评审 4 轮**：计划 Round 1/2 NEEDS_CHANGES（5 项 + 1 项误判，误判以 grep / git 哈希 / git 历史 / 实证运行四条证据驳回）、Round 3 APPROVED；代码 Round 1 APPROVED（2 条加固建议已采纳）。**实施中发现并修复 3 处**：扁平清单位置参数错位致 deb 复用失效 / 架构报错文案分隔符 / `usage()` 相对路径缺陷

- ✅ [性能与速度优化 · 第三轮](Archive/2026-11/PERFORMANCE_OPTIMIZATION_ROUND3_PLAN.md) — Completed 2026-11-22
  - 批次①冷启动：F1 旧 chapter `_id` 迁移加完成标记（第二次启动全库扫描 1 次 → **0 次**）/ F2 首屏静态导入拆出（`@defer` + 动态 import）/ F3 `scanJsonDir` 加 `mtime+size` 缓存（渲染端 5 处重复全量解析 → 0）/ F4 存量 JS 书源迁移挪出建窗关键路径
  - 批次③主进程网络：F10 重定向链超时预算累计化（声明 15s 实为 60s、60s 实为 240s → 回到声明值）/ F11 CF 过盾改用独立隐藏窗口（不再阻塞普通渲染抓取）/ F12 删除伪流式书源列表死通道
  - 批次④微优化：F13 排序改用模块级缓存 `Intl.Collator` / F14 目录条目文案预计算 + `content-visibility: auto`（3000 条目同步布局 51ms → **18.3ms**，-64%，scrollHeight 与条目高度逐字一致）
  - **首屏 bundle**：main chunk 434.39 kB → **272.58 kB（-37.3%）**，Initial total 1.46 MB → 1.25 MB，transfer 307.60 kB → 260.02 kB（封面模板等业务链离开首屏，产物 grep + index.html modulepreload 双向佐证）
  - 4 个 commit（`6c1a20a` / `0ed8ecd` / `be688df` / `f68e199`），逐批可独立回退
  - 验证：单测 76 文件 **1223 用例全绿**（+19）、lint **0/0**、format:check 通过、双构建通过；新增的 10 条用例**逐条验证过在修复前的代码上会失败**；e2e 20/21（失败项为存量，基线 `4b31cdb` 已复现，未触碰 sidebar，**不宣称全绿**）
  - 外部评审 3 轮：Round 1 需求（NEEDS_CHANGES，4 项）、Round 2 计划（NEEDS_CHANGES，10 项）、Round 3 终验（**APPROVED**）—— 全部风险逐条处置并留痕；评审建议的 `@defer` 被采纳，「窗口锁共享」因无法解除单窗口物理约束被有意偏离并记录理由
  - 未实施项（批次② F5-F9）连同理由记录在归档文档「备注」段；后续跟踪项转 [性能优化第三轮 — 后续跟进项](../Active/PERFORMANCE_ROUND3_FOLLOWUPS.md)

- ✅ [Linux 多发行版一键打包脚本](Archive/2026-11/LINUX_MULTI_DISTRO_PACKAGING_PLAN.md) — Completed 2026-11-22
  - 新增 `scripts/build-linux.sh`（对齐 `build-mac.sh` 形态）：`--distro linux|manjaro|deepin|ubuntu|all` / `--arch x64|arm64|armv7l|ia32|all` / `--appimage` / `--skip-build` / `--keep-going`；发行版按 `/etc/os-release` 自动识别
  - `package.json` 新增 `build.deb`：28 项 Debian 依赖（7 处用 `|` 替代语法覆盖 Ubuntu 24.04+ 的 t64 改名，一份 .deb 同时通用于 Deepin / Ubuntu / Debian）+ `recommends: []`；`build.linux.target` 增补 `deb`
  - 扩展 `electron/scripts/after-install.sh`：补齐 electron-builder 内置模板被**整体替换**后缺失的 4 项 —— `/usr/bin/<exe>` 软链、chrome-sandbox SUID 回退、**AppArmor profile 安装（Ubuntu 24+ 启动硬需求）**、desktop/MIME 库刷新；同一缺口在既有 pacman 包中一并修复
  - **附带修复**：`scripts/build-mac.sh` 的 `--arch=` 等号形式解析 P0 缺陷（`set --` 把原参数重复入队，导致报「未知参数」），1 行改动
  - 实测：四目标实跑通过（206s）；`dpkg-deb -I` 校验 Depends / Maintainer / Section / 无 Recommends；`ar x` + `tar xf` 校验 postinst 含 AppArmor 段且宏已替换；`tar -xf` 校验 `.PKGINFO` 26 行 depend；构造失败路径验证 `--keep-going` 的 FAIL 行 + exit 1
  - 外部审查 3 轮：Round 1 需求（NEEDS_CHANGES，10 项）、Round 2 代码（NEEDS_CHANGES，7 项，含 1× P0）、Round 3 复审 **APPROVED**；全部风险逐条处置并留痕
  - 文档：`docs/Usage/LINUX_PACKAGING.md` 重写（四目标产物表 / 一键用法 / 依赖推导与 t64 对照 / afterInstall 替换语义 / AppArmor / SUID 权衡 / 交叉架构验证边界）、`README.md` 打包章节同步
  - 遗留（本期不做，已独立立项）：CI 多发行版 matrix / `MANIFEST.sha256` / xvfb 启动级 smoke test / 跨架构真机验证 / 版本号递增策略
  - **现状注记（2026-11-22）**：`scripts/build-mac.sh` 与 `scripts/build-linux.sh` 已合并为单一入口 `scripts/build-release.sh`（`--platform mac|linux`），11 个 `npm run dist:*` 命令与产物路径逐字不变；详见 [打包脚本合并](Archive/2026-11/BUILD_SCRIPTS_MERGE_PLAN.md)。本条描述的是合并前的历史事实，不改写。

- ✅ [ESLint 存量报错修复与 Angular 控制流规范化](Archive/2026-11/LINT_ERRORS_FIX_PLAN.md) — Completed 2026-11-12
  - 控制流升级：`book-source-subscriptions.component.html` 迁移至 `@for (sub of subTable.data; track (sub.id ?? $index))`，清理组件冗余 `NgFor` import
  - 类型检查最佳实践：在 `eslint.config.js` 中将 TS 源码与 spec 规则块的 `no-undef` 显式关闭，完全交由 TypeScript 编译器负责全局与 `.d.ts` 静态检查，消灭 41 处 `no-undef` 误报
  - 编译器索引精准修复：在 `tsconfig.app.json` 中配置 include 显式挂载 `source-health.service.ts`，解决 typescript-eslint 项目缺失报错（**该服务已于同日随「规范债收口」任务删除**，include 登记同步移除）
  - 规范类型断言：在 `booksource-handler.spec.ts` 中以 `Parameters<...>` 替代 `as any`，清理未使用的 eslint-disable 指令
  - 达成 `npm run lint` 0 errors / 0 warnings、`npm test` 1193 测试全通过、`npm run build` 与 `format:check` 验证全绿

- ✅ [项目规范债收口与安全依赖升级](Archive/2026-11/CONVENTION_DEBT_AND_SECURITY_PLAN.md) — Completed 2026-11-12
  - **安全**：Angular 全家桶 22.2.0 → 22.2.6（CDK 22.2.7），修掉 `@angular/router` DoS（`>=22.0.0 <22.2.1` 原锁定版本正落在漏洞区间）与 `zod <4.6.6` 内存耗尽两个 high 级漏洞；`npm audit --omit=dev` 现无 high
  - **门禁**：CI `lint-unit-build` job 补 `npm run lint` 步骤（此前仅 `format:check`，ESLint 从未真正把关）
  - **规范债**：5 处超 300 行组件的 inline template 拆为独立 `.component.html`（补 `preserveWhitespaces: true` 保留空白语义），行数 484→246 / 403→328 / 402→280 / 328→212 / 310→230
  - **死代码**：删除 `source-health.service.ts` + spec（P4 后零生产消费方），`tsconfig.app.json` include 登记同步移除，CONVENTIONS §exceptions 留痕
  - **覆盖率门禁**：vitest 阈值由 lines 50 / functions 60 / branches 80 / statements 50 收紧至 88 / 85 / 80 / 86（实测 93.62% / 90.75% / 86.19% / 91.68%）
  - **样式归位**：阅读页样式 `src/styles/reader.scss` → `src/app/pages/reader/reader.component.scss`（仍走全局引入，语义不变）
  - **文档**：README 与本索引的测试数 / 覆盖率 / e2e 数量 / lint 基线描述全部对齐实测值
  - 验收：lint 0/0、单测 74 文件 1186 用例全绿、e2e 21/21、双构建 + format:check 通过、AGENTS.md 机器校验全过

### 2026-10

- ✅ [项目性能与效率检查优化](Archive/2026-10/PROJECT_PERFORMANCE_OPTIMIZATION_PLAN.md) — Completed 2026-10-24；fullauto 分片 `project-perf-optimization`
  - P1 启动迁移改元数据扫描（`allDocs({include_docs:false})` + 旧格式候选按需 `get()`），过桥正文 20 条/120,000 B → 0 条/0 B，响应 124,061 B → 1,650 B
  - P2 换源孤儿按需清理（只传元数据，孤儿候选逐条读取并用最新 `_rev` 构造 tombstone），缩短集合 20 → 5 条
  - P3 浏览器后端动态 import 拆包：PouchDB 移入独立 lazy chunk（125.87 kB），main 552.33 → 425.93 kB，initial 1.78 → 1.66 MB、transfer 363.17 → 326.44 kB
  - `npm test` 1191 用例全绿（+14）、e2e 21/21、两处构建与 format:check 通过；改动文件 ESLint 0 问题，全仓 lint 43 errors/1 warning 为存量基线（**已于 2026-11 清零**，见本节 2026-11 条目）
  - 三视角验证 + 两轮外部审核全部 APPROVED；旧库迁移字节持平（+0.3%）如实记录，不宣称提速；遗留 8 条风险（含大库规模未测、真实 Electron GUI 未实测）

- ✅ [阅读时阻止系统睡眠 / 锁屏](Archive/2026-10/KEEP_AWAKE_WHILE_READING_PLAN.md) — Completed 2026-10-18
  - 新增应用级设置「电源 → 阅读时阻止系统睡眠」，进入阅读页申请唤醒锁、离开自动释放
  - 技术选型：主进程 `powerSaveBlocker`（`prevent-display-sleep`），经 Chromium WakeLock 映射到
    Windows `SetThreadExecutionState` / macOS `IOPMAssertion` / Linux `logind Inhibit`，一次 API 三平台生效
  - 幂等 + 失效 id 自愈：主进程「已持有则直接返回」，避免 signal 抖动 / 路由重入泄漏唤醒锁
  - 降级路径：无 systemd-logind 的 Linux 与浏览器调试模式标记 `supported=false`，设置项可见但不生效
  - 主进程 19 用例 + 渲染端 14 用例；外部审核循环 2 轮收口（Round 1 生命周期漏洞已修复，Round 2 APPROVED）；`npm test` 1177 用例全绿、`format:check` / 两处构建均通过（lint 44 个问题为分支存量，与本特性无关，**已于 2026-11 清零**）
  - 真机验收：三平台全部通过 —— Linux（Manjaro）2026-10-18；Windows / macOS 2026-10-19

### 2026-09（独立仓库阶段）

#### 依赖大版本升级（Angular 18→22 + 测试工具链 + zoneless）

- ✅ [依赖大版本升级（Angular 18→22 + 测试工具链）](Archive/2026-09/POMREADER_DEP_MAJOR_UPGRADE_PLAN.md) — Completed 2026-09-28
  - Phase 0（工具链）：@types/node 24 / jsdom 30 / vitest 3.2 / puppeteer-core 25 / engines + `.npmrc` engine-strict / CI Node 24
  - Phase 1–4：Angular 18→19→20→21→22 逐级迁移（ng-zorro/icons-angular/angular-eslint lockstep、构建器切 `@angular/build`、TS 5.5→6.0.3 pin 死）；分支 `chore/dep-major-upgrade` 合并回 main（`36b4c27`）后删除
  - Phase 5：vitest 5.0.2 / branches 覆盖率 60→80（实测 85.74%，5 路并行补 spec，700→892 用例）/ `@angular/build:unit-test` 评估不切换 / **zoneless 正式采纳**（阅读页人工复核通过后重放 spike）
  - spec 过程发现 5 处疑似生产 bug **全部修复**（import-via-source this 丢失 / db bookDelete 409 静默 / db 迁移死分支 / chapter-loader 部分缓存 / sandbox load 顺序），各带回归测试
  - P-0 预检顺带修复：e2e 验收门长期空跑（playwright 配置移根）、format:check 166 文件红门、worker-pool unhandled rejection
  - 最终状态：Angular 22.2.0 + ng-zorro 22.1.1 + TS 6.0.3 + vitest 5.0.2 + zoneless，892 用例 + e2e 全绿

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