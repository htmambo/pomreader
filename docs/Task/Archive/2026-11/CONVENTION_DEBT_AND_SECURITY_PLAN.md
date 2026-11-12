# 任务计划：项目规范债收口与安全依赖升级

**Status**: ✅ Completed (completion time: 2026-11-12)  
**Creator**: Claude Code  

## 1. 任务背景与目标
承接上一轮「ESLint 存量报错修复」的全仓深度梳理结果，针对梳理中发现的 7 类实质问题（P0 阻塞项 / P1 规范债 / P2 优化项）逐项实施整改，将项目质量基线从「问题已记录」推进到「问题已根治 + 有门禁防复发」。

## 2. 子任务清单与状态

### P0 — 阻塞合并项
- [x] **T-1** ✅ CI 流水线补 `npm run lint` 门禁（`.github/workflows/ci.yml` 的 `lint-unit-build` job，位于 `npm ci` 之后、Prettier 检查之前）
- [x] **T-2** ✅ Angular 全家桶 22.2.0 → **22.2.6**（`@angular/cdk` 同步 22.2.7），修掉 `@angular/router` DoS 与 `@angular/forms` 嵌套 `zod <4.6.6` 两个 high 级漏洞

### P1 — 规范债
- [x] **T-3** ✅ 5 处 inline template 组件拆分 `.component.html`（AGENTS.md 300 行硬规则）：
  `change-book-source-dialog`（484→246）/ `cover-generator-dialog`（403→328）/ `universal-search`（402→280）/ `import-legado`（328→212）/ `book-card`（310→230）
- [x] **T-4** ✅ 删除死代码 `source-health.service.ts` + 其 spec，同步移除 `tsconfig.app.json` include 登记，CONVENTIONS §exceptions 留痕
- [x] **T-5** ✅ 修正 README 与 `docs/Task/README.md` 的失真数据（测试数 978→1186 / 63→74 files、覆盖率 92.88→93.62% 等、e2e 19→21 tests、lint 基线描述）

### P2 — 优化项
- [x] **T-6** ✅ 收紧 `vitest.config.ts` 覆盖率阈值：lines 50→88、functions 60→85、branches 80→80（持平）、statements 50→86（按实测留 2-6pp 缓冲）
- [x] **T-7** ✅ 阅读页样式从 `src/styles/reader.scss` 归位至 `src/app/pages/reader/reader.component.scss`（与组件同目录就近维护，仍经 `styles.scss` 全局引入）

## 3. 实施偏差记录

- **T-7 未采用组件 `styleUrls`**：阅读页样式跨 ng-zorro color-picker 内部节点（第三方组件模板），组件级作用域隔离无法覆盖；且体量 ~19 kB 超出 `anyComponentStyle` 预算（16 kB 错误线），走组件通道会直接构建失败。改为「文件与组件同目录 + 仍走全局引入」，既满足就近维护意图，又保持选择器语义与迁移前逐字一致（产物 CSS 解析结果不变，已核对 `/assets/...` 路径与资源存在性）。
- **T-2 升级过程中遇到 npm 11.12.1 的 Angular 精确 peer 解析冲突**：`@angular/platform-browser@22.2.0` 的 `peerOptional @angular/animations@"22.2.0"` 精确锁死旧版本链，增量 `npm install` / `npm update` 均报 ERESOLVE。解法：移除旧 lockfile 后全量重解析（`npm install --package-lock-only`），使 Angular 全家桶整组同版本移动。

## 4. 验收结果

- `npm run lint` → **0 errors / 0 warnings** ✅
- `npm test` → **74 文件 / 1186 用例全绿**（-7 = 删除的 source-health spec）✅
- `npm run test:coverage` → 93.62% 行 / 86.19% 分支 / 90.75% 函数 / 91.68% 语句，**新阈值下 exit 0** ✅
- `npm run build` + `npm run build:electron` → 双构建通过 ✅
- `npm run format:check` → 全仓匹配 ✅
- `npx playwright test` → **21/21 全绿** ✅
- `npm audit --omit=dev` → 无 high 级（仅剩 `pouchdb-browser` 传递的 `uuid` moderate，修复需降级 major，不处理）✅
- AGENTS.md 机器校验（inline template 300 行阈值 / OnPush 100%）→ 全部通过 ✅

## 5. 外部审查记录（coding-bridge Round 1）

外部审查共提 10 条，逐条实测核对后：**7 条证伪或属既有状态**（未引入回归），**3 条确认成立但超出本次范围**，已转入 [工程基线后续优化项](../../Active/ENGINEERING_BASELINE_FOLLOWUPS.md) 的 S-1/S-2/S-3。

证伪要点（均经实测，非推断）：

- `/assets/` 绝对路径「子路径部署会断裂」→ 实测**迁移前**产物 CSS 本就是 `url(/assets/...)`，本次改动逐字等价，未引入回归（见 S-2 留档）。
- `source-health.service.ts` 悬空引用 → `rg` 全仓零引用；README 结构树与 `tokens.scss` / `ng-zorro-overrides.scss` 注释中的过期提及已同步修正。
- 覆盖率阈值「跳跃过大无缓冲」→ 阈值按实测值 -2~6pp 设定，非边界值。
- 5 处模板拆分「逻辑丢失」→ 逐组件比对绑定集合（37 / 14 / 18 / 19 / 14 项）全部逐字一致；`change-book-source-dialog` 行数减少 49% 系模板与样式抽出所致。
- `no-undef` 关闭「可能覆盖 JS 文件」→ 该规则块 `files: ['**/*.spec.ts']`；且 `tseslint.configs.recommended` 本身已含 `no-undef: 'off'`，显式写入仅为文档化意图（已补注释说明）。

另据审查补强：第二处 `no-undef` 补注释（风格一致性）。
