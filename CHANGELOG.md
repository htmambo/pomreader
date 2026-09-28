# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> 历史 commit 自动生成：未来通过 `standard-version` / `release-please` 工具根据 conventional commits 自动生成。本文件由 maintainer 手工初始化并定期合并工具输出。

## [Unreleased]

### Features

- **sidebar**: 侧栏改为图标轨（默认 64px 仅图标）+ hover 悬浮展开 200px（主内容不位移），「书源管理」子菜单默认收起；展开/收起时图标列位置不变，面板自右侧收回
- **bookshelf**: 书架新增分类（legado 分组语义：多分类 + `Book.groupIds`）与阅读状态筛选（全部 / 未读 / 正在读 / 已读完，带计数、两行互为分面）；分类通过 `group:{id}` PouchDB 文档持久化，入口为书卡右键「分类…」/ 批量栏「分类」/ chips 行「管理分类」

### Bug Fixes

- **electron/ipc**: `pom:get-fetch-ua` 的入参 schema 由 `v.nullish(v.null(), null)` 改为 `v.strictTuple([])`。`safeHandle` 用 `...rest` 收集后 parse 的是 **args 数组**，零参调用收到 `[]`，与 nullish 恒不匹配 —— 该 channel 每次调用都抛 `IpcValidationError`，设置页读不到当前 UA（`strictTuple` 额外拒绝多余参数）
- **electron/ipc**: `pom:set-webview-encoding` 在 session 没有 `webRequest`（未初始化 partition / 老版本 Electron）时，`ses.webRequest.onHeadersReceived` 抛 TypeError 打挂 IPC；改为可选链 + 函数类型判断，缺能力时静默跳过
- **electron/ipc**: `fetch-handler.ts` 移除 handler 内的 `require('electron')`（ESM 下无 `require` 标识符，且与文件顶部 import 不一致），改为顶部静态 import `session`

### Tests

- **electron/ipc**: 新增 `fetch-handler.spec.ts`（23 例）—— 补上此前完全缺失的注册级测试层：4 个 channel 的注册/schema 契约（含零参 `pom:get-fetch-ua` 回归）、UA 读写与校验、webview 编码拦截器、`pom:fetch-html` 的 SSRF 拦截 / 浏览器请求头 / gbk 解码 / CF 过盾回落 / 8MB 上限 / 15s 超时

### Refactor

- **data**: 移除内置示例书 seed（`src/assets/data/books.json` + 15 章 JSON）；`DbService.seedIfEmpty()` 简化为 no-op（保留接口兼容 `BookRepository.load()`）

### Documentation

- **README**: 198 行重写对齐项目当前状态（build 输出路径 / 路由表 / 关键文件 / 演进记录 / 排错条目）
- **README**: 新增"演进记录（2026-09）"小节 + `file://` 懒加载失败排错条目

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