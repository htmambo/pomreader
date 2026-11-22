# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> 历史 commit 自动生成：未来通过 `standard-version` / `release-please` 工具根据 conventional commits 自动生成。本文件由 maintainer 手工初始化并定期合并工具输出。

## [Unreleased]

### Features

- **book-source**: 书源目录 / 正文分页（T-1/T-2，设计 [`docs/Architecture/2026-09-30-BOOKSOURCE-PAGINATION-DESIGN.md`](docs/Architecture/2026-09-30-BOOKSOURCE-PAGINATION-DESIGN.md)）—— `rules` 新增两个可选分页对象 `tocPagination` / `contentPagination`（`{ area, linkPattern?, maxPages? }`，分页区域链接图遍历模型：白名单正则优先、未填按 URL 页码位自动推断、页序确定性恢复、目录缺省 100 / 正文缺省 20 / 硬上限 200、撞限 trace 标 `truncated` 不报错）；rules-panel（智能添加页 / 编辑源页共用）目录与正文卡片各加「分页（可选）」字段组（区域规则 + 链接白名单 + 最大页数），全空 = 单页、落盘文档零变化；使用指南见 `docs/Usage/BOOKSOURCE_GUIDE.md` §6
- **book-source**: 书源导入 / 导出 / 订阅（T-12，设计 [`docs/Architecture/2026-09-28-BOOKSOURCE_IMPORT_EXPORT_DESIGN.md`](docs/Architecture/2026-09-28-BOOKSOURCE_IMPORT_EXPORT_DESIGN.md)）—— bundle 格式 `pomreader.booksource.bundle` v1（单文件备份还原，`electron/ipc/booksource-bundle.ts` 纯函数内核：parseBundle 整体拒绝未知 format / 超限（单条 2MB / 整包 20MB）/ 恶意 fileName，diffBundle 分 new/identical/update/conflict 四类，uuid 优先 fileName 兜底）；导出弹窗（勾选 + 全选/反选）与导入预览弹窗（分组预览 + 渲染端 valibot 全量校验 + 逐项勾选，identical 灰显、conflict 默认不勾）；订阅（`<userData>/booksource-subscriptions.json` 状态 + `applied` sha256 基线冲突判定，主进程单条 30min 调度、启动 60s 首跑、失败记 lastError 不重试风暴，订阅管理弹窗含新增/编辑/删除/立即检查，更新广播 `pom:booksource-updated` 触发列表刷新与 toast）
- **book-source**: JS 书源 → JSON 规则书源改造（P0-P3，方案 [`docs/Architecture/2026-09-29-BOOKSOURCE-JSON-RULES-PLAN.md`](docs/Architecture/2026-09-29-BOOKSOURCE-JSON-RULES-PLAN.md)）—— 书源载体改为 `<userData>/booksources/*.json`（`BookSourceDoc`：meta + `rules` 16 字段，valibot 校验，模型在 `core/models/book-source-doc.model.ts`）；新增 `core/book-source/json-rule/` 规则引擎（行为与旧 JS 模板逐字段等价，含执行护栏 guard.ts；`fixtures/` 差分测试证明四入口一致）；存储/IPC 切 `.json` + 新增 `pom:booksource-convert` / `pom:booksource-migration-report` / `pom:booksource-legacy-list` 三个 channel；主进程启动时自动迁移存量 `.js`（uuid / enabled / headers 保留，`Book.bookSourceUuid` 关联不变），手改源判 needs-manual 归档 `booksources_legacy/`（永不删、永不执行，列表标灰行可查看/删除）+ 迁移报告弹窗；四页改造（编辑器删源码反解析改 meta 表单 + rules-panel / 调试页 RuleTrace 替代 sandbox.progress / 测试页换 RuleEngineService / 智能添加直出 JSON）；运行时开关 localStorage `pom.bookSource.engine` = `rule` / `js` / `both`（默认 `rule`，回滚用）。（运行时开关 `pom.bookSource.engine` 为 P0-P3 过渡期回滚手段，已随 P4 一并删除，见下方 Removed。）
- **sidebar**: 侧栏改为图标轨（默认 64px 仅图标）+ hover 悬浮展开 200px（主内容不位移），「书源管理」子菜单默认收起；展开/收起时图标列位置不变，面板自右侧收回
- **bookshelf**: 书架新增分类（legado 分组语义：多分类 + `Book.groupIds`）与阅读状态筛选（全部 / 未读 / 正在读 / 已读完，带计数、两行互为分面）；分类通过 `group:{id}` PouchDB 文档持久化，入口为书卡右键「分类…」/ 批量栏「分类」/ chips 行「管理分类」
- **book-source**: 搜索结果新增两条**可选增强规则** `SEARCH_AUTHOR_RULE` / `SEARCH_CATEGORY_RULE`（规则模型 `searchAuthorPattern` / `searchCategoryPattern`）—— 作用域是搜索结果条目内部（CSS 条目规则取元素 `innerHTML`；正则条目规则取「本条匹配起点 → 下一条匹配起点」片段），填了才提取，命中后由 `search()` 返回 `{ name, author, kind, bookUrl }` 并在书源搜索页以标签展示；留空返回空串且不影响 name/bookUrl，老书源无此常量亦可运行。规则面板（智能添加页 / 编辑源页）新增「结果-作者 / 结果-分类」输入框与测试搜索命中提示，legado 导入自动映射 `ruleSearch.author` / `ruleSearch.kind`

