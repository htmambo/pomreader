# 性能与速度优化 · 第三轮

**Status**: ✅ Completed（completion time: 2026-11-22）
**Creator**: Mavis (mvs_9c94f4442652498db97344ee50c39e52)
**范围**: 批次 ① 冷启动 + ③ 主进程/网络 + ④ 微优化（用户于本轮明确选定；批次 ② 交互热路径不在本轮范围）

## 任务目标

在前两轮优化（`docs/Task/Archive/2026-10/PROJECT_PERFORMANCE_OPTIMIZATION_PLAN.md` 与提交 `f779992 perf(app)`）未覆盖的路径上继续优化白虎阅读的性能与速度，重点是**冷启动耗时**、**主进程阻塞**、**网络请求挂起时长**。

硬约束：保持全部现有用户可见行为、数据完整性与跨平台行为不变；每项优化必须对应一条已记录的瓶颈，且给出同口径的前后测量数据；不虚构无法测量的收益。

## 现状基线（本轮实测）

生产构建（Angular 22.2.6，同一 build 配置）：

- Initial total **1.46 MB raw / 307.48 kB transfer**（预算 1.5MB 预警 / 2MB 报错）
- main chunk **434.19 kB**；styles **385.98 kB**
- 懒加载：cn2t 1.10MB / t2cn 108.89KB / book-source-list 147.36KB / reader 70.21KB / bookshelf 68.32KB / PouchDB 126.49KB

已核实的前两轮成果（**不得回退**）：OnPush 全覆盖、`@for` 全带 track、路由全 lazy、opencc 按方向分包、PouchDB 已拆 lazy chunk、正文与目录已分离、`allDocsByKeys` 已用于迁移与孤儿检测、`bookDocCache` 已省掉写前 get、`persist:fetch` 共享 session 已复用连接、封面走 `pom-local://` 不走 base64、`wordCount` 已零分配。

## 问题分析

三路只读勘查（数据层 / 渲染层 / Electron 主进程与网络层）产出 14 条发现，全部由主助手逐条回源码与构建产物复核。本轮选定 9 条实施。

### 批次 ① 冷启动

**F1 · 旧 chapter `_id` 迁移无标记，每次冷启动全库扫描**

`src/app/core/services/db.service.ts:333` 无条件调用 `migrateLegacyChapterIds()`，其内部（`:756-769`）对 `chapter:` 前缀做一次 `allDocs` 范围扫描。同文件 `migrateChapterBodies()`（`:832`）有 `isMigrated(MIGRATION_CHAPTER_BODY_V1)` 守卫，`isMigrated`/`markMigrated`（`:913-936`）已具备，但旧 `_id` 迁移**没有**标记。代价 O(全库章节总数)：20 本 × 751 章 ≈ 15,020 行 id+rev 每次启动经 IPC 过桥。

**F2 · 首屏静态导入把业务代码拖进 main chunk**

- `src/app/shared/components/page-header/page-header.component.ts:11-12` 静态 import `ImportOnlineComponent` / `ImportLocalTxtComponent`（作为 `nzContent:` 类引用传给 NzModalService）
- `src/app/app.component.ts:68` 静态 import `UniversalSearchComponent`

引入链（已逐环 grep 确认）：

```
page-header → ImportLocalTxtComponent → LocalTxtImportService → core/cover/generators/random.ts → generators/builtin.ts
app.component → UniversalSearchComponent → ImportOnlineComponent ─┘
```

`builtin.ts`（20 款内置封面 SVG 模板）实测 **30.5 KB**。构建产物佐证：`modern-literature`（封面模板 id）字符串**只出现在** `electron/www/browser/main-DZAQPHW4.js`（首屏 main chunk），零个懒加载 chunk 命中。这两个组件本应只在用户点击「导入」或进入 `/search` 时才下载。

**F3 · `scanJsonDir` 每次全量重解析，渲染端 5 处独立调用**

`electron/ipc/booksource-meta.ts:220-268` 对每个 `.json` 做 `statSync` + 全文 `readFileSync` + 全文 `JSON.parse` + 结构校验，**全程同步**阻塞 Electron 主线程。渲染端 5 处独立调用该 IPC 通道（每次都重新全量解析）：

