# POMREADER 依赖大版本升级计划（Dep Major Upgrade Plan）

> Status: 🔄 In progress — 2026-09-27 建档；2026-09-28 复核修订 + **Phase 0 全部收口（P0-0 ~ P0-5）** + **Phase 1 完成（Angular 18 → 19）**。下一步：Phase 2 Angular 19 → 20（**起步前先手过一遍阅读页**，见 Phase 1 遗留的 effect() 时序风险）
> 分支：`chore/dep-major-upgrade`
> 触发：`npm outdated` 梳理（2026-09-27），安全项已先行升级并提交（`0bee9ba`）。
> 目标：Angular 18 → 22 逐级迁移 + 测试工具链升级，每级独立 commit、独立验证。

## 0. 现状与硬约束

| 依赖 | 当前 | 目标 | 约束 |
|---|---|---|---|
| Angular 全家桶 | 18.2.14 | 22.2.x | **必须逐级**（18→19→20→21→22），schematic 依赖前级迁移 |
| ng-zorro-antd | 18.2.1 | 22.x | 主版本与 Angular 严格一一对应（peer `@angular/core: ^22.0.0`），跟随升级 |
| **@ant-design/icons-angular** | 18.0.0 | 22.x | **必须与 ng-zorro 同步逐级**。ng-zorro 把它写死在 `dependencies` 而非 peer（19→`^19.0.0`，22.1.0→`^22.1.0`），漏跟会装出双份图标模块，`NzIconService` 取图标静默失败 |
| **angular-eslint** | 18.4.3 | 22.x | peer `@angular/cli: '>= 22.0.0 < 23.0.0'`，每个 Angular major 都得跟，漏跟 `npm run lint` 直接挂 |
| **@typescript-eslint** | 8.70.1 | 跟随 angular-eslint 22 | 满足 angular-eslint 22 的 `^8.0.0`；**TS 6.0 下的规则集未验证**，Phase 4 列为回归项 |
| typescript | 5.5.4 | **~6.0.x（pin）** | 逐级区间 19`>=5.5 <5.9` / 20`>=5.8 <6.0` / 21`>=5.9 <6.1` / 22`>=6.0 <6.1`；**严禁装到 7.x**（TS7 是 Go 重写版，Angular 暂不支持，angular/angular#69704） |
| zone.js | 0.14.10 | 0.15.x（19–21 peer `~0.15.0`）→ 22 可选 0.16（22 peer `~0.15.0 \|\| ~0.16.0`） | Angular 19 起必须升 |
| vitest + coverage-v8 | 2.1.9 | **3.2.x（Phase 0）→ 4.x（Phase 5）** | 上限由 **vite 下限**决定，不是发布方版本：vitest 3.2.4 依赖 `vite ^5 \|\| ^6 \|\| ^7`（与锁内 vite 5.4.21 兼容，**现在就能升**）；vitest 4 才要 `vite ^6 \|\| ^7`（被 Angular 18 挡住） |
| jsdom | 26.1.0 | 30.1.1 | engines `^22.22.2 \|\| ^24.15.0 \|\| >=26`（本机 v24.15.0 恰好踩线） |
| puppeteer-core | 23.11.1 | 25.12.0 | engines `>=22.12`；**25 起 ESM-only**，`scripts/*.cjs` 的 `require()` 需验证或改 `.mjs` |
| @types/node | 20.19.43 | **^24（不是 26）** | Electron 44 内置 Node 24.18.1；装 26 会暴露运行时没有的 API 类型。vitest 4 peer 也是 `^20 \|\| ^22 \|\| >=24`，与本项同向 |
| Node.js（开发） | 24.15.0 | ≥ 24.15 | Angular 22 engines `^22.22.3 \|\| ^24.15.0 \|\| >=26.0.0` |
| **Node.js（CI）** | **20.x（两个 job 都锁死）** | **24** | **Phase 0 blocker**：jsdom 30 / puppeteer-core 25 / Angular 22 全部要求 ≥22.12~24.15，Node 20 上必红。见 P0-0 |

已完成（不在本计划内）：electron-builder 26.17 / iconv-lite 0.7.3 / concurrently 10 / cross-env 10 / wait-on 9（commit `0bee9ba`）。

## P-0：预检（任何版本变动之前必须先绿）

> 2026-09-28 复核新增。缺了这一节，Phase 0 每一步的「`npm test` 通过」都是**无法判读**的信号：当前本机 `node_modules` 相对 `package.json` 已过期。

- [x] **P-0-1 `npm ci` + 钉死绿色基线**。当前实测 `npm test` = **2 failed | 52 passed（54 文件），677 用例通过**，失败原因是 `opencc-js` / `valibot` 解析不到（`node_modules` 里这俩 + `eslint` + `angular-eslint` 全缺失，`concurrently@9.2.4` / `cross-env@7.0.3` 报 `invalid`，早于 `0bee9ba`），**不是** vitest 行为差异。`npm run lint` 目前根本跑不起来。
  - 健康基线 = **54 文件 / 700 用例**（677 + 两个加载失败文件内的 23 个 `it`）。写入本节，后续每级与此比对。
- [x] **P-0-2 修好 e2e 验收门**。当前 `npx playwright test`（CI e2e job 与 `npm run e2e` 用的都是它）从仓库根跑：根目录无 `playwright.config.ts` → Playwright 回落默认配置、`testDir=cwd`、默认 `testMatch` 收 `**/*.spec.ts` → 误收 54 个 vitest spec，实测输出 **`Total: 0 tests in 0 files`**。真正的 19 个 e2e 只有显式指定配置时才被收集：`npx playwright test -c e2e/playwright.config.ts` → **`Total: 19 tests in 5 files`**。
  - 二选一：① 根目录加 `playwright.config.ts`（`testDir: 'e2e'`）；② `package.json` script 与 `.github/workflows/ci.yml` 同改 `-c e2e/playwright.config.ts`。
  - 不修的后果比没门更危险：每级「全量验证」会**静默漏掉整个 e2e 面**，而它在 CI 里显示为绿。