### Performance

- **startup**: 冷启动三处消除（[`docs/Task/Archive/2026-11/PERFORMANCE_OPTIMIZATION_ROUND3_PLAN.md`](docs/Task/Archive/2026-11/PERFORMANCE_OPTIMIZATION_ROUND3_PLAN.md)）—— ① 旧 chapter `_id` 迁移加完成标记，此前**每次冷启动**都要对 `chapter:` 前缀做一次全范围扫描（O(全库章节总数)，20 本 × 751 章 ≈ 15,020 行 id+rev 过桥），现第二次启动扫描次数 1 → 0；② `scanJsonDir` 加 `mtime + size` 缓存（此前每次调用都把全部书源全文重解析一遍，而渲染端有 5 处独立调用它）；③ 存量 JS 书源启动迁移从建窗之前挪到建窗之后（`setImmediate`），渲染进程得以与迁移并行启动，列表与一次性迁移报告两个 IPC 通道以 `migrationDone` 门控保证读到迁移后状态
- **bundle**: 首屏静态导入拆出 —— `page-header` 的两个导入弹窗改动态 `import()`，万能搜索外壳改 `@defer (when searchVisited())`（一次性信号 → 块只创建一次、永不销毁，webview 保活语义不变）。20 款内置封面 SVG 模板等业务链离开首屏：main chunk **434.39 kB → 272.58 kB（-37.3%）**，Initial total 1.46 MB → 1.25 MB，transfer 307.60 kB → 260.02 kB
- **net**: 重定向链超时预算累计化 —— 此前每跳递归各自新建一个计时器，预算不累计，最坏 4×timeout：书源代理声明 15s 实为 60s、auto-import 声明 60s 实为 240s；现整条链共享一个绝对 deadline。**行为变更提示**：这会让总耗时超过声明值的书源从「挂 60s」变为「15s 正确失败」—— 是让实现符合既有声明，而非收紧配额；若有自建书源依赖超长跳转链，请相应调高该书源的请求超时或改用更快的源
- **net**: CF 过盾抓取改用**独立隐藏窗口** —— 此前 `pom:fetch-rendered` 与 `cfFetchHtmlHidden` 共用一条全局 promise 链和同一个 BrowserWindow，一次最长 40s 的过盾抓取会把所有渲染抓取一起堵在后面；现两条链彻底解耦（两窗口同 partition，cookie / `cf_clearance` 互通，CF 窗口按需创建）
- **reader**: 阅读页目录面板排版成本减 64% —— 目录条目文案改为 computed 预计算（此前每章每轮变更检测一次函数调用），`.catalog-item` 加 `content-visibility: auto` + `contain-intrinsic-size: auto 40px`，视口外条目跳过 layout / paint。Chromium 实测（3000 条目 / 双列，7 次中位数）：强制同步布局 **51 ms → 18.3 ms**，scrollHeight 与条目高度逐字一致（无滚动条变化、无跳动）。**DOM 节点数不变** —— 省的是排版与绘制成本
- **bookshelf**: 排序的中文书名比较改用模块级缓存的 `Intl.Collator`（此前每次比较都走一遍 locale 感知路径），排序结果与 `localeCompare(x, 'zh-Hans-CN')` 逐字等价

### Removed

