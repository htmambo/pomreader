# 阅读时阻止系统睡眠 / 锁屏 —— 任务计划

**Status**: ✅ Completed (completion time: 2026-10-18)
**Creator**: mavis
**Scope**: Electron 主进程（新增 IPC 模块）+ preload + 渲染端设置模型 / service / 阅读页 / 设置页

---

## 1. 任务目标与背景

阅读器用户在长篇阅读时经常遇到：系统空闲若干分钟后自动息屏并锁屏，阅读进度被打断、
需要重新点亮屏幕解锁才能继续。

目标：新增一个应用级设置「阅读时阻止系统睡眠」，在用户处于阅读界面
（`/reader/:bookId/:chapterId` 路由激活）期间阻止系统进入睡眠/息屏，从而阻止自动锁屏。

## 2. 现状与技术调研

### 2.1 跨平台阻止睡眠/锁屏的机制

三平台**系统原生**层面的手段：

**Windows**
- `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED [| ES_DISPLAY_REQUIRED])`。
  `ES_CONTINUOUS` 把线程置为持续模式，`ES_SYSTEM_REQUIRED` 阻止系统睡眠，
  `ES_DISPLAY_REQUIRED` 额外阻止显示器熄灭。该标志是 **thread-sticky**，
  因此需要一个常驻线程持有。
- 附带副作用：`ES_DISPLAY_REQUIRED` 会重置「屏幕保护程序空闲计时器」，
  所以自动锁屏（Win+L / 锁屏屏保）也随之被压制 —— 这正是本需求的效果。
- 命令行等价物：`powercfg /change standby-timeout-ac 0`（全局改系统设置，侵入性太强，不采用）。

**macOS**
- `IOPMAssertionCreateWithName()`（IOKit Power Assertions）。
  `prevent-app-suspension` → `kIOPMUserActiveAssertion`（仅防系统睡眠）；
  `prevent-display-sleep` → `kIOPMNoDisplaySleepAssertion`（防显示器睡眠，含合盖外场景）。
  二者都会重置空闲计时，因此空闲锁屏被阻止。
- 命令行等价物：`caffeinate -d -i <cmd>`（外部进程，需要生命周期管理，不采用）。
- 注意：合盖（lid close）走硬件传感器，Power Assertion 无法覆盖 —— 这是系统限制。

**Linux**
- 有 systemd-logind 时：DBus `org.freedesktop.login1.Manager.Inhibit`，
  `what=idle:sleep`，返回的 fd 需持有，释放即解锁。GNOME / KDE / XFCE / MATE 均遵循。
- 无 logind / 非 systemd 桌面（部分 Wayland 合成器、发行版自定义 DE）：
  DBus 调用可能失败，能力**不可用**，需优雅降级（设置项可见但标注不生效）。
- 命令行等价物：`systemd-inhibit --what=idle --why="..." <cmd>`（同样不采用）。

### 2.2 选型：Electron `powerSaveBlocker`

Electron 主进程内置 `powerSaveBlocker`，其内部通过 Chromium 的
`device::mojom::WakeLock` Mojo 接口向 Device Service 申请唤醒锁，底层落到上述三平台原生 API。
**一次 API、三平台生效**，无需自行维护平台分支。

两个 type 的语义：

| type | 效果 | 适用 |
|---|---|---|
| `prevent-app-suspension` | 系统保持活跃，允许关屏 | 下载、后台任务 |
| `prevent-display-sleep` | 系统 **和 屏幕** 都保持活跃 | **阅读 / 视频播放** |

优先级：`prevent-display-sleep` > `prevent-app-suspension`（只有最高优先级生效）。

**本需求选 `prevent-display-sleep`**：若只阻止应用挂起而允许关屏，
空闲屏保/锁屏照样会触发，达不到「阻止锁屏」的目标。

### 2.3 为什么不用 `navigator.wakeLock`

渲染进程 Web Wake Lock API 在 Chromium 内部同样走 `device::mojom::WakeLock`，
但它有额外约束：文档级持有、页面 `visibilityState` 变化会被浏览器释放、
部分桌面环境不被支持。主进程 `powerSaveBlocker` 生命周期由我们完全掌控，更适合。

### 2.4 现状

- 项目**无**任何防睡眠相关代码（`rg powerSaveBlocker` 零命中）。
- `electron/main.ts` 已按 `electron/ipc/<domain>-handler.ts` 模式注册多个 handler，
  新模块沿用该模式。