- [x] **P-0-3 每级附 `npm ls --depth=0` 无 missing/invalid 的输出**。本次正是它暴露了过期 `node_modules`；把它固化为升级 PR 的证据附件。
- [x] **P-0-4 修 `format:check` 红门（实施时新发现的 Blocker，见下）**。

## P-0 实施结果（2026-09-28，分支 `chore/dep-major-upgrade`）

| 项 | 结果 |
|---|---|
| P-0-1 | ✅ `npm ci` 完成；`npm ls --depth=0` 无 missing/invalid（valibot / opencc-js / eslint / angular-eslint 已就位，concurrently 10.0.5 / cross-env 10.1.0） |
| P-0-1 基线 | ✅ `npm test` = **54 文件 / 700 用例全通过**（与预测的 54/700 完全一致），耗时 53.59s |
| P-0-1 覆盖率基线 | ✅ All files **76.36% stmts / 81.91% branch / 83.14% funcs / 76.36% lines**（阈值 50/75/60/50 未触碰） |
| P-0-1 其他 | ✅ `npm run lint` 干净；`npm run build` 通过；esbuild 0.23.0 在 install-script 被 npm 12 拦下的情况下仍可用（平台二进制走 optional deps） |
| P-0-1 补充 | ⚠️ `npm run build:electron` **原本是红的**（tsc exit=2，3 处错误），非本次升级引入、CI 因更早的 format:check 中断从未跑到 → 已由 commit `427d4ea` 修复，现 `tsc --noEmit` 0 error、`build:electron` exit=0、700/700 回归通过 |
| P-0-2 | ✅ 采用方案 ①：commit `13072d8`，`git mv e2e/playwright.config.ts playwright.config.ts` + `testDir: './e2e'`。根目录 `npx playwright test --list` 现为 **`Total: 19 tests in 5 files`**，`package.json` 与 CI **无需改动**（`npm run e2e` / CI 的 `npx playwright test` 同一入口） |
| P-0-3 | ✅ 已纳入 P-0-1 实测；后续每级复跑 |
| P-0-4 | ✅ 用户拍板方案 ①，commit `dd26ab9`：165 文件按 `.prettierrc` 重排 + `**/__fixtures__/` 加入 `.prettierignore`。**五门全绿** |

### P-0-4：`format:check` 早已是红门，且它是 main 上 CI 唯一失败项

实施中实测发现，**不是本次升级引入的**：

- `npm run format:check` → `Code style issues found in **166 files**`（144 `.ts` / 12 `.html` / 7 `.scss` / 3 `.json`）
- `gh run list` 显示 main 最近 20 次 CI：**18 failure / 2 cancelled**；`gh run view --log-failed` 定位到唯一失败 step = `Prettier format check`，输出同样是 166 files
- 用 `prettier@3.4.0`（package.json 下限）复检结果**完全相同** → 排除 prettier 版本漂移，代码就是没按现有 `.prettierrc` 格式化过
- 差异形态属机械性：多行数组被折叠成单行（`"lib": ["ES2022", "dom"]`）、文件末尾缺换行
- 连带影响：CI 在该 step 中断 → **`npm test` / `ng build` / `build:electron` / e2e 这些后续 step 从未在 CI 上跑过**。也就是说 P-0-4 不修，任何升级 commit 的 CI 结论都无意义
- 与本计划的关系：`Phase 0 顶部验收命令块`含 `npm run format:check`，在这道门修好前**该命令块不可能全绿**

**处置（已执行）**：用户拍板方案 ①，实际落地为 commit `dd26ab9`，165 文件重排 + 1 项配置改动，`.prettierrc` 本身未动。

其中唯一带判断的决定是 **`**/__fixtures__/` 加入 `.prettierignore`**：`adapters/__fixtures__/*.html` 是抓取来的第三方原始字节（hetushu 19KB 页面 + xbiquge 两个片段），格式化等于改掉「被测输入」本身；且该文件还导致 `npm run format` **不收敛**（复位后单次全量 format 后 check 仍报它，需第二遍才干净，单文件 `prettier --write` 可绕过）。排除后已实测 format 幂等。三个夹具文件已复位为捕获原字节。

**P-0 收口状态**：`format:check` / `lint` / `test`（54 文件 700 用例）/ `build` / `build:electron` / `e2e --list`（19 tests 5 files）**本地全绿**，Phase 0 可以开工。

> ⚠️ 唯一未做的验证：`.html` 重排会重缩进 `@if`/`@for` 块内元素（`reader.component.html` 单文件 560 行），属视觉缩进而非结构变化，700 用例与两次 build 均通过，但**阅读页渲染空白未经人工目视复核**。Phase 1 之后 reader 组件的 `effect()` 时序才是真正高风险区，合并前建议手过一遍阅读页。


## Phase 0：测试工具链（不依赖 Angular，可立即做）

每步独立 commit，验收命令固定为（基线见 P-0-1）：

```bash
npm ci && npm run format:check && npm run lint && npm test && npm run build && npm run build:electron
npx playwright test --reporter=list   # 配置已在仓库根（P-0-2 修好），无需 -c
```

