# POMREADER 依赖大版本升级计划（Dep Major Upgrade Plan）

> Status: Draft — 2026-09-27
> 触发：`npm outdated` 梳理（2026-09-27），安全项已先行升级并提交（`0bee9ba`）。
> 目标：Angular 18 → 22 逐级迁移 + 测试工具链升级，每级独立 commit、独立验证。

## 0. 现状与硬约束

| 依赖 | 当前 | 目标 | 约束 |
|---|---|---|---|
| Angular 全家桶 | 18.2.x | 22.2.x | **必须逐级**（18→19→20→21→22），schematic 依赖前级迁移 |
| ng-zorro-antd | 18.2.1 | 22.x | 主版本与 Angular 严格一一对应，跟随升级 |
| typescript | 5.5.4 | **~6.0.x（pin）** | Angular 22 锁死 `>=6.0 <6.1`；**严禁装到 7.x**（TS7 是 Go 重写版，Angular 暂不支持，angular/angular#69704） |
| zone.js | 0.14.10 | 0.15.x（19 起）→ 可选 0.16（21 起） | Angular 19 peer 要求 `~0.15.0` |
| vitest + coverage-v8 | 2.1.9 | **3.2.x（当前上限）** | Angular 18 的 build-angular 内置 vite 5.4；vitest 4 需 vite 6+、5 需 vite ≥6.4。**Angular 升完前 vitest 过不了 3.x** |
| jsdom | 26.1.0 | 30.1.1 | 要求 Node ^22.22.2 \|\| ^24.15.0 \|\| ≥26（本机 v24.15.0 恰好踩线） |
| puppeteer-core | 23.11.1 | 25.12.0 | **25 起 ESM-only**，`scripts/*.cjs` 的 `require()` 需验证或改 `.mjs` |
| @types/node | 20.19.43 | **^24（不是 26）** | Electron 44 内置 Node 24.18.1；装 26 会暴露运行时没有的 API 类型 |
| Node.js（开发/CI） | 24.15.0 | ≥ 24.15 | Angular 22 要求 ^22.22.3 \|\| ^24.15.0 \|\| ^26.0.0；建议 package.json 加 `engines` 收紧 |

已完成（不在本计划内）：electron-builder 26.17 / iconv-lite 0.7.3 / concurrently 10 / cross-env 10 / wait-on 9（commit `0bee9ba`）。

## Phase 0：测试工具链（不依赖 Angular，可立即做）

每步独立 commit，跑 `npm test`（698+ 用例）验证。

- [ ] **P0-1 `@types/node` → ^24.15.0**：对齐 Electron 44 内置 Node 24.18.1。顺带验证 `npm run build:electron`。
- [ ] **P0-2 jsdom → ^30.1.1**：回归重点——v27 起 `element.click()` 派发 PointerEvent、v29 CSSOM 重写影响 `getComputedStyle` 断言。
- [ ] **P0-3 vitest + @vitest/coverage-v8 → ^3.2.x**：迁移清单——`spy.mockReset()` 行为变化、`vi.useFakeTimers()` 默认 toFake 移除、错误相等性更严格（`cause`/原型比对）。worker-pool / sandbox 相关 spec 是高风险区。
- [ ] **P0-4 puppeteer-core → ^25.12.0**：升级后立即跑 `scripts/` 下 5 个 `.cjs` 脚本（e2e-cf-guard / e2e-import-local-txt / e2e-import-online / e2e-search / e2e-txt-preview）验证 `require(esm)`；失败则改 `await import('puppeteer-core')` 或重命名 `.mjs`。
- [ ] **P0-5 package.json 加 `engines: { "node": "^22.22.3 || ^24.15.0 || ^26.0.0" }`**：jsdom 30 / Angular 22 的 Node 底线前置声明，避免协作者环境踩坑。

## Phase 1：Angular 18 → 19

- [ ] TS 升到 5.5–5.8 区间（`~5.5.4` 可先不动，19 兼容 `<5.9`）；zone.js → `~0.15.0`
- [ ] `ng update @angular/core@19 @angular/cli@19`（standalone 默认值翻转：本项目已全 standalone，影响小）
- [ ] `ng update ng-zorro-antd@19`：**`[nz-icon]` 属性选择器 → `<nz-icon>` 标签**（本地 18 个文件用 `<span nz-icon>`，靠 schematic 自动迁移后人工抽查）；`nzClass/nzStyle` 不再支持 Set
- [ ] 验证：build + vitest + e2e；**关注 `effect()` 时序变更**（CD 外触发的 effect 改为 CD 流程内运行）——reader 组件有大量 effect，重点回归翻页测量与简繁转换

## Phase 2：Angular 19 → 20