- 设置模型 `core/models/settings.model.ts` + 校验/持久化 `core/logic/settings-store.ts`（白名单字段）。
- 设置页 `/settings/cache`（`cache-settings.component`）已承载「书架排序 / 抓取 UA / 封面缓存」
  三组应用级设置，新开关并入此处。
- 阅读页 `ReaderComponent` 已有 `ngOnInit` / `ngOnDestroy`，是天然的启停锚点。

## 3. 详细任务分解

### T-1 主进程防睡眠 IPC 模块 ✅

新增 `electron/ipc/power-blocker.ts`：

- 模块级持有单例 `blockerId: number | null`。
- `registerPowerBlockerHandler(ipcMain)` 注册：
  - `pom:power-blocker-get` → `{ active, supported, platform }`
  - `pom:power-blocker-set` `(active: boolean)` → `{ active, supported, platform }`
- **幂等**：`set(true)` 已有 blocker 时直接返回，不重复 `start`（避免泄漏 blocker id）；
  `set(false)` 无 blocker 时直接返回。
- `stopBlocker()` 导出，供 `app` 退出钩子调用。
- `supported` 探测：尝试 `start` 捕获异常 → 失败则标记平台不支持（如非 systemd Linux）。
- `platform` 由 `process.platform` 派生，仅用于 UI 提示文案。

在 `electron/main.ts` 中 `registerPowerBlockerHandler(ipcMain)`；
并在 `app.on('before-quit')` 调用 `stopBlocker()` 显式释放。

### T-2 preload 暴露 + 类型声明 ✅

- `electron/preload.ts`：`pomAPI` 新增 `powerBlockerGet` / `powerBlockerSet`。
- `src/app/core/book-source/page-fetcher.service.ts` 的 `declare global { interface Window }`
  中补充同名可选方法签名（该文件是全局 `pomAPI` 类型的唯一声明处，沿用现状）。

### T-3 设置模型新增字段 ✅

- `core/models/settings.model.ts`：`Settings` 新增 `keepAwakeWhenReading: boolean`，
  `DEFAULT_SETTINGS.keepAwakeWhenReading = true`（阅读器常态：阅读时不希望机器睡着）。
- `core/logic/settings-store.ts` `mergeValidated`：白名单校验 `typeof === 'boolean'`，
  缺失/类型错回退默认（与既有字段同一模式，保证老版本 localStorage 兼容）。

### T-4 渲染端 PowerBlockerService ✅

新增 `src/app/core/services/power-blocker.service.ts`（root 单例）：

- `active = signal(false)`、`supported = signal(true)`。
- `sync(desired: boolean): Promise<void>` —— 读 `settings.keepAwakeWhenReading`，
  无变更则跳过；调用 `pomAPI.powerBlockerSet` 并回写本地 signal；
  IPC 不可用（浏览器 `ng serve` 调试）时静默降级，不抛错。
- `acquire()` / `release()`：阅读页生命周期语义，`release()` 幂等。
- 内部引用计数防止重复 start / 提前 stop（`ngOnDestroy` 早于 `sync` 返回的竞态）。

### T-5 阅读页接入 ✅

`pages/reader/reader.component.ts`：
- `ngOnInit` 中确认 `book` 存在（未找到会 redirect，不占用 blocker）后调用 `power.acquire()`。
- `ngOnDestroy` 调用 `power.release()`。

### T-6 设置页 UI ✅

- `cache-settings.component.html`：新增「电源」面板，`nz-switch` 绑定 `keepAwakeWhenReading`，
  附平台说明文案（Windows/macOS/Linux 各自生效范围与限制）。
- `cache-settings.component.ts`：新增 `NzSwitchModule` import + getter/setter 直通 SettingsService，
  附 IPC 不可用/平台不支持的降级提示。
- `settings.routes.ts`：更新 `subtitle` 覆盖新的设置范围。

### T-7 测试 ✅

- `electron/ipc/power-blocker.spec.ts`：幂等 start/stop、unsupported 降级、状态查询。
- `src/app/core/services/power-blocker.service.spec.ts`：acquire/release 引用计数、
  设置关闭时不申请、IPC 缺失时降级不抛错。

## 4. 预期效果与验收标准