- [x] **P0-0 CI Node 20 → 24 + `.npmrc` `engine-strict=true`**：两个 job（`lint-unit-build` / `e2e`）的 `node-version` 都锁在 `'20'`，与本地 24.15.0 对齐后统一提到 `24`。`engine-strict` 缺了的话 `engines` 只是文档、装错版本也不拦。**本项必须先于 P0-2 / P0-4 落地**，否则那两个「可立即做」的步骤会在合并当天打断 CI。
- [x] **P0-1 `@types/node` → ^24.15.0**：对齐 Electron 44 内置 Node 24.18.1。顺带验证 `npm run build:electron`。
- [x] **P0-2 jsdom → ^30.1.1**：回归重点——v27 起 `element.click()` 派发 PointerEvent、v29 CSSOM 重写影响 `getComputedStyle` 断言。
- [x] **P0-3 vitest + @vitest/coverage-v8 → ^3.2.7**（**只到 3.x，4.x 留到 Phase 5**）：原计划写的阻塞理由「Angular 18 内置 vite 5.4，vitest 过不了 3.x」**已被证伪**——vitest 3.2.4 依赖 `vite ^5.0.0 || ^6.0.0 || ^7.0.0-0`，与锁内 vite 5.4.21 兼容；真正要 vite 6+ 的是 vitest 4。迁移清单——`spy.mockReset()` 行为变化、`vi.useFakeTimers()` 默认 toFake 移除、错误相等性更严格（`cause`/原型比对）。本项目 `mockReset` 0 处、`useFakeTimers` 7 处、`vi.mock` 3 个文件；worker-pool / sandbox 4 个 spec（`sandbox.spec.ts` / `worker-pool.spec.ts` / `worker-pool.factory.spec.ts` / `sandbox.pool.spec.ts`）是高风险区。
  - 升完顺手重跑一次 `npm run test:coverage` 记新基线（`include` 只覆盖 `core/logic`、`core/book-source`、`core/services`、`core/db`，阈值 lines 50 / functions 60 / branches 75 / statements 50），别等到 vitest 4 才发现分母变化。
- [x] **P0-4 puppeteer-core → ^25.12.0**：升级后立即跑 `scripts/` 下 5 个 `.cjs`（e2e-cf-guard / e2e-import-local-txt / e2e-import-online / e2e-search / e2e-txt-preview，均为 `require('puppeteer-core')`）验证 `require(esm)`；失败则改 `await import('puppeteer-core')` 或重命名 `.mjs`。**实测 `require(esm)` 直接可用，`.cjs` 无需改动**（详见下节）。
- [x] **P0-5 package.json 加 `engines: { "node": "^22.22.3 || ^24.15.0 || ^26.0.0" }`**：jsdom 30 / Angular 22 的 Node 底线前置声明，避免协作者环境踩坑。与 P0-0 的 `.npmrc` 配套。

## Phase 0 实施结果（2026-09-28，分支 `chore/dep-major-upgrade`）

| 项 | 结果 |
|---|---|
| P0-0 | ✅ `.github/workflows/ci.yml` 两个 job `node-version: '20'` → `'24'`；新增 `.npmrc`（`engine-strict=true`）。`engine-strict` 开启后 `npm ci` 仍成功（无 EBADENGINE），`npm ls --depth=0` 无 missing/invalid |
| P0-1 | ✅ `@types/node` `^20.14.0` → `^24.15.0`，实装 **24.19.0**。`npm run build:electron` exit=0（`electron/tsconfig.electron.json` 的 `types: ["node"]` 无报错） |
| P0-2 | ✅ `jsdom` `^26.1.0` → `^30.1.1`，实装 30.1.1。700 用例全通过 —— 计划担心的 `element.click()` PointerEvent 与 CSSOM `getComputedStyle` 两处均未触发回归 |
| P0-3 | ✅ `vitest` + `@vitest/coverage-v8` `^2.1.9` → `^3.2.7`，实装 3.2.7。**计划中列的三条迁移风险全部未命中**：`mockReset` 本就 0 处；7 处 `useFakeTimers` 无需改 `toFake`（该默认值在 vitest 2 已改过，2→3 无二次变更）；错误相等性未收紧到打破任何断言。`vi.mock` 的 3 个文件（`electron/window-state` / `electron/ipc/booksource-handler` / `electron/ipc/fetch-session`）全部通过 |
| P0-3 覆盖率新基线 | ✅ All files **74.96 stmts / 81.91 branch / 83.14 funcs / 74.96 lines**（阈值 50/75/60/50 未触碰）。**比 P-0-1 旧基线（76.36 / 81.91 / 83.14 / 76.36）低 1.40 个点，branch 与 funcs 完全不变** —— 差异集中在 statements/lines，符合 vitest 3 的 v8 provider 把 `include` 外的被打到过的文件计入分母，Phase 5 升 vitest 4 时应再记一次 |
| P0-3 顺带修复 | ✅ 修掉一处**既有测试污染**（详见下节） |

### 顺带发现并修复：`worker-pool.spec.ts` 的 unhandled rejection（非本次升级引入）

P0-1 全量验收时 vitest 汇总出现 `Errors 2 errors`，而 `Test Files 54 passed / Tests 700 passed` —— P-0-1 基线记录中无此项，属**非确定性泄漏**。

- 复现与定位：`Unhandled Rejection: Error: WorkerPool timeout after 100ms`，来源 `worker-pool.spec.ts:102-103` —— 「超出 pendingCap 应抛 PoolFullError」用例里排队的两个 `pool.schedule()` **既不 `deliverResult` 也不挂 catch**；测试结束后 100ms 定时器仍存活，触发 `reject` 后无人接管。数量与 errors 数**完全对上（2 个）**，互相印证。
- 危害：vitest 2 只记录不判失败，**vitest 3 之后这类 unhandled error 会升级为失败** —— 计划把 `worker-pool.spec.ts` 列为 P0-3 高风险区的原因正是它，此处得到实证。
- 修复（`worker-pool.spec.ts`，两处）：① 上述两个孤儿 promise 补 `.catch(() => {})`；② `makePool` 登记 pool 到 `pools`，新增 `afterEach` 统一 `terminate()`（`terminate()` 内会 `clearTimeout` 所有 pending 条目并 reject，测试层保证收尾）。**未改动 `worker-pool.ts` 生产代码**。
- 验证：该 spec 连跑 3 轮 `9 passed / 0 errors`；全量 54 文件 / 700 用例连跑 2 轮 `0 errors`。