- **book-source**: 删除 JSON 书源「伪流式」列表死通道（IPC `pom:booksource-list-json-streaming` + 批次事件 `pom:booksource-json-batch` + preload `booksourceListJsonStreaming` + 对应 schema 与常量）—— 名不副实（先做全量 `scanJsonDir`、只把发送分批）且零生产消费方（`rg` 全仓仅命中 preload 自身与其 spec）。留痕见 `docs/CONVENTIONS.md` §exceptions
- **book-source (P4)**: 删除 JS 沙箱书源链路（书源纯 JSON 化完成；回滚需从 tag 恢复）—— 整目录 `core/book-source/js-source/`（sandbox.service / sandbox.worker / js-source.adapter / worker-pool / multi-mirror，约 2200 实现 + 2900 spec 行）+ `smart-rules.ts` 的 `generateSourceCode` 代码生成段 + 运行时开关 `pom.bookSource.engine`（`feature-flag.ts`、registry 的 `registerJsAdapter`/`loadAllJsAdapters`、列表页顶栏引擎分段控件）+ `build:worker` 脚本与 `src/assets/sandbox.worker.js` 产物 + `.js` 专属 IPC channel（`pom:booksource-list` / `-list-streaming` / `-toggle` / `-save` 及对应 preload 暴露）+ `electron/ipc/booksource-meta.ts` 的 `scanDir`（`parseHeaderMeta` 迁入 `booksource-migrate.ts`，启动迁移保留）；P1 差分测试（`diff-test.spec.ts` + `fixtures/html/` + `worker-stub.ts`）随对照组消亡一并删除，迁移 spec 在用的 3 个 `.js` 样本保留于 `fixtures/booksources/`。CF 过盾改由 RuleEngineService 直调 `CfPromptService.prompt()`（`SandboxService.cfChallengeHook` 静态钩子不再存在）
- **electron/preload**: 删除 preload `booksourceEval` / `sourceHealthCheck` 与 IPC channel `pom:booksource-eval`（沙箱时代遗物；调试/测试页与健康检测改走渲染端 `RuleEngineService`，留痕见 `docs/CONVENTIONS.md` §exceptions）
- **core/services**: 删除 `source-health.service.ts` + 其 spec（P4 删沙箱链路后该服务零生产消费方，仅被自身 spec 引用；`rg "SourceHealthService" src/ electron/` 命中仅 spec 一处）。留痕见 `docs/CONVENTIONS.md` §exceptions

### Security

- **deps**: Angular 全家桶 22.2.0 → **22.2.6**（`@angular/cdk` 同步至 22.2.7）—— 修掉两个 high 级漏洞：① `@angular/router` DoS（GHSA：SSR 空路径 outlet 路由匹配 + RouterLink 查询参数滞留，影响范围 `>=22.0.0 <22.2.1`，原锁定版本正好落在漏洞区间内）；② `zod <4.6.6` 内存耗尽 DoS（位于 `@angular/forms/node_modules/zod` 嵌套陈旧副本，随 Angular 升级同步消除）。`npm audit --omit=dev` 现仅剩 `pouchdb-browser` 传递的 `uuid` moderate（修复需降级 pouchdb major，**不处理**）

### Bug Fixes

- **electron/ipc**: `pom:get-fetch-ua` 的入参 schema 由 `v.nullish(v.null(), null)` 改为 `v.strictTuple([])`。`safeHandle` 用 `...rest` 收集后 parse 的是 **args 数组**，零参调用收到 `[]`，与 nullish 恒不匹配 —— 该 channel 每次调用都抛 `IpcValidationError`，设置页读不到当前 UA（`strictTuple` 额外拒绝多余参数）
- **electron/ipc**: `pom:set-webview-encoding` 在 session 没有 `webRequest`（未初始化 partition / 老版本 Electron）时，`ses.webRequest.onHeadersReceived` 抛 TypeError 打挂 IPC；改为可选链 + 函数类型判断，缺能力时静默跳过
- **electron/ipc**: `fetch-handler.ts` 移除 handler 内的 `require('electron')`（ESM 下无 `require` 标识符，且与文件顶部 import 不一致），改为顶部静态 import `session`

### Tests

- **electron/ipc**: 新增 `fetch-handler.spec.ts`（23 例）—— 补上此前完全缺失的注册级测试层：4 个 channel 的注册/schema 契约（含零参 `pom:get-fetch-ua` 回归）、UA 读写与校验、webview 编码拦截器、`pom:fetch-html` 的 SSRF 拦截 / 浏览器请求头 / gbk 解码 / CF 过盾回落 / 8MB 上限 / 15s 超时
- **coverage**: 收紧 `vitest.config.ts` 覆盖率阈值 —— lines 50→88、functions 60→85、branches 80→80（持平）、statements 50→86。原阈值相对实测（91-93%）形同虚设，`good-sites.ts`（0%）、`legado-parser.ts`（函数 47%）均可过关；现按实测留 2-6pp 缓冲