| # | 验收项 | 判定 |
|---|---|---|
| A-1 | 设置项出现在设置页，切换即时持久化（刷新后保持） | 手动 |
| A-2 | 开启后进入阅读页 → 主进程 `powerSaveBlocker.isStarted(id) === true` | `npm run dev` |
| A-3 | 离开阅读页回到书架 → blocker 停止（`isStarted` 为 false） | `npm run dev` |
| A-4 | 设置关闭时进入阅读页 → 不申请 blocker | 单测 |
| A-5 | 重复进入 / 退出阅读页不泄漏 blocker id | 单测 |
| A-6 | 非 systemd Linux 降级：设置项可见且不崩 | 单测（模拟 start 抛错） |
| A-7 | `npm test` / `npm run lint` / `npm run format:check` 全绿 | CI |

## 5. 风险评估与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 长期持锁耗电 | 笔记本用户离开阅读页未关闭设置 | 离开阅读页自动 `release()`；设置可手动关闭 |
| 非 systemd Linux 不支持 | 功能静默失效 | 主进程探测 `supported`，UI 明示 |
| 合盖 / 电源键强休眠 | 用户预期不符 | UI 文案明确「不阻止合盖与手动休眠」 |
| 渲染进程崩溃导致不释放 | 系统一直被阻止休眠 | 主进程 `before-quit` 释放；进程退出时 Mojo pipe 断开由 Chromium 自动释放 |
| 老版本 localStorage 无新字段 | 设置回退 | `mergeValidated` 默认值兜底 |

## 6. 实施顺序与依赖

```
T-1 (主进程) ──► T-2 (preload/类型) ──► T-4 (渲染端 service) ──┬──► T-5 (阅读页)
                                                              └──► T-6 (设置页)
T-3 (设置模型) ──────────────────────────────────────────────► T-6
T-7 (测试) 依赖 T-1 / T-4
```

T-1 / T-3 可并行；其余串行。

## 7. 备注

- 需同步 `README.md §项目结构`？本次**未新增 `src/app/<concern>/` 目录**
  （新文件落在既有 `core/services/` 与既有 `pages/` 下），无需同步。
- `AGENTS.md` 命名硬规则核对：新 service 为 `power-blocker.service.ts`（kebab-case），
  位置 `src/app/core/services/`；无新增组件，故组件目录规则不涉及。

## 8. 实施结果（2026-10-18）

### 落地文件

| 文件 | 变更 |
|---|---|
| `electron/ipc/power-blocker.ts` | 新增：`getState` / `setActive` / `stopBlockerOnQuit` / `watchWebContents` / `registerPowerBlockerHandler` |
| `electron/ipc/power-blocker.spec.ts` | 新增：19 用例 |
| `electron/main.ts` | `registerPowerBlockerHandler(ipcMain)`；`createWindow` 内 `watchWebContents`；`app.on('before-quit')` 释放唤醒锁 |
| `electron/preload.ts` | 暴露 `powerBlockerGet` / `powerBlockerSet` |
| `src/app/core/book-source/page-fetcher.service.ts` | `declare global` 补两个方法签名 |
| `src/app/core/models/settings.model.ts` | `Settings.keepAwakeWhenReading` + 默认 `true` |
| `src/app/core/logic/settings-store.ts` | `mergeValidated` 严格 boolean 校验 + 旧数据回退默认 |
| `src/app/core/services/power-blocker.service.ts` | 新增：引用状态 + 串行化 sync + 启动对账（generation 守卫）+ 降级 |
| `src/app/core/services/power-blocker.service.spec.ts` | 新增：14 用例 |
| `src/app/pages/reader/reader.component.ts` | `ngOnInit`（book 校验后）`acquire()`；`ngOnDestroy` `release()` |
| `src/app/pages/settings/cache-settings.component.{ts,html,scss}` | 「电源」面板 + `nz-switch` + 平台提示 |
| `src/app/pages/settings/settings.routes.ts` | 副标题覆盖新设置范围 |

### 验收结果

| # | 验收项 | 结果 |
|---|---|---|
| A-4 | 设置关闭时进入阅读页不申请 blocker | ✅ 单测 |
| A-5 | 重复进入/退出不泄漏 blocker id | ✅ 单测（主进程幂等 + 渲染端期望态短路） |
| A-6 | 非 systemd Linux 降级不崩 | ✅ 单测（`start` 抛错 → `supported=false`） |
| A-7 | `npm test` / `lint` / `format:check` | ✅ 1004 用例全绿（65 文件）/ eslint 无告警 / prettier 全通过 |
| — | `npm run build:electron`（tsc 主进程） | ✅ 通过 |
| — | `npm run build`（Angular AOT + strictTemplates） | ✅ 通过（仅既有 Sass `@import` 弃用与 bundle 预算告警） |
| A-1 / A-2 / A-3 | 真机三平台行为 | ✅ 全部通过：Linux（Manjaro）2026-10-18；Windows / macOS 2026-10-19 真机验收通过 |