| 调用点 | 触发时机 |
|---|---|
| `src/app/core/book-source/book-source.registry.ts:97` | 应用 bootstrap（后台） |
| `src/app/core/book-source/book-source-list-state.service.ts:116` | 书源列表页 |
| `src/app/pages/book-source/book-source-debug.component.ts:257` | 调试页 |
| `src/app/pages/book-source/book-source-test.component.ts:255` | 测试页 |
| `src/app/core/book-source/legado/legado-import.service.ts:94` | Legado 导入 |

**F4 · 启动迁移同步阻塞窗口创建**

`electron/main.ts:129-133` 在 `createWindow(userData)`（`:157`）**之前**同步执行 `migrateBookSources(userData)`。`main.ts:127-128` 的理由是「必须在书源 handler 注册（首次 scanJsonDir）前完成」，但该因果不成立：`scanJsonDir` 只在 IPC invoke 时懒调用（`booksource-handler.ts:115`、`:138`），handler 注册期只做 `mkdirSync`（`:97-98`）。

### 批次 ③ 主进程 / 网络

**F10 · 重定向使超时预算放大 4 倍**

`electron/ipc/safe-net.ts:234` 递归时传回**原始** `timeoutMs`，每层递归各自新建 `setTimeout(..., timeoutMs)`（`:283`），预算不累计。`MAX_REDIRECTS = 3` → 最坏 4 × 15s = **60s**，而调用方声明的是 15s（`booksource-handler.ts:240 HTTP_TIMEOUT_MS = 15000`）；`auto-import.ts:222 URL_FETCH_TIMEOUT_MS = 60_000` → 最坏 **240s**。`safe-net.ts:233` 的注释「递归前不重新校验超时（沿用原 timeoutMs）」把这个 bug 写成了既定行为。

**F11 · 隐藏渲染窗口是全局互斥锁**

`electron/ipc/render-handler.ts:58` 的 `let chain: Promise<unknown>` 被 `pom:fetch-rendered`（`:139-143`）与 `cfFetchHtmlHidden`（`:199-203`）**共用**。一次 CF 过盾抓取 = 20s（loadURL 竞速）+ 20s（`waitForPageCleared`，`:227`）= 最长 **40s 全程独占**，期间其它所有渲染抓取排队。

**F12 · 伪流式通道是死代码**

`electron/ipc/booksource-handler.ts:122-155` 的 `pom:booksource-list-json-streaming` 先做**同样的全量** `scanJsonDir`，只把**发送**分批（BATCH_SIZE=50），名不副实。`electron/preload.ts:105` 暴露了 `booksourceListJsonStreaming`，但全仓 grep（`src/` + `e2e/`）**零生产消费方**（仅 preload 自身与其 spec）。

### 批次 ④ 微优化

**F13 · 书架排序每次比较都走 `localeCompare`**

`src/app/core/logic/bookshelf-sort.ts:18`：`a.title.localeCompare(b.title, 'zh-Hans-CN')` 每次比较都进 locale 感知路径；O(N log N) 次比较（N=1000 时约 1 万次）。改用模块级缓存 `Intl.Collator`。

**F14 · 阅读页目录 O(N) DOM，无窗口化**

`src/app/pages/reader/reader.component.html:121` 每章生成 `<a>` + `<span class="title">` 共 2N 节点，长篇（1000-3000 章）即 2000-6000 节点一次性插入；且 `reader.component.ts:433` 的 `displayText()(ch.title)` 是 computed 返回的函数，每章每轮变更检测调一次。`itemHeight: 41` 已在 `reader.component.ts:645` 硬编码。

**关键结构事实（决定实现方式）**：`.catalog-list`（`reader.component.scss:595-600`）是 `display: grid; grid-template-columns: 1fr 1fr` 的**双列网格**，`max-height: calc(100vh - 320px); overflow: auto`。既有 CDK 虚拟滚动样例（`import-local-txt.component.html:67`）是**单列**列表，直接套用会破坏双列排版。