### Refactor

- **conventions**: 5 处超 300 行组件的 inline `template` 拆为独立 `.component.html`（AGENTS.md 硬规则），同步补 `preserveWhitespaces: true` 保留原空白语义 —— `change-book-source-dialog`（484→246 行）、`cover-generator-dialog`（403→328 行）、`universal-search`（402→280 行）、`import-legado`（328→212 行）、`book-card`（310→230 行）；其中 `change-book-source-dialog` / `universal-search` 的 inline `styles` 另拆为 `.component.scss`
- **reader**: 阅读页样式从 `src/styles/reader.scss` 迁至 `src/app/pages/reader/reader.component.scss`（与组件同目录就近维护），仍经 `styles.scss` 全局引入 —— 样式跨 ng-zorro color-picker 内部节点，组件级作用域隔离无法覆盖；资源路径相应由 `../assets/` 改为 `/assets/`（产物 CSS 解析结果不变）
- **eslint**: TS 源码与 spec 规则块显式关闭 `no-undef`（TypeScript 编译器已全量静态检查；`src/typings/*.d.ts` 的全局类型声明在 ESLint 侧属误报），全仓 lint 由 43 errors / 1 warning 清零至 **0 errors / 0 warnings**
- **ci**: `.github/workflows/ci.yml` 的 `lint-unit-build` job 补 `npm run lint` 步骤（此前仅 `format:check`，ESLint 从未真正把关）
- **data**: 移除内置示例书 seed（`src/assets/data/books.json` + 15 章 JSON）；`DbService.seedIfEmpty()` 简化为 no-op（保留接口兼容 `BookRepository.load()`）

### Dependencies

- **deps**: 大版本升级（Angular 18→22 逐级迁移）—— `@angular/* ^22.2.0`、`ng-zorro-antd` / `@ant-design/icons-angular` ^22.1.1、`angular-eslint` ^22.5.0 lockstep；TypeScript pin `~6.0.3`（严禁 7.x）；vitest 5.0；运行时 zoneless（`provideZonelessChangeDetection()`，zone.js 仅测试用）；构建器切 `@angular/build`；`engines.node` 提升为 `^22.22.3 || ^24.15.0 || ^26.0.0`，CI Node 20→24；详见 [`docs/Task/Archive/2026-09/POMREADER_DEP_MAJOR_UPGRADE_PLAN.md`](docs/Task/Archive/2026-09/POMREADER_DEP_MAJOR_UPGRADE_PLAN.md)

### Documentation

- **README**: 198 行重写对齐项目当前状态（build 输出路径 / 路由表 / 关键文件 / 演进记录 / 排错条目）
- **README**: 新增"演进记录（2026-09）"小节 + `file://` 懒加载失败排错条目
- **README / AGENTS.md / docs/CONVENTIONS.md / CONTRIBUTING.md**: 版本信息同步至 Angular 22.2 / ng-zorro 22.1 / Vitest 5.0 / angular-eslint 22.5，覆盖率与用例数刷新为实跑值（964 tests / 63 files），修复 README 指向已归档 P1+P2 计划的失效链接

## [0.1.0] - 2026-09-27

> **首次独立发布**：从父仓 `pomreader`（白虎阅读 macOS DMG Linux 重打包项目）拆分子项目 `pomreader` 独立仓库；同时合并 EVO-1 ~ EVO-16 架构演进与硬化 PR（详见下方 "Architecture Evolution"）。

### Features