### 经验

1. **`prevent-display-sleep` 而非 `prevent-app-suspension` 是本需求的关键**：
   后者允许关屏，空闲屏保/锁屏照常触发，无法达成「阅读时不锁屏」。
2. **幂等必须做在主进程**：`powerSaveBlocker.start` 每次分配新 id 且不复用，
   渲染端任何重复触发（signal 抖动、路由重入）都会泄漏一个唤醒锁。
   主进程 `setActive` 的「已持有则直接返回」是最后一道闸。
3. **`getState()` 顺带清理失效 id**：OS / 驱动可能单方面释放唤醒锁，
   若不复位 `blockerId`，后续 `set(true)` 会误判为「已持有」而永不重申请。
4. **默认开启**：`keepAwakeWhenReading` 默认 `true`，符合阅读器常态；
   用户可在设置页关闭，离开阅读页也会自动释放。
5. **未加 e2e**：Playwright 跑在无 Electron 主进程的浏览器里，
   本特性依赖主进程 `powerSaveBlocker`，浏览器环境恒为降级路径，e2e 无法验证真实行为；
   改由主进程/渲染端单测 + 三平台真机手测覆盖。

## 9. External Review Opinion（外部审核循环，2026-10-18）

Provider：coding-bridge。`review_code` 端点两次 300s 超时（token 统计为 0，下游未受理），
按协议改用同 provider 的 `chat` 端点完成审核（SESSION_ID `cb84cc44-e06a-44a6-becc-019462100c78`）。

### Round 1/10 — NEEDS_CHANGES

- **阻塞风险 1（生命周期漏洞）**：渲染端不经 `ngOnDestroy` 消失时
  （macOS 关窗不退应用 / `render-process-gone` / dev reload），主进程唤醒锁永久持有；
  且新渲染端 `desired=false === target=false` 短路，永远不会下发纠正 `set(false)`。
- **阻塞风险 2**：缺上述场景的回归测试。
- **修复**：
  - 主进程新增 `watchWebContents`（`once('destroyed')` + `on('render-process-gone')` 兜底释放），
    在 `createWindow()` 内接线，同时覆盖 macOS `activate` 重建窗口的路径；
  - 渲染端新增启动对账 `reconcile()`：以主进程实际状态对齐 `desired`，不一致时下发一次纠正调用；
  - 对账快照作废守卫 `generation`（修复过程中被既有精确 IPC 序列用例当场捕获：
    快照覆盖竞态导致重复 `set(true)`）；
  - `stopBlocker` 先清引用再 `stop()`（评审 nit，防假想抛错遗留失控 id）。
- **回归**：主进程 +4 用例、渲染端 +3 用例（重建纠正 / 干净启动零 IPC / destroyed 只释一次等）。

### Round 2/10 — APPROVED

- 生命周期矩阵闭合：正常离开 → `ngOnDestroy`；关窗 → `destroyed`；崩溃 → `render-process-gone`；
  reload → 启动对账；退出 → `before-quit`。
- `generation` 守卫对所有 acquire/release/toggle 交错收敛到正确终态（最坏仅多一次幂等 IPC）。
- 事件对无双释风险（`stopBlocker` 空值守卫）。
- 非阻塞观察（记录不跟进）：
  - `powerBlockerGet` 启动即故障时无纠正下发 —— 被关窗/崩溃/退出三层兜底覆盖，残余可忽略；
  - reload 恢复阅读瞬间可能出现一次短暂的释放/重申请抖动（毫秒级，终态正确）；
  - 单窗口假设：若未来引入加载不可信内容的次级窗口，需重审 watcher 归属与 `event.sender` 校验。

### 审核后验证（当前分支 `feat/booksource-json-rules`）

- `npm test`：1177 用例全绿（75 文件，含本特性 33 用例：主进程 19 + 渲染端 14）。
- `npm run format:check` / `npm run build:electron`（tsc）：通过。
- `npm run lint`：44 个问题（43 error + 1 warning）—— stash 本特性全部改动后数量逐项一致，
  均为本分支书源 JSON 规则的存量类型声明债务，与本特性无关。