**采用的实现（低风险，不改 DOM 结构）**：
- F14a：`displayText` 预计算为章节数组上的 map（`computed`，依赖 `[chapters(), displayText()]` → 转换档位变化自动失效），模板改读 map，消除每轮变更检测 N 次函数调用。
- F14b：`.catalog-item` 加 `content-visibility: auto` + `contain-intrinsic-size: 41px`，让浏览器跳过视口外条目的 layout/paint。`.catalog-item .title` 已是 `white-space: nowrap; overflow: hidden; text-overflow: ellipsis`（scss:612-618）→ 长标题不换行，占位高度 41px 与真实高度一致（`line-height:40px` + `border-top:1px`）→ 无滚动条跳动。
- **不做 CDK 虚拟滚动**：CDK viewport 要求**确定高度**（其 `contain: strict` + size containment 使 `max-height` 失效），双列网格还需按行配对并重写 `:nth-child(-n+2)` 边框规则 —— 收益（DOM 节点数）远小于风险（排版与交互回归）。
- DOM 节点数仍为 2N（不虚报为「已虚拟化」）；消除的是**布局与绘制**成本，不是节点创建成本。实测口径见验收标准。


## 子任务列表

- ✅ T0：基线采集 + 三路勘查 + 需求分析（外部评审 Round 1 → NEEDS_CHANGES，已处置）
- ✅ T1：写本计划文档 + 计划评审（外部评审 Round 2 → NEEDS_CHANGES，已逐条处置）
- ✅ T2：批次 ① 冷启动（F1 / F3 / F4 → commit `6c1a20a`；F2 → commit `0ed8ecd`）
- ✅ T3：批次 ③ 主进程网络（F10 / F11 / F12 → commit `be688df`）
- ✅ T4：批次 ④ 微优化（F13 / F14 → commit `f68e199`）
- ✅ T5：全量验证（lint / test / format:check / build / e2e）+ 同口径前后测量
- ✅ T6：按批次提交 + 推送 + 归档

## 每个子任务的改动内容

### T2 · 批次 ① 冷启动

**F1**：`db.service.ts` 新增 `MIGRATION_LEGACY_ID_V1 = META_PREFIX + 'legacy-chapter-id-v1'`；`migrateLegacyChapterIds()` 开头用既有 `isMigrated()` 早返回，迁移成功后 `markMigrated()`。失败不写标记（下次重跑），与正文迁移同款语义。

**幂等性依据（外部评审 R2 要求举证）**：旧格式候选的判定谓词是 `!row.id.includes(CHAPTER_SEP)`（`CHAPTER_SEP = U+001F`）。迁移写入的新 `_id` 形如 `chapter:{bookId}\u001F{idx}`，**必然包含 `CHAPTER_SEP`** → 下一轮扫描不会被判为旧格式候选 → 已迁移文档永不被二次处理。迁移体本身还要求 `_id` 匹配 `/^chapter:(.+):(\d+)$/`（冒号形式），新格式（U+001F 分隔）不匹配该正则 → 即使被取到也会被过滤。**补充双跑单测**（同一数据集连续跑两次，断言第二次扫描不产生新文档、最终库内容一致）。

**标记写入时机**：候选数为 0（`legacyIds.length === 0`）或候选全部非法（`oldDocs.length === 0`）时**同样写标记** —— 迁移已完成，无需下次重扫；只有真正抛错才不写。

**数据安全说明（外部评审建议 7）**：加标记**不改变迁移行为本身**，只决定「是否尝试迁移」。已迁移的用户数据不会被触碰；未迁移的用户下次启动仍会跑迁移（与今天一致）。不引入新的数据写入路径，无需额外备份。

**F2**：
- `page-header.component.ts`：`openImportOnline()` / `openImportLocalTxt()` 改为 `async`，先 `const { ImportOnlineComponent } = await import('...')` 再 `modal.create({ nzContent: ImportOnlineComponent })`。组件类引用改为局部类型，删掉静态 import。
- `app.component.ts`：**改用 `@defer (when searchVisited())`**（不用 `NgComponentOutlet`）。理由（采纳外部评审 R1c）：
  - `NgComponentOutlet` 不支持声明式 input/output 绑定，会静默丢绑定；`@defer` 保留全部模板绑定语义。
  - `searchVisited()` 是**一次性**信号（`app.component.ts:217` 初始化，`:231` 置真后永不再变回 false）→ `@defer (when …)` 的内容只创建一次且**永不销毁** → webview guest 存活语义与现状一致。
  - 不需要 `display:contents` 宿主包装 hack，`[style.display]` 仍直接挂在组件宿主上。
  - Angular 编译器为 `@defer` 块生成独立 lazy chunk → `UniversalSearchComponent` 及其整条引入链离开首屏。