- **core/services** (EVO-1): BookService 拆分 BookRepository + ChapterLoader + BookUpdater；持久化层与导入层解耦
- **core/db** (EVO-2): `bulk-result.ts` helper extraction + 3 site integration
- **core/book-source/js-source** (EVO-3): Worker Pool v2（pool≤4 / pending≤8 / 30s terminate-before-reject / LRU≤50 / exit-refill）
- **electron/ipc** (EVO-4): valibot `safeHandle` 工厂统一 IPC 入参 runtime schema 校验；多参数 spread 校验修复
- **core/services** (EVO-5): 4 进程模型（main / renderer / 隐藏 DB 窗口 + sandbox.worker）；DB 进程隔离
- **shared/components** (EVO-6): OnPush 100%（15 个组件）
- **testing** (EVO-7): Vitest 覆盖扩展至 `core/services` / `core/book-source` / `electron/ipc` 全模块；691 tests passing
- **e2e** (EVO-8): Playwright 统一替换 5 个独立 cjs 脚本；5 spec 覆盖书架 / 阅读 / 书源 / 导入
- **app/routes** (EVO-9): `withHashLocation()` 路由策略；放弃 PathLocationStrategy（适配 Electron `file://` 加载）
- **core/book-source** (EVO-10): 书源五步测试 + 智能添加规则引擎完善
- **i18n** (EVO-11): `$localize` wired（zh-Hans default）；翻译文件延后 v0.2.x
- **core/logic** (EVO-12): settings 拆纯逻辑 + service facade；reader 同源
- **conventions** (EVO-13): 规范化命名 / 结构 / 格式 11 项整改（详见 [docs/Task/Archive/2026-09/CONVENTION_NORMALIZE_PLAN.md](docs/Task/Archive/2026-09/CONVENTION_NORMALIZE_PLAN.md)）
- **perf** (EVO-14): 书源冷启动并行化（Worker Pool）
- **docs** (EVO-15): AGENTS.md / docs/CONVENTIONS.md 长篇参考 + §exceptions 豁免清单
- **perf** (EVO-16): Dev stale chunk 修复 + `outputHashing: "none"` + 懒加载自动重试

### Fixes

- **electron/ipc**: `safeHandle` rest args 收集（多参数 spread 校验；`ipcRenderer.invoke('pom:fetch-html', url, encoding)` 修复）
- **core/services**: BookService.forTest stub books/loadState getter 绑定（NG0203 DI 上下文回避）
- **electron/main**: 主窗口 `closed` 时销毁所有残留窗口（隐藏 DB 窗口 / render-handler 隐藏窗口不退出 → 进程僵尸）

### Documentation

- **AGENTS.md / docs/CONVENTIONS.md**: 73 行 / 298 行项目硬规则
- **docs/Task/Archive/2026-09/**: 10 项计划归档（CONVENTION_NORMALIZE / DEV_STALE_CHUNK_FIX / ELECTRON_IPC_CIRCULAR_DEP / LEGADO_MIGRATION / POMREADER_UI_CLONE / READER_ESC_HANDLER / SMART_ADD_CSS_SELECTOR / BOOK_SOURCE_SEARCH_BRIDGE / BOOK_SOURCE_UUID_ANCHOR / COVER_COLOR_REMOVAL）
- **README**: 198 行（待 v0.2.0 优化 LICENSE / CONTRIBUTING 链接）

## Architecture Evolution（EVO-1 ~ EVO-16 commit 锚点）

| 编号 | commit | 主题 |
|---|---|---|
| EVO-1 | `1765d00` refactor(services) | BookRepository 拆出 |
| EVO-1 | `d9979b1` refactor(services) | BookService 6 章节方法委托 ChapterLoader |
| EVO-1 | `4af4c00` feat(services) | ChapterLoader + BookUpdater 抽出（未接通） |
| EVO-1 | `6a37fbe` refactor(services) | BookUpdater 改用 BookRepositoryPort（architect #4 收口） |
| EVO-2 | `9628160` refactor(db) | bulk-result helper + 3 site 集成 |
| EVO-3 | `97534be` feat(sandbox) | Worker Pool factory + kill-switch |
| EVO-3 | `e75c398` feat(sandbox) | Worker Pool 完整（pool≤4 / pending≤8 / 30s / LRU≤50） |
| EVO-3 | `f2560f3` refactor(sandbox) | 保守接通 sandbox.service.ts + 修 tsc any |
| EVO-3 | `53d13d0` refactor(sandbox) | 池安全硬化 + BookService/BookUpdater forTest 贯通 |
| EVO-4 | `b226d6b` feat(ipc) | typed IPC schema via valibot safeHandle |
| EVO-4 | `98c46eb` fix(electron) | safeHandle rest args + DbService spec 全 CRUD |
| EVO-6 | `a63332a` refactor(perf) | OnPush 100% (15 component) |
| EVO-9 | `04bb6bc` refactor(app) | /search 路由 placeholder + AppComponent shell 常驻 |
| EVO-11 | `d3221f5` feat(i18n) | $localize wired (zh-Hans default) + docs sync |
| EVO-12 | `1e98637` refactor(logic) | reader 拆纯逻辑 + service facade |
| EVO-12 | `d2affe9` refactor(logic) | settings 拆纯逻辑 + service facade |
| EVO-16 | 集成在 EVO-1 ~ EVO-8 多 commit | dev stale chunk 修复 + outputHashing:none + 懒加载自动重试 |