### 本轮验证门（全绿）

`format:check` / `lint` / `test`（54 文件 700 用例 0 error）/ `build` / `build:electron` / `e2e --list`（19 tests in 5 files）。

> ⚠️ 换机遗留的干扰记录：升级 vitest 的第一次 `npm test` 因 tinypool 瞬时残留（`utils-B--2TaWv.js` 引用 vitest 2 的 `dist/worker.js` 路径）崩盘，遗留 2 个 `node (vitest N)` worker 进程空转 22 分钟、占 96% CPU，load average 冲到 137，导致紧随其后的一轮 `npm test` 耗时从 ~30s 劣化到 **534.94s** 并出现 3 个用例超时失败。**这 3 个失败是资源争抢的假阳性**：`pkill` 清理后复跑，700/700 全绿。换机后若首轮测试异常缓慢或大批超时，先 `ps -A -o pid,pcpu,etime,comm | rg vitest` 排查残留 worker，勿误判为 vitest 3 的行为回归。

### 外部审核状态（透明声明）

本轮 **未经外部审核 MCP 审核**。`coding-bridge` 与 `codex` 两个 provider 均为 `Failed to connect — connection timed out after 30000ms`（`claude mcp list` 实测），按降级链「调 prompt 重试 → 切 fallback provider → 自主完成」逐级降级后由我自行验证。后续步骤恢复时需补审。

---

## Phase 0 实施结果（第二批：P0-4 / P0-5，2026-09-28）

| 项 | 结果 |
|---|---|
| P0-4 | ✅ `puppeteer-core` `^23.11.1` → `^25.12.0`，实装 25.12.0。**计划担心的 `require(esm)` 断链没有发生**，5 个 `.cjs` 全部原样保留 |
| P0-5 | ✅ `package.json` 顶层加 `engines: { "node": "^22.22.3 \|\| ^24.15.0 \|\| ^26.0.0" }`。本机 Node 24.15.0 满足；`engine-strict=true` 下 `npm ci` / `npm install` 仍成功 |
| 附带修正 | 4 个脚本 `headless: 'new'` → `headless: true`（puppeteer 25 类型契约变更，详见下节） |

### P0-4：为什么 `.cjs` 不需要改写成 `.mjs`

计划原文预设了「`require(esm)` 失败则改 `await import()` 或重命名 `.mjs`」的兜底。**实测兜底不必要**，三条依据：

1. **包自身给了 `require` 条件**。`npm view puppeteer-core@25.12.0` 显示 `type: module`，但 `exports['.'.require` 显式指向同一个 ESM 文件 `./lib/puppeteer/puppeteer-core.js` —— 即包方主动支持 CJS 消费者，不是碰巧能用。
2. **Node 已 unflagged**。Node ≥22.12 起 `require(esm)` 正式支持（模块图内无 top-level await 即可）；本机 24.15.0 满足。P0-5 的 `engines` 下限 `^22.22.3` 也在此之上。
3. **实测**：`node -e "require('puppeteer-core')"` 在 `.cjs` 下 `typeof launch === 'function'`、`typeof connect === 'function'`、207 个导出；5 个脚本全部加载并执行到浏览器启动阶段，堆栈来自 `file:///.../puppeteer-core/lib/...`，证明 ESM 模块真的跑了。

进一步做了**真实浏览器**验证（不只到「能加载」为止）：

- 临时冒烟脚本（跑完即删，未入库）以 `executablePath` 指向 playwright 自带的 Chromium 153.0.8010.12，`puppeteer.launch()` 后逐个跑通 5 个脚本用到的 API：`goto` + `waitUntil: 'networkidle2'` / `type` / `evaluateHandle(...).asElement().click()` / `$` / `$$` / `$$eval` / `evaluate` / `screenshot` / `page.url()` / `browser.version()` / `browser.close()` / `pageerror`+`console` 监听 —— 断言全过，0 page error。
- 真实 `scripts/e2e-search.cjs` 用同一 Chromium 跑，链路走完 `require → launch → newPage → setViewport → goto`，止于 `net::ERR_CONNECTION_REFUSED 127.0.0.1:4200`（无 dev server），即**脚本自身代码路径在 v25 下无阻塞**。

### 附带修正：`headless: 'new'` 已不是合法值

puppeteer 25 的 `LaunchOptions.headless` 类型收紧为 `boolean | 'shell'`，字符串 `'new'` 不在其中。运行时并未报错（`ChromeLauncher.js:203` 是 `headless === 'shell' ? '--headless' : '--headless=new'`，`'new'` 为真值 → 产出与 `true` **完全相同**的 flag），但留着等于埋雷：将来谁把这批脚本迁到 TS 或加类型检查就会红。改为 `headless: true`，4 个文件各 1 行，语义零变化。

`e2e-cf-guard.cjs` **不需要改** —— 它不 launch 浏览器，而是 spawn 真实 Electron 后 `puppeteer.connect({ browserWSEndpoint })` 挂到其 DevTools 端口，文件里根本没有 `headless` 键（headed 窗口下该标志无意义）。

### 本批验收门（全绿）