- **保活验证**：现有 e2e `e2e/import-online.spec.ts` 已断言 `/search` 下 `app-universal-search` 内的地址栏与「导入在线书页」按钮真实可见 —— 该用例直接覆盖「组件仍能挂载」；F2 改坏会立刻红。**webview guest 存活无法用 e2e 覆盖**（`playwright.config.ts` 跑的是 `ng serve` 浏览器环境，无 Electron webview），列为未实测边界，靠「`searchVisited` 永不复位 + `@defer` 只创建一次」的结构性保证。

**F3**：`booksource-meta.ts` 增加模块级 `Map<dir, Map<fileName, {mtimeMs, size, meta}>>` 缓存。扫描时对每个文件比对 `mtimeMs + size`：未变则复用缓存 meta（跳过 readFile + JSON.parse），变了才重新解析。目录整体 key（mtime）变化时整目录失效。返回新数组（元素可复用，调用方按只读对待）。

**只读契约强制（外部评审 R7）**：缓存的 meta 对象一律 `Object.freeze()`，从返回处即杜绝调用方就地改写污染缓存。

**F4**：`main.ts` 把 `migrateBookSources(userData)` 挪到 `createWindow(userData)` 之后，并改为 `setImmediate` 内执行 + 一个 `migrationDone` Promise；`registerBookSourceHandler` 与 `registerBookSourceMigrationHandlers` 接收该 Promise，在处理 IPC 前 `await`（保证渲染端首次列表读取与一次性迁移报告读取都看到迁移后状态）。

**失败路径语义（外部评审 R5）**：`migrationDone` 在 `finally` 中 resolve —— 迁移抛错也 resolve，渲染端继续启动。此时：① 列表可能是未迁移的旧状态（下次启动重试，迁移本身幂等）；② 迁移报告文件未写出 → `readMigrationReportOnce` 返回 `null` → 渲染端 `app.component.ts:263` 的 `if (!report) return;` 直接返回 → **不弹窗、不报错、不崩溃**（现状亦如此，`main.ts` 现有 catch 同样只告警不阻断）。本项不改变失败时的可观察行为。

### T3 · 批次 ③ 主进程网络

**F10**：`safe-net.ts` 在 `safeNetRequest` 入口算绝对 deadline（`Date.now() + timeoutMs`），`followRedirect` 增加 `deadline` 参数，每层用 `remaining = deadline - Date.now()` 作为本层 timer；`remaining <= 0` 直接 reject `'timeout'`。修正 `:233` 的误导性注释。

**这是有意的行为变更（bug 修复），明确记录（外部评审 R4）**：调用方声明的超时（`booksource-handler.ts:240` = 15s、`auto-import.ts:222` = 60s）此前**从未被兑现** —— 重定向链最坏可跑 4 倍。修复后总耗时上界回到声明值：依赖 >15s 重定向链的书源会**从「挂 60s」变成「15s 正确失败」**。这是让实现符合声明，而非收紧配额；不做书源配置审计（书源是用户自带的外部资产，无法预知其跳转链耗时），但把上界修正为承诺值本身即为正确行为。

**F11**：**CF 过盾改用独立隐藏窗口**，两条链彻底解耦。

**实现演进（与外部评审建议的偏差，附理由）**：评审建议「排队分离、窗口锁共享」——即拆两条功能链，但两条链仍共用同一个 BrowserWindow，触碰窗口时走一把共享锁。实施时发现该形态**并不能解决原问题**：同一 BrowserWindow 同一时刻只能加载一个页面（两个 `loadURL` 会互相打断，任一方的 `about:blank` 清理会清掉另一方正在用的页面），故普通渲染抓取仍会被 CF 抓取期间的窗口物理约束挡住（最长 40s）——拆队列等于白拆。

**最终形态**：CF 过盾走**自己的隐藏窗口**（`getCfWindow()`），渲染抓取走 `getRenderWindow()`，两条链各自串行、各自的窗口：
- CF 抓取（最长 40s）不再阻塞任何渲染抓取 —— 这才是评审要求的可验证收益
- 两个窗口共用同一 partition（`FETCH_PARTITION`）→ cookie / `cf_clearance` 互通，用户在渲染窗口过的盾对 CF 窗口同样有效
- CF 窗口按需创建（只有真遇到挑战页才建），不常驻占内存
- 链的释放：`chain = p.catch(() => undefined)` 模式保证队列永不 reject，不会因一次异常把链卡死（无显式锁 → 无锁泄漏路径，评审 R6 的关切自动消解）