- [ ] TS → `~5.8.x`；Node 需 ≥20.19/22.12/24（已满足）
- [ ] **构建器 `@angular-devkit/build-angular` → `@angular/build`**（webpack 传递依赖移除；本项目已是 `:application` esbuild 构建器，改动小）
- [ ] `ngIf/ngFor` 标记 deprecated：清掉 3 个残留文件（import-online html / import-legado / change-book-source-dialog）
- [ ] `ng update ng-zorro-antd@20`：`nz-tabset`→`nz-tabs` 等重命名（本项目未用 tabset，扫描确认即可）
- [ ] 检查点：`ng-reflect-*` 不再输出——**e2e/Playwright 选择器若依赖需改**；模板表达式 `void`/`in` 新语义

## Phase 3：Angular 20 → 21

- [ ] TS → `~5.9.x`
- [ ] `ng update` 自动补 `provideZoneChangeDetection()`（保留 zone.js 行为不变）
- [ ] `ng update ng-zorro-antd@21`：`NzDropDownModule` → `NzDropdownModule`（**本地 2 处**：universal-search、page-header）；`NzToolTip*` → `NzTooltip*`；可移除 `@angular/animations`（ng-zorro 迁移到原生动画）
- [ ] 检查点：路由导航多走微任务，时序敏感的测试回归；`lastSuccessfulNavigation` 变 signal（本项目未用，确认）

## Phase 4：Angular 21 → 22

- [ ] **先 pin `typescript@~6.0.2`**（严禁 7.x）；Node 20 移除（已满足）
- [ ] `ng update`：自动迁移 `ChangeDetectionStrategy.Default` → `Eager`、http `withXhr`、tsconfig `strictTemplates`
- [ ] **路由 `paramsInheritanceStrategy` 默认 `'emptyOnly'` → `'always'`**：本地路由全平铺（`/reader/:bookId/:chapterId` 顶层，book-source/settings 用 loadChildren 无参数继承），预期无影响，升级后回归确认；异常则显式设回 `'emptyOnly'`
- [ ] `ng update ng-zorro-antd@22`：全组件 OnPush（与项目策略一致）；`NzDropDownModule` 别名删除（Phase 3 必须改完）；`nz-input-group` 删除（扫描确认未用）
- [ ] **Electron 侧验证**：`electron/tsconfig.electron.json` 共享同一 `typescript` 包，TS 6.0 下重跑 `npm run build:electron`

## Phase 5：收尾（Angular 22 稳定后，可拆独立任务）

- [ ] vitest 4/5：vite 已随 Angular 升级解封；升 5 注意 `clearMocks` 默认 true、嵌套 `vi.mock` 抛错、未 await 的 `.resolves/.rejects` 判失败（本地无 `test.sequential`，已确认）
- [ ] 或评估切换 `@angular/build:unit-test`（Angular 21+ 官方 vitest builder，内部 pin vite/vitest 版本）
- [ ] 可选 schematic：signal-input / output / inject 迁移
- [ ] 可选：zoneless 评估（`provideZonelessChangeDetection`，ng-zorro 22 已兼容）

## 全局风险与对策

1. **每级升级后必须全量验证**：`npm test` + `npm run build` + `npm run build:electron` + e2e（Playwright）+ 手工过一遍阅读页（翻页测量/简繁转换对 effect 时序敏感）。
2. **不许跳级**：schematic 逐级依赖，跳级漏自动修复。
3. **TS 版本 pin 死**：各级区间 5.5（19）/ 5.8（20）/ 5.9（21）/ ~6.0（22），`~` 前缀防 npm 装到 7.x。
4. **覆盖配置变化**：vitest 4 起 `coverage.all` 默认 true，本项目阈值（lines 50 / functions 60 / branches 75）可能因分母变大而失败，到时收紧 `include` 或调阈值。
5. **回滚策略**：每级独立 commit，升级失败直接 revert 该 commit；升级期间冻结其他依赖变动。

## 参考来源

- [angular.dev 版本兼容表](https://angular.dev/reference/versions) · [update.angular.dev](https://angular.dev/update-guide)
- Angular [v19](https://github.com/angular/angular/releases/tag/v19.0.0) / [v20](https://github.com/angular/angular/releases/tag/20.0.0) / [v21](https://github.com/angular/angular/releases/tag/21.0.0) / [v22](https://github.com/angular/angular/releases/tag/v22.0.0) release notes；[Announcing Angular v22](https://blog.angular.dev/announcing-angular-v22-c52bb83a4664)
- [ng-zorro changelog](https://ng.ant.design/docs/changelog/en)
- [Vitest Migration Guide](https://vitest.dev/guide/migration/) · [jsdom Releases](https://github.com/jsdom/jsdom/releases) · [Puppeteer CHANGELOG](https://pptr.dev/CHANGELOG)
- [Electron v44.0.0 Release Notes](https://releases.electronjs.org/release/v44.0.0)（Chromium 152 + Node 24.18.1）
- [TS 7 GA（InfoQ）](https://www.infoq.com/news/2026/08/typescript-7-released/) · [Angular TS7 支持请求 #69704](https://github.com/angular/angular/issues/69704)