`format:check` / `lint` / `test`（54 文件 700 用例 0 error，8.73s）/ `build` / `build:electron`（exit 0）/ `e2e --list`（19 tests in 5 files）/ `npm ls --depth=0`（无 missing/invalid/UNMET）。

### 外部审核状态

**Round 1/5 `NEEDS_CHANGES` → Round 2/5 `APPROVED`（session `1e9f1891`），代码零改动收口。** 三条 risk 全部以证据驳回：engines 下限「尚未发布」前提不成立（22.22.3 已发布且逐字取自 `@angular/core@22` engines）、`jsdom@30.1.1` 自身已要求 `^22.22.2` 故未新增负担、cf-guard 确无 `headless` 键、补注释违反项目「do not create unless necessary」。详见 `docs/Task/REVIEW_LOG.md`。

> ⚠️ 本批**未做**的验证（与上批同）：5 个脚本的**端到端业务行为**未在本机观察 —— 它们需要 dev server（`e2e-cf-guard.cjs` 还需 DISPLAY 与真实 CF 站点网络）。`puppeteer.connect()` 对真实 Electron 的路径**未**被覆盖，只覆盖了 `launch()`。这些脚本不在 `package.json` scripts、也不在 CI 中，属人工冒烟工具。

### 下一步

Phase 0 全部 6 项（P0-0 ~ P0-5）收口。**进入 Phase 1：Angular 18 → 19**（`@ant-design/icons-angular` + `angular-eslint` lockstep 跟随、zone.js → `~0.15.0`、`ng update ng-zorro-antd@19` 的 `<span nz-icon>` → `<nz-icon>` 迁移 8 文件 35 处、回归 reader 的 5 处 `effect()` 时序）。

另外，Phase 0 遗留两项**人工目视复核**仍未做，建议在 Phase 1 合并前一并处理：① P-0-4 的 `.html` 重排改了 reader 组件缩进，阅读页渲染未经人眼确认；② 5 个 `.cjs` 冒烟脚本在有 Chrome 的机器上跑一遍。

## Phase 1：Angular 18 → 19

- [x] `@ant-design/icons-angular` → `^19.0.0`、`angular-eslint` → `^19.8.1`（**lockstep，勿漏**）
- [x] TS 保持在 5.5.2（19 区间 `>=5.5 <5.9`，未动）；zone.js `~0.14.10` → `~0.15.1`
- [x] `ng update @angular/core@19 @angular/cli@19`（standalone 默认值翻转：24 个组件各删一处 `standalone: true`）
- [x] `ng update ng-zorro-antd@19` —— **`[nz-icon]` → `<nz-icon>` 的 schematic 迁移并不存在，计划前提有误；35 处 `<span nz-icon>` 经查证无需改动**（详见下节 F2）
- [x] 验证：六门全绿 + **e2e 首次实跑 19/19 通过**（详见下节 F4）

## Phase 1 实施结果（2026-09-28，分支 `chore/dep-major-upgrade`）

| 项 | 结果 |
|---|---|
| Angular 全家桶 | ✅ 18.2.x → **19.2.25**；`@angular/cli` / `@angular-devkit/build-angular` → **19.2.27** |
| ng-zorro-antd | ✅ `^18.2.1` → **^19.3.1**（迁移另自动改了 2 个 TS：`book-source-test` / `jump-chapter-dialog`） |
| @ant-design/icons-angular | ✅ `^18.0.0` → **^19.0.0**，且必须**显式**升（见 F3） |
| angular-eslint | ✅ `^18.4.3` → **^19.8.1**，子包齐刷刷 19.8.1，`eslint.config.js` **无需改动** |
| zone.js | ✅ `~0.14.10` → `~0.15.1`（`ng update` 自动完成） |
| typescript | ✅ 保持 `~5.5.2` 未动（compiler-cli@19 区间 `>=5.5 <5.9`） |
| 源码改动 | 24 个组件各删一行 `standalone: true,`；**0 处新增 `standalone: false`**；模板 / `electron/` / 各类配置**零改动** |
| 构建产物 | `src/assets/sandbox.worker.js` 有 esbuild codegen 括号差异（`(x)=>` → `((x)=>`），语义等价 |

### F1：执行顺序必须「Angular 核心先走」，原计划写反了

原计划 S3 是「先把 ng-zorro / icons / angular-eslint 一起升上去」。**这是错的**，实测可复现：

```
npm install ng-zorro-antd@19.3.1 @angular/core@18.2.14
→ npm error peer @angular/common@"^19.0.0" from ng-zorro-antd@19.3.1
```

ng-zorro 19 对 `@angular/*` 是 `^19.0.0` 严格 peer，Angular 还是 18 时必然 ERESOLVE。**正确顺序**：`ng update @angular/core@19 @angular/cli@19` → `ng update ng-zorro-antd@19` → icons / angular-eslint。第二次 `ng update` 需加 `--allow-dirty`（CLI 拒绝脏树；回滚锚点是干净的 `f90e1e8`，且 `--create-commits` 默认 `false`，提交权未交给 CLI）。

### F2：35 处 `<span nz-icon>` **不需要迁移**，原计划前提有误

计划写「靠 schematic 自动迁移后人工抽查 35 处」。**schematic 从来不处理这种用法** —— 拆开 ng-zorro 18.2.1 与 19.3.1 的 tarball 读源码，唯一涉及 icon 的规则 `icon-template-rule.js` 找的是 `findElementWithClassName(content, 'anticon', 'i')`，即裸 `<i class="anticon">`；**该规则在 18 与 19 之间逐字相同**，从来就不覆盖 `span[nzIcon]` 指令形态。实跑后 35 处一处未动。

进一步查证「不动是否安全」：