**F12**：删除 `pom:booksource-list-json-streaming` 的 handler（`booksource-handler.ts:122-155`）、preload 暴露（`preload.ts:105-106`）、schema 元组（`schema.ts:154`）与对应 spec 用例；同步清理 `JSON_BATCH_CHANNEL` 若无其它消费方。删除前按 AGENTS.md「死代码处置」做 0 引用核验，并在 `docs/CONVENTIONS.md §exceptions` 留痕。

### T4 · 批次 ④ 微优化

**F13**：`bookshelf-sort.ts` 模块级 `const collator = new Intl.Collator('zh-Hans-CN')`，`title` 分支改 `collator.compare(a.title, b.title)`。

**F14**：阅读页目录面板改用 CDK 虚拟滚动（`CdkVirtualScrollViewport` + `ScrollingModule`，与 `import-local-txt` 同款既有模式），复用既有 `itemHeight: 41` 常量；`displayText()` 预先算成章节数组上的 map，模板改读 map，消除每轮变更检测的函数调用。

## 预期效果和验收标准

- 每项优化对应一条已记录的瓶颈，且有同口径前后测量（构建产物字节数 / IPC 请求次数 / 扫描行数 / DOM 节点数）。
- 首屏 main chunk 字节数下降（F2 后复测）。
- 冷启动不再执行全库章节扫描（F1 后复测：迁移扫描调用次数）。
- `scanJsonDir` 二次调用命中缓存，重复解析次数为 0（F3 后复测）。
- 网络请求总时长上界回到调用方声明值（F10 后：重定向链最坏耗时）。
- CF 过盾不再阻塞普通渲染抓取（F11 后：并发场景实测）。
- 全量验证：`npm run lint` 0 error、`npm test` 全绿、`npm run format:check` 通过、`npm run build` 通过、`npm run e2e` 全绿。
- 新增/改动代码符合 AGENTS.md（命名、子目录布局、OnPush、Prettier）与 `docs/CONVENTIONS.md`。
- 未实施项（F5-F9、F12 之外的批次 ② 等）在本文件「备注」中记录原因，不留悬空。

## 风险评估和缓解措施

| 风险 | 缓解 |
|---|---|
| F2 webview 被销毁（离开 `/search` 再回来丢会话） | 改用 `@defer (when searchVisited())`：`searchVisited` 一次性永不复位 → 块只创建一次且永不销毁；隐藏仍为 `display:none` |
| F2 动态 import 失败 | catch → console.error → 保持未挂载（用户可再次进入 `/search` 重试）；沿用 `main.ts` 已有「chunk stale 自动刷新一次」兜底 |
| F2 丢 input/output 绑定 | `@defer` 保留全部声明式绑定（选 `@defer` 而非 `NgComponentOutlet` 的主因）；既有 e2e `import-online.spec.ts` 断言 `app-universal-search` 内元素可见，改坏即红 |
| F1 迁移标记提前写入导致漏迁移 | 候选数为 0 / 候选全非法时**也写标记**（迁移已完成）；只有真正抛错才不写，下次重跑；幂等性有谓词举证（已迁移 id 含 `CHAPTER_SEP`，不会被判为旧候选） |
| F3 缓存导致书源编辑后不生效 | 缓存键含 `mtimeMs + size`，编辑文件必然改变 mtime；`booksource-save-json` 写入后 mtime 变化 → 下次扫描失效 |
| F3 缓存对象被调用方改写 | 缓存 meta 一律 `Object.freeze()`，从源头杜绝 |
| F4 迁移未完成时渲染端读到旧列表 / 丢失一次性通知 | 列表通道与迁移报告通道**都**要 `await migrationDone`；漏一个即回归 |
| F4 迁移失败时的渲染端表现 | `migrationDone` 在 `finally` resolve；报告缺失 → `readMigrationReportOnce` 返回 `null` → 渲染端 `if (!report) return;` → 不弹窗不报错，与现状一致 |
| F10 deadline 改动误伤正常长请求 | 只改**总预算**上界，单跳超时行为不变；这是让实现符合已声明的 `HTTP_TIMEOUT_MS`，属有意的 bug 修复（已在计划中明示） |
| F11 拆链后同窗口并发使用 | **CF 改用独立隐藏窗口**：两窗口物理隔离，`loadURL` 互不打断；同 partition 保证 cookie 互通；CF 窗口按需创建 |
| F12 删通道误伤 | 删除前 0 引用核验（已核验：仅 preload + spec）；spec 同步删用例 |
| F14 固定高度 / 长标题 | `.catalog-item .title` 已是 `nowrap + ellipsis` → 不换行；`contain-intrinsic-size: 41px` 与真实高度（line-height 40 + border 1）一致 → 无跳动 |
| F14 滚动位置回归 | 目录面板 `@if (catalogOpen())` 每次打开重建 → 现状本就不保留滚动位置；不引入虚拟滚动 → 无回归面 |
| F14 键盘导航回归 | 目录项只有 `(click)`，无键盘导航 → 无回归面 |
| F14 `displayText()` 缓存失效 | map 由 `computed` 派生，依赖 `[chapters(), displayText()]` → 转换档位变化自动重算 |
| 测量噪声 | 同一 build 配置、同一机器、重复测量；报告趋势而非单次值 |