| | v18 | v19 |
|---|---|---|
| 载体 | `NzIconDirective` | `NzIconComponent` |
| selector | `[nz-icon]` | `nz-icon,[nz-icon]` —— **属性形态仍在**，只是新增了元素形态 |
| inputs | `nzSpin/nzRotate/nzType/nzTheme/nzTwotoneColor/nzIconfont` | **逐字相同** |

本项目只用到 `nzType`（34 处静态）与 `[nzType]`（1 处绑定），全部保留。**结论：35 处不改是安全的**，且不改才是对的 —— 它零功能收益，却有静默回归风险（图标取不到只是不渲染，**不抛异常**），在「本级不改行为」的 commit 里属于 scope creep。**列为独立技术债，不在本计划内。**

### F3：`@ant-design/icons-angular` 必须显式升，否则装出双份

`ng update ng-zorro-antd@19` 只更新了 ng-zorro 自身。实测 `npm ls` 出现：

```
├── @ant-design/icons-angular@18.0.0        ← 本项目的直接依赖，还钉在 18
└─┬ ng-zorro-antd@19.3.1
  └── @ant-design/icons-angular@19.0.0      ← ng-zorro 自己的依赖
```

icons-angular 是 ng-zorro 的**普通 dependency 而非 peer**，所以 npm 不会帮我们提升顶层那份 —— 双份图标模块一旦成型，`NzIconService` 取图标**静默失败**。显式 `npm install @ant-design/icons-angular@^19.0.0` 后已 deduped 为单份 19.0.0。

### F4：bundle 预算告警是**既有问题**，已实测基线

`npm run build` 报 `Budget 1.50 MB was not met by 319.05 kB with a total of 1.82 MB`。**没有假定是本次引入** —— stash 改动 + `npm ci` 还原 Angular 18 实测基线：

| | 预算 | 实际 initial | 结果 |
|---|---|---|---|
| 基线（Angular 18） | 1.57 MB | **1.77 MB**（超 196.86 kB） | ⚠️ 已有告警 |
| 本级（Angular 19） | 1.50 MB | **1.82 MB**（超 319.05 kB） | ⚠️ 告警，实增 **+50 kB / +2.8%** |

`angular.json` 的 budgets **未被 `ng update` 改动**（`maximumWarning 1.5MB` / `maximumError 2MB`）；1.82 MB 低于 2 MB error 线，**build exit=0**。两处「Budget」显示值不同（1.57 vs 1.50）是 CLI 的单位换算显示差异，配置值未变。+50 kB 属框架版本本身的正常增量。

> 附带纠正一处**陈旧记录**：归档计划里「prod bundle 611 kB」与两次实测（1.77 / 1.82 MB）都差了两个数量级，该数字已不可信。

### F5：e2e 首次**实跑**通过；先前的 6 个失败是孤儿 dev server 造成的假警报

本项目的 Playwright 配置带 `reuseExistingServer: true`。首次 `npx playwright test` 报 **6 failed / 13 passed**，报错是 `504 (Outdated Optimize Dep)` + `Failed to fetch dynamically imported module`（懒加载路由 chunk 拉不到）。**不是升级引入**：

- 根因是另一个（现已退出的）会话留下的**孤儿 `ng serve`**，已运行 18 分钟；Playwright 静默复用了它，而该进程早于本次两次 `npm ci`，服务的是与当前 `node_modules` 不一致的模块图
- Angular 19 把 dev server 默认换成 Vite，所以缓存失配的症状表现为 `Outdated Optimize Dep`
- 杀掉孤儿进程、让 Playwright 拉起全新 `ng serve` 后：**19/19 全部通过**（真实无头 Chromium）

**结论：本级 e2e 门从「只 `--list` 计数」升级为「真跑通过」，是本级验证强度最大的一处提升。**

### 本级验证门（全部 PASS）

| 门 | 结果 |
|---|---|
| `npm run format:check` | ✅（迁移后 24 文件曾转红，`npm run format` 后复绿） |
| `npm run lint` | ✅（angular-eslint 19 flat config 风险点，子包全 19.8.1，`eslint.config.js` 零改动） |
| `npm test` | ✅ **54 文件 / 700 用例** |
| `npm run build` | ✅ exit 0（含 F4 的既有预算告警） |
| `npm run build:electron` | ✅ exit 0（electron tsc 工程仍能用共享的 TS 5.5.2 编译） |
| `npx playwright test` | ✅ **19/19 真实浏览器通过** |
| `npm ls --depth=0` | ✅ 无 missing/invalid/UNMET，icons-angular 已 deduped |

### 外部审核

**需求轮 `NEEDS_CHANGES` → 计划轮 `APPROVED` → 代码轮 `APPROVED`（session `03a593ba`）。** 其中 F1（排序错误）与「风险面过窄」两条被审核方命中并已修正；「tslib 需升到 ^2.6.1」一条经查证驳回 —— tslib 在 Angular 各包中是普通 `dependencies: ^2.3.0`（v18/v19 一致）而非 peer，对使用方不构成约束，本地已装 2.8.1（registry 最新）。代码轮另外确认了 F2（不迁移 nz-icon）与 F4（e2e 实跑）的判断。详见 `docs/Task/REVIEW_LOG.md`。

### ⚠️ 本级唯一未闭环的风险：effect() 时序

Angular 19 改变了「CD 外触发的 effect」的调度时机。本项目 **12 处 `effect()` 分布在 6 个生产文件，其中 `reader.component.ts` 占 5 处**，阅读页的翻页测量与简繁转换都对其时序敏感。

- 覆盖情况：700 个单测全绿 + 19 个 e2e 冒烟通过，但 **e2e 的 reader 用例是浅的**（stub 路由 + 缺数据场景），**未触达翻页测量与简繁转换这两条具体路径**
- 本机无 GUI，**未做人工目视复核**
- 处置：如实记为未验证项，不宣称通过。**Phase 2 起步前应先手过一遍阅读页**；若后续出现阅读页异常，优先怀疑此项

## Phase 2：Angular 19 → 20

- [ ] `@ant-design/icons-angular` → `^20.x`、`angular-eslint` → `^20.x`（lockstep）
- [ ] TS → `~5.8.x`；Node 需 ≥20.19/22.12/24（已满足）
- [ ] **构建器 `@angular-devkit/build-angular` → `@angular/build`**（webpack 传递依赖移除；本项目已是 `:application` esbuild 构建器，改动小）
- [ ] `ngIf/ngFor` 标记 deprecated：清掉 3 个残留文件（`modals/import-online/import-online.component.html` / `modals/import-legado/import-legado.component.ts` / `shared/components/change-book-source-dialog/change-book-source-dialog.component.ts`）
- [ ] `ng update ng-zorro-antd@20`：`nz-tabset`→`nz-tabs` 等重命名 —— **已扫描确认本项目未用，可直接结案**
- [ ] 检查点：~~`ng-reflect-*` 不再输出，e2e/Playwright 选择器若依赖需改~~ —— **已扫描确认全仓 0 引用，不适用**；模板表达式 `void`/`in` 新语义

## Phase 3：Angular 20 → 21

- [ ] `@ant-design/icons-angular` → `^21.x`、`angular-eslint` → `^21.x`（lockstep）
- [ ] TS → `~5.9.x`
- [ ] `ng update` 自动补 `provideZoneChangeDetection()`（本项目 `app.config.ts` 已显式写了 `provideZoneChangeDetection({ eventCoalescing: true })`，迁移后确认不被重复注入）
- [ ] `ng update ng-zorro-antd@21`：`NzDropDownModule` → `NzDropdownModule`（**本地 2 处**：`pages/universal-search/universal-search.component.ts:16`、`shared/components/page-header/page-header.component.ts:9`）；`NzToolTip*` → `NzTooltip*`；可移除 `@angular/animations`（ng-zorro 迁移到原生动画）——**已确认全仓仅 `app.config.ts` 一处 `provideAnimations()`**
- [ ] 检查点：路由导航多走微任务，时序敏感的测试回归；`lastSuccessfulNavigation` 变 signal（`app.routes.ts` 5 条顶层路由 + 2 处 `loadChildren`，**未用**，确认即可）

## Phase 4：Angular 21 → 22

- [ ] **先 pin `typescript@~6.0.2`**（严禁 7.x）；Node 20 移除（已满足）
- [ ] `@ant-design/icons-angular` → `^22.x`、`angular-eslint` → `^22.x`（lockstep）；**回归 `@typescript-eslint` 8.70.1 在 TS 6.0 下的规则集**（见 §0 约束列）
- [ ] `ng update`：自动迁移 `ChangeDetectionStrategy.Default` → `Eager`、http `withXhr`、tsconfig `strictTemplates`（`strictTemplates` 已开，见 `tsconfig.json`）
- [ ] **路由 `paramsInheritanceStrategy` 默认 `'emptyOnly'` → `'always'`**：本地路由全平铺（`/reader/:bookId/:chapterId` 顶层，book-source/settings 用 `loadChildren` 无参数继承），**预期无影响**，升级后回归确认；异常则显式设回 `'emptyOnly'`
- [ ] `ng update ng-zorro-antd@22`：全组件 OnPush（与项目策略一致，CI 有 OnPush 100% 强制检查）；`NzDropDownModule` 别名删除（Phase 3 必须改完）；`nz-input-group` 删除 —— **已扫描确认本项目未用，可直接结案**
- [ ] **Electron 侧验证**：`electron/tsconfig.electron.json` 共享同一 `typescript` 包（`module: CommonJS` / `moduleResolution: node` / `types: ["node"]`），TS 6.0 下重跑 `npm run build:electron`

## Phase 5：收尾（Angular 22 稳定后，可拆独立任务）

- [ ] vitest 3.2.7 → **4.1.11**（`V4` tag 当前最新；`5.0.0-rc.4` 已存在）：vite 已随 Angular 升级解封；升 4 注意 `coverage.all` 默认 true、`clearMocks` 默认 true、嵌套 `vi.mock` 抛错、未 await 的 `.resolves/.rejects` 判失败（本地 `test.sequential` 0 处，已确认）；**若考虑跳到 vitest 5，先核对其 vite 下限**（计划原文写「5 需 vite ≥6.4」，未复核）
- [ ] 或评估切换 `@angular/build:unit-test`（Angular 21+ 官方 vitest builder，内部 pin vite/vitest 版本）
- [ ] 可选 schematic：signal-input / output / inject 迁移
- [ ] 可选：zoneless 评估（`provideZonelessChangeDetection`，ng-zorro 22 已兼容）

## 全局风险与对策

1. **每级升级后必须全量验证**，命令见 Phase 0 顶部（e2e 配置已移至仓库根，直接 `npx playwright test` 即可，P-0-2 已修），外加手工过一遍阅读页（翻页测量/简繁转换对 effect 时序敏感）。
2. **不许跳级**：schematic 逐级依赖，跳级漏自动修复。
3. **TS 版本 pin 死**：各级区间 5.5（19）/ 5.8（20）/ 5.9（21）/ ~6.0（22），`~` 前缀防 npm 装到 7.x。
4. **lockstep 依赖不得漏跟**：`ng-zorro-antd` / `@ant-design/icons-angular` / `angular-eslint` 三者主版本必须同帧移动（前者 peer 校验，后两者是硬依赖 / CLI peer）。
5. **覆盖配置变化**：vitest 4 起 `coverage.all` 默认 true，本项目阈值（lines 50 / functions 60 / branches 75）可能因分母变大而失败，到时收紧 `include` 或调阈值。P0-3 结束时应已记好新基线。
6. **回滚策略**：每级独立 commit，升级失败直接 revert 该 commit；升级期间冻结其他依赖变动。