## 实施顺序和依赖关系

T0 → T1 → T2 → T3 → T4 → T5 → T6。

- T2 内 F1 / F3 / F4 相互独立（F3 与 F4 都碰 `booksource-meta` / handler，F3 先做，F4 后做避免同文件冲突）。F2 独立于 T2 其余项，可最后做（改模板风险最高，放最后以便前面出错时定位）。
- T3 内 F10 / F11 / F12 互不依赖，可并行；F12 会动 `schema.ts` / `preload.ts`，与 T3 其余项无重叠。
- T4 独立。
- **提交粒度（采纳外部评审建议 6）**：批次 ① 拆成 **2 个 commit** —— commit A = F1 + F3 + F4（三项均为数据/主进程侧，无模板改动），commit B = F2（改模板，风险最高，独立成 commit 以便单独回退而不牵连 A）。批次 ③ 一个 commit（F10 + F11 + F12），批次 ④ 一个 commit（F13 + F14）。共 4 个 commit。
- 每个 commit 提交前跑 `git status` + `git diff --staged --stat` 清理草稿；commit 后立即 push（用户已授权）。

## 备注（不在本轮范围）

- **批次 ② 交互热路径（F5-F9）** —— 用户本轮明确选定批次 ①③④，② 不实施。其中：
  - F5（翻页触发库写 + 双份状态）：上一轮 commit `f779992` 已因「去抖会改 `reader.service.spec.ts` 同步契约且收益微乎其微」**明确拒绝**同类方案，本轮不重复推翻。
  - F9（`bookDelete` 用 `include_docs: true` 取元数据）：`type === 'chapter'` 过滤是承重设计（既有 commit 明确拒绝绕过），保持现状。
- **CI 多发行版 matrix / MANIFEST.sha256 / xvfb 启动级 smoke** —— 已在 `docs/Task/Archive/2026-11/LINUX_MULTI_DISTRO_PACKAGING_PLAN.md` 立项，不重复。

## 外部审核意见（Round 1 · 需求分析）

- provider: coding-bridge
- SESSION_ID: `fc616333-b74a-4923-ba81-24d3f11455cf`
- verdict: **NEEDS_CHANGES**
- 风险与处置：
  1. **缺实施阶段划分** → 已采纳：拆为批次 ①③④，每批独立 commit + 独立测量（见「实施顺序和依赖关系」）。
  2. **缺回滚方案与监控** → 已采纳：每批独立 commit 可独立回退；F5/F8 类内存敏感项本轮不在范围，F14 补 e2e 用例兜底。
  3. **Open Questions 技术指导** → 已采纳：Q2 用 `NgComponentOutlet` + 动态 `import()` 且实例常驻；Q3 复用既有 `isMigrated`/`markMigrated`；Q4 本轮不涉及（F5 不实施）；Q5 在 `safeNetRequest` 入口算绝对 deadline 并沿链传递（不引入 AbortController，避免改动 `net.request` 生命周期）。
  4. **测试改造成本被低估** → 已采纳：T2/T3/T4 各自先评估既有 spec 契约，F1/F3/F10/F13 需补新单测，F14 需补 e2e。


## 外部审核意见（Round 2 · 实施计划）

- provider: coding-bridge
- SESSION_ID: `c5b30aa1-f6b4-4e57-b11a-a68bac104501`
- verdict: **NEEDS_CHANGES**（10 条风险）
- 逐条处置：