## 复核记录（2026-09-28）

对全表 + 全 Phase 逐条核对 npm registry 与本仓代码，结论：**版本矩阵（TS 区间 / Node engines / zone peer / ng-zorro peer）与全部硬编码迁移点准确**；发现并已修正下列问题。

| # | 级别 | 问题 | 处置 |
|---|---|---|---|
| 1 | **Blocker** | CI 两个 job 锁 `node-version: '20'`，与 §0 写的「Node 开发/CI 24.15.0」不符；jsdom 30 / puppeteer-core 25 / Angular 22 全部要求 ≥22.12~24.15，P0-2 / P0-4 合并当天必红 CI | §0 拆出独立的 CI Node 行；新增 **P0-0** 提到最前 |
| 2 | **Blocker** | 无绿色基线。本机 `node_modules` 相对 `package.json` 过期（`valibot`/`opencc-js`/`eslint`/`angular-eslint` 缺失，`concurrently`/`cross-env` invalid），`npm test` 实测 2 failed / 677 passed，失败源于依赖缺失而非 vitest 行为 | 新增 **P-0 预检节**，钉死 54 文件 / 700 用例基线 + `npm ls` 证据附件 |
| 3 | 事实错误 | 「Angular 18 内置 vite 5.4，vitest 过不了 3.x」**证伪**：vitest 3.2.4 依赖 `vite ^5 \|\| ^6 \|\| ^7`，与 vite 5.4.21 兼容；vitest 4 才是 `^6 \|\| ^7`。「3.2.x（当前上限）」也不准（`V4` 已 4.1.11、`5.0.0-rc.4` 已发布） | P0-3 改为「只到 3.2.7」并改正理由；3→4 留 Phase 5；§0 vitest 行改为双目标 |
| 4 | 遗漏 | §0 表漏了 3 个必须同步升级的包，其中 `@ant-design/icons-angular` 是 ng-zorro 的**硬依赖**（非 peer），漏跟会装出双份图标模块 | §0 补 3 行；Phase 1–4 各加 lockstep 条目；全局风险新增第 4 条 |
| 5 | 门失效 | e2e 验收门空跑：`npx playwright test` 从根目录跑（CI 与 `npm run e2e` 均为此命令）实测 `Total: 0 tests in 0 files`，会误收 54 个 vitest spec；真 e2e 需 `-c e2e/playwright.config.ts`（19 tests / 5 files） | 新增 **P-0-2** 修门；Phase 0 顶部固定验收命令 |
| 6 | 表述 | 「`nz-icon` 18 个文件」含混：18 是 ts+html 合计，实际 **8 个 HTML 文件 / 35 处 `<span nz-icon>`** | Phase 1 改为按 35 处抽查 |
| 7 | 可结案 | Phase 2/4 的「扫描确认」项已可提前结案：`nz-tabset` 0、`nz-input-group` 0、`ng-reflect-*` 0 引用 | 划线标注「已确认未用」 |

**未改动**（复核认为原文正确）：TS 四级区间、Angular 22 engines、jsdom 30.1.1 engines、zone peer 曲线、ng-zorro↔Angular 一一对应、TS7 禁用理由、`NzDropDownModule` 2 处、`ngIf/ngFor` 3 文件、`test.sequential` 0 处、worker-pool/sandbox 4 spec 风险判断、`paramsInheritanceStrategy` 无影响预期、commit `0bee9ba` 存在性。

**遗留待办**：`@ant-design/icons-angular` 在 ng-zorro 20 / 21 档的确切 range 未复核（19 与 22 已确认），到达对应阶段时以 `npm view ng-zorro-antd@<major> dependencies.@ant-design/icons-angular` 为准；vitest 5 的 vite 下限未复核。

## 参考来源

- [angular.dev 版本兼容表](https://angular.dev/reference/versions) · [update.angular.dev](https://angular.dev/update-guide)
- Angular [v19](https://github.com/angular/angular/releases/tag/v19.0.0) / [v20](https://github.com/angular/angular/releases/tag/20.0.0) / [v21](https://github.com/angular/angular/releases/tag/21.0.0) / [v22](https://github.com/angular/angular/releases/tag/v22.0.0) release notes；[Announcing Angular v22](https://blog.angular.dev/announcing-angular-v22-c52bb83a4664)
- ng-zorro changelog（https://ng.ant.design/docs/changelog/en）
- Vitest Migration Guide（https://vitest.dev/guide/migration/）· jsdom Releases（https://github.com/jsdom/jsdom/releases）· Puppeteer CHANGELOG（https://pptr.dev/CHANGELOG）
- Electron v44.0.0 Release Notes（https://releases.electronjs.org/release/v44.0.0，Chromium 152 + Node 24.18.1）
- TS 7 GA（InfoQ）https://www.infoq.com/news/2026/08/typescript-7-released/ · Angular TS7 支持请求 https://github.com/angular/angular/issues/69704
- **registry 实测（2026-09-28，`npm view`）**：`@angular/compiler-cli@19/20/21/22` 的 `peerDependencies.typescript`；`@angular/core@19..22` 的 `peerDependencies.zone.js` 与 `engines`；`ng-zorro-antd@22.1.0` 的 peer/dependencies；`vitest@2.1.9 / 3.2.4 / 4.0.0` 的 `dependencies.vite`；`jsdom@30.1.1` / `puppeteer-core@25.12.0` 的 `engines`；`angular-eslint@22` 的 peer