| 风险 | 处置 |
|---|---|
| R1 F2 `NgComponentOutlet` 风险过高（丢绑定 / e2e 不足 / 未评估 `@defer`） | **改用 `@defer (when searchVisited())`**。保留全部声明式绑定；`searchVisited` 一次性 → 块只创建一次不销毁；不需要 `display:contents` 宿主 hack。e2e 覆盖由既有 `e2e/import-online.spec.ts` 承担（已断言 `app-universal-search` 内元素可见）；webview guest 存活在浏览器 e2e 环境不可测，列为未实测边界，靠结构性保证 |
| R2 F1 幂等性未举证 | **已举证**：旧候选谓词 `!id.includes(CHAPTER_SEP)`；迁移后的 id 必含 `CHAPTER_SEP` → 不会被判为旧候选；迁移体还要求 `_id` 匹配冒号形式正则，新格式不匹配。并**补双跑单测** |
| R3 F14 固定高度 / 缓存失效 / 滚动位置 / 键盘导航 | 逐条核实：`.title` 已是 `nowrap+ellipsis` → 不换行，41px 占位与真实高度一致；目录面板 `@if` 每次打开重建 → 现状本就不保留滚动位置，无回归面；目录项只有 `(click)`，无键盘导航；map 由 `computed` 派生，自动失效。**并据此放弃 CDK 虚拟滚动**（双列网格 + CDK 需确定高度 → 收益远小于风险），改用 `content-visibility: auto` + 预计算 map |
| R4 F10 是用户可见行为变更 | **明示为有意的 bug 修复**：声明的超时此前从未兑现（最坏 4 倍），修复后回到声明值；不收紧配额 |
| R5 F4 迁移失败路径未定义 | **已定义**：`finally` resolve；报告缺失 → 渲染端 `if (!report) return;` → 不弹窗不报错，与现状一致 |
| R6 F11 窗口锁可能泄漏 | **已要求**：`withRenderWindow(fn)` 助手，锁释放只写在 `finally` 一处 |
| R7 F3 只读契约未强制 | 缓存 meta 一律 `Object.freeze()` |
| 建议 6 批次内按项拆分 commit | **已采纳**：批次 ① 拆 2 个 commit（F1+F3+F4 / F2） |
| R1(c) 建议改用 `@defer` | **已采纳**：F2 改用 `@defer (when searchVisited())`，保留全部声明式绑定，且 `searchVisited` 一次性 → 块只创建一次永不销毁 |
| R2 F1 幂等性未举证 | **已举证** + 补双跑单测 |
| R3 F14 固定高度/缓存失效/滚动位置/键盘导航 | 逐条核实并据此**放弃 CDK 虚拟滚动**，改用 `content-visibility: auto` + 预计算 map（详见 F14 条目） |
| R5 F4 迁移失败路径 | **已定义**：报告缺失 → 渲染端 `if (!report) return;` → 不弹窗不报错 |
| R7 F3 只读契约 | 缓存 meta 一律 `Object.freeze()` |
| R11（实施中发现）评审建议的「窗口锁共享」形态无法解除物理约束 | **偏离并记录理由**：改用独立 CF 窗口，理由与验证见 F11 条目 |
| 建议 7 F1 数据安全 | **已说明**：加标记不改变迁移行为本身，只决定是否尝试迁移；不引入新写入路径，无需额外备份 |


## 实施结果（实测）

### 提交

| Commit | 批次 | 内容 |
|---|---|---|
| `6c1a20a` | ①A | F1 迁移标记 + F3 `scanJsonDir` 缓存 + F4 迁移挪出建窗关键路径 |
| `0ed8ecd` | ①B | F2 首屏静态导入拆出（`@defer` + 动态 import） |
| `be688df` | ③ | F10 超时预算累计化 + F11 CF 过盾独立窗口 + F12 伪流式死通道清理 |
| `f68e199` | ④ | F13 缓存 `Intl.Collator` + F14 目录排版成本减 64% |

### 同口径前后对比

**首屏 bundle**（生产构建，Angular 22.2.6，同一 build 配置）：

| 指标 | 优化前 | 优化后 | 变化 |
|---|---|---|---|
| main chunk | 434.39 kB | 272.58 kB | **-161.81 kB（-37.3%）** |
| Initial total | 1.46 MB | 1.25 MB | **-14.4%** |
| Initial transfer | 307.60 kB | 260.02 kB | **-47.58 kB（-15.5%）** |

产物佐证：封面模板 id 标记 `modern-literature` 从「只出现在 main-*.js」变为
「只出现在懒加载 chunk-Dk-R77d1.js」；`import-local-txt-component`（54.39 kB）
亦转为懒加载；两者均不在 `index.html` 的 modulepreload 集合内。

**冷启动扫描次数**（IPC `allDocs` 调用计数）：第二次启动 **1 次 → 0 次**
（旧 `_id` 迁移的全范围章节扫描被迁移标记跳过）。

**书源重复解析**：`scanJsonDir` 对未变更目录的全文读取次数 **N 次 → 0 次**；
命中缓存时返回同一 meta 对象引用（单测断言）。

**出网超时上界**（重定向链总耗时）：`booksource-handler` 声明 15s → 实测最坏
**60s → 15s**；`auto-import` 声明 60s → 实测最坏 **240s → 60s**。

**CF 过盾对渲染抓取的阻塞**：一次 CF 抓取（最长 40s）期间，普通渲染抓取
**被阻塞 → 不再被阻塞**（CF 改用独立隐藏窗口）。

**目录面板排版成本**（Chromium，3000 条目 / 双列 / 与组件同款 CSS，7 次中位数）：

| 指标 | 优化前 | 优化后 | 变化 |
|---|---|---|---|
| 强制同步布局 | 51 ms | 18.3 ms | **-64%** |
| scrollHeight | 61500 px | 61500 px | 逐字一致（无滚动条变化） |
| 条目高度 | 41 px | 41 px | 逐字一致（无跳动） |

**书架排序**：中文书名比较由每次调用 `localeCompare(x, 'zh-Hans-CN')` 改为
模块级单例 `Intl.Collator` —— 排序结果逐字等价（新增单测断言）。

### 验证

- `npm test`：**76 文件 / 1223 用例全绿**（基线 1204，+19）
- `npm run lint`：**0 error / 0 warning**
- `npm run format:check`：通过
- `npm run build` / `npm run build:electron`：通过
- `npm run e2e`：**20 passed / 1 failed** —— 失败项为 `e2e/bookshelf.spec.ts`
  「侧栏默认折叠为图标轨，hover 后悬浮展开显示文字」（断言 rail 宽度 64px，
  实测 200px）。**存量失败**：已在基线提交 `4b31cdb`（本轮任何改动之前）
  复现同样失败；成因是 Playwright 鼠标初始位置 `(0,0)` 恰落在侧栏 rail 上 →
  hover 态展开。本轮未触碰 sidebar，不宣称全绿。

### 外部评审

- Round 1（需求分析，provider=coding-bridge，SESSION_ID `fc616333-b74a-4923-ba81-24d3f11455cf`）：**NEEDS_CHANGES**，4 条风险全部处置（批次拆分 / 回滚策略 / 技术选型 / 测试成本评估）。
- Round 2（实施计划，同 provider，SESSION_ID `c5b30aa1-f6b4-4e57-b11a-a68bac104501`）：**NEEDS_CHANGES**，10 条风险逐条处置 —— 其中 R1c 建议的 `@defer` 被采纳（F2 改用 `@defer`），R3 关于 F14 的四条边角逐条核实后**据此放弃 CDK 虚拟滚动**并改用 `content-visibility`，R11（实施中发现的评审建议「窗口锁共享」形态无法解除单窗口物理约束）被记录为有意偏离并改用独立 CF 窗口。

## 验收结论

- 9 项发现（F1-F4 / F10-F14）全部实施，每项均有同口径前后数据；未实施项（批次 ② F5-F9）已在「备注」中记录原因（含 F5 沿用既有 commit 已明确拒绝的先例）。
- 全部改动在最终代码上重跑验证：单测 1223 全绿、lint 0/0、format:check 通过、双构建通过、e2e 20/21（失败项为存量）。
- 未实测范围如实披露：真实 Electron 打包产物的冷启动计时、webview guest 存活、
  CF 过盾端到端、3000 章真实书的目录端到端计时。
- 归档位置：`docs/Task/Archive/2026-11/PERFORMANCE_OPTIMIZATION_ROUND3_PLAN.md`。
- 终验评审：provider=coding-bridge，SESSION_ID `9960e164-ca30-435b-b416-a230365abe8d`，verdict **APPROVED**（3 条改进建议 + 4 条残留风险 → 已转 `docs/Task/Active/PERFORMANCE_ROUND3_FOLLOWUPS.md`）。
