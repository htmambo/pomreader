# pomreader

> **白虎阅读**（原 vendor）只发打包产物、无源码。本项目**自写 UI、行为级重写核心逻辑**，交付一份可在浏览器独立运行、与原应用视觉/交互高度一致的 Angular 应用。
> 设计稿（v1.1 Round 1 APPROVED）：[`docs/Architecture/2026-09-24-POMREADER_UI_CLONE_DESIGN.md`](docs/Architecture/2026-09-24-POMREADER_UI_CLONE_DESIGN.md)

## 快速启动

```bash
# 1. 安装依赖（首次）
npm install

# 2. Angular 浏览器开发
npm start
# → http://localhost:4200

# 3. 生产构建（Angular + Electron + Worker 同步）
npm run build
#   • ng build            → electron/www/
#   • electron            → release/linux-unpacked/（仅 dist 模式）
#   • build:worker (esbuild) → src/assets/sandbox.worker.js
# 完整 Electron 包：npm run dist → release/

# 4. 单元测试（Vitest；含 src/ + electron/ 两侧单测）
npm test
#   • vitest.config.ts: include ['src/**/*.spec.ts','electron/**/*.spec.ts']
#   • 覆盖率门禁：core/logic + core/book-source（详见 README §技术栈）

# 5. E2E（Playwright，自动起 dev server）
npm run e2e

# 6. Electron 桌面开发（web + 主进程 watch + 启动）
npm run dev
#   • concurrently: ng serve --port 4200
#                   watch:electron (tsc --watch)
#                   wait-on http://localhost:4200 → electron .（POM_DEV_URL=http://localhost:4200）
```

## 技术栈

- **Angular 22.2**（standalone + signals，zoneless（运行时无 zone.js）；OnPush 全量；无 NgModule，无 RxJS）
- **ng-zorro-antd 22.1**（与原 vendor 同源；`styles/ng-zorro-overrides.scss` 暗色覆盖）
- **Electron 44.4**（主进程 + renderer + 隐藏 DB 窗口 三进程；file:// 加载）
- **SCSS + CSS variables**（`data-pom-theme` 驱动多主题，打在 `<html>` 避免弹窗闪烁）
- **PouchDB** IndexedDB（Book/Chapter 持久化）+ **localStorage**（设置）
- **valibot 1.5**（IPC 入参 runtime schema 验证；`safeHandle` 工厂统一校验）
- **@angular/localize**（i18n 机制就位；zh-Hans 默认）
- **Vitest 5.0 + jsdom**（`src/` 与 `electron/` 两侧共测，v8 coverage：**92.88% 行 / 85.1% 分支 / 90.55% 函数** 总计；978 tests across 63 files）+ **Playwright 1.63**（E2E，5 spec / 19 tests；Chromium only）
- **ESLint 9.39 + angular-eslint 22.5 + typescript-eslint 8.70**（`npm run lint`；flat config；0 errors / 0 warnings baseline）
- **esbuild**（`build:worker` 打包 `sandbox.worker.ts` → `src/assets/sandbox.worker.js`）

## 书源与扩展

- [书源开发指南](docs/Usage/BOOKSOURCE_GUIDE.md) — JS 书源头部 `@key` 规范、函数签名、`legado.http` 宿主 API、沙箱硬化细节
- [扩展开发指南](docs/Usage/EXTENSION_GUIDE.md) — UserScript 头部、v1 限制（仅元数据加载 + eval 测试入口）、`ad-remover.js` 示例
- [封面缓存说明](docs/Usage/COVER_CACHE.md) — 缓存目录、SSRF 防护、`local://` / `asset://` / `data:` / `http(s)` 渲染协议、`/settings/cache` 管理页

## 项目结构

```
src/
├── app/
│   ├── core/
│   │   ├── logic/         # 纯函数：chapter-split / text-format / bookshelf-sort / bookshelf-filter / bookshelf-group-name / auto-import-url / convert-chinese / settings-store / build-book-source-doc
│   │   ├── models/        # Book / Chapter / Settings / BookshelfGroup
│   │   ├── services/      # BookService / BookshelfGroupService / DbService (PouchDB) / ReaderService / SettingsService 等
│   │   ├── book-source/   # 书源体系：适配器注册表 + JS 书源沙箱 + legado 订阅源导入
│   │   │   ├── adapters/  # 专用站（笔趣阁）/ 启发式密度算法兜底
│   │   │   ├── js-source/ # sandbox.worker（网络出口屏蔽 + 原型冻结）+ 健康检查/多镜像
│   │   │   ├── legado/    # Legado 订阅源 JSON 解析/翻译/导入
│   │   │   ├── smart-add/ # 智能添加规则引擎
│   │   │   └── source-test/# 书源五步测试
│   │   ├── data/          # 跨 book-source 子模块共享数据（good-sites 等）
│   │   ├── db/            # PouchDB 工具（bulk-result 错误分类、IpcPouchBackend 抽象）
│   │   └── cover/         # 封面缓存 / generators（程序生成封面）
│   ├── shared/components/ # 11 个子目录: book-card / book-group-dialog / bookshelf-group-dialog / change-book-source-dialog / cover-generator-dialog / cover-img / edit-book-info-dialog / jump-chapter-dialog / page-header / rules-panel / sidebar
│   ├── pages/             # bookshelf / universal-search / reader / disclaimer
│   │   ├── book-source/   # 书源管理 6 子页: list / search / smart-add / debug / test / editor
│   │   └── settings/      # 缓存管理
│   ├── modals/            # import-online / import-local-txt / import-legado / book-source-migration-report（4 个弹窗，每个独立子目录）
│   ├── directives/        # 共享指令（如无限滚动 / 长按等）
│   ├── app.component.ts
│   ├── app.config.ts      # bootstrapApplication providers（含书源适配器注册）
│   └── app.routes.ts      # lazy load 路由
├── assets/
│   ├── fonts/             # 嵌入字体
│   ├── themes/            # 主题 JSON（与 data-pom-theme 配对）
│   └── sandbox.worker.js  # build:worker 产物（esbuild 打包）
├── styles/
│   ├── tokens.scss
│   ├── ng-zorro-overrides.scss
│   ├── rules-panel.scss
│   └── reader.scss
├── typings/               # 全局 .d.ts
└── test-setup.ts          # Vitest 初始化（@angular/compiler JIT）

electron/
├── main.ts                # 主进程入口（BrowserWindow 生命周期 + 单实例锁）
├── preload.ts             # contextBridge 桥接（preload 暴露给 renderer 的 API 表）
├── window-state.ts        # 窗口位置/尺寸持久化（带边界与可见性校验）
├── auto-import.ts         # 文件拖入/剪贴板监听 → 自动入库
├── ipc/                   # 11 个 IPC handler：booksource / fetch / render / cover / external / cf-guard / encoding / safe-net / net-guard / fetch-session / schema
├── db/                    # 隐藏窗口：db-window.html + db-window.ts + db-renderer.ts（独立 PouchDB 进程隔离）
├── scripts/after-install.sh
├── www/                   # ng build 产物（生产加载）
└── *.spec.ts              # electron 侧单测（vitest.config.ts include 已包含）

e2e/                       # Playwright（5 个 spec；配置在仓库根 playwright.config.ts）
docs/
├── Architecture/          # 设计稿（白虎阅读 v1.1）
├── Usage/                 # BOOKSOURCE_GUIDE / EXTENSION_GUIDE / COVER_CACHE
├── Task/                  # Active + Archive/2026-MM
├── superpowers/specs/     # 设计文档（如 2026-09-24-online-search-import-design.md）
└── CONVENTIONS.md         # 命名 / 拆分 / OnPush / 测试 等长篇参考

.omc/fullauto/             # fullauto 审计记录：convention-normalize / legado-migration / pomreader-arch-evo / pomreader-arch-evo-2
```

> 项目约定详见 [`AGENTS.md`](AGENTS.md)（硬规则，每会话必读）+ [`docs/CONVENTIONS.md`](docs/CONVENTIONS.md)（长篇参考 + §exceptions 豁免清单）。

## 路由

| 路径 | 组件 / 子路由 | 说明 |
|---|---|---|
| `/` | redirect | → `/bookshelf` |
| `/bookshelf` | BookshelfComponent | 书架首页（lazy load） |
| `/search` | SearchPlaceholderComponent | 万能搜索占位（webview 由 AppComponent 外壳常驻保活，此处仅占标题） |
| `/book-sources/*` | 子路由 | 列表 / 搜索 / 智能添加 / 调试 / 测试 / 编辑 |
| `/settings/*` | 子路由 | 缓存管理 / 阅读偏好 |
| `/disclaimer` | DisclaimerComponent | 免责声明 |
| `/reader/:bookId/:chapterId` | ReaderComponent | 阅读器（不进 header，全屏） |
| `**` | redirect | → `/bookshelf` |

## 关键文件

### Angular 侧（src/app/）

- `core/logic/chapter-split.ts` — TXT 章节切分（核心算法）
- `core/services/book.service.ts` — 书架/章节中枢：导入、PouchDB 读写、章节内存缓存
- `core/book-source/js-source/sandbox.worker.ts` — JS 书源沙箱（屏蔽网络出口 + 冻结原型链 + window/document/localStorage 删除）
- `core/services/settings.service.ts` — 阅读设置持久化与校验；主题经 `app.component.ts` 打在 `<html data-pom-theme>`
- `core/services/global-error-handler.ts` — 全局异常兜底 → ToastService
- `core/db/bulk-result.ts` — PouchDB bulkDocs 错误分类工具
- `styles/ng-zorro-overrides.scss` — ng-zorro 暗色主题覆盖（与原 vendor 一致）

### Electron 侧（electron/）

- `main.ts` — 主进程入口（窗口生命周期 / 单实例锁 / IPC 注册）
- `preload.ts` — contextBridge 桥接表（renderer 可访问的 IPC 白名单）
- `window-state.ts` — 窗口位置/尺寸持久化（含边界校验 + 显示器可见性判定）
- `ipc/schema.ts` — valibot IPC 入参 schema + `safeHandle` 工厂（多参数 spread 校验）
- `ipc/booksource-handler.ts` — 书源 JS 文件 CRUD + 流式列表 + HTTP 代理 + eval 入口
- `ipc/booksource-meta.ts` — 书源头部解析（@name/@author/@url/@tags 等 20+ 字段）+ 原子写
- `ipc/fetch-handler.ts` — HTTP 抓取入口（encoding 协商 + safeNetRequest + CF Tier 1）
- `ipc/render-handler.ts` — 隐藏窗口（CF Tier 1 真实浏览器渲染）+ 销毁兜底
- `ipc/cf-guard.ts` — Cloudflare 挑战判定（基于 HTTP 状态/headers/body 头 4KB）
- `ipc/safe-net.ts` — net-guard + safeNetRequest（isPrivateHost SSRF 防护 + 私有 IP 黑名单）
- `ipc/encoding.ts` — 字节流解码（mode > Content-Type charset > HTML meta > utf-8；gbk/gb2312 归一化 gb18030）
- `db/db-window.ts` — 隐藏 DB 窗口主进程（独立 PouchDB 进程隔离）

## 与原 vendor 的差异

| 项 | 原 vendor | 本项目 |
|---|---|---|
| 源码 | 仅打包产物 | Angular 22 TypeScript |
| 外部源 | 硬编码接入 | 书源适配器体系（专用 / 启发式 / JS 沙箱 / Legado 导入） |
| 主题切换 | `<body>` 上打标 | `<html>` 上打 `data-pom-theme`（避免弹窗背景闪烁） |
| 路由参数 | `/:bookId` | `/:bookId/:chapterId` |
| IPC 验证 | 无 | valibot `safeHandle` 工厂统一 runtime schema 校验 |

## 演进记录（2026-09）

- **EVO-1 ~ EVO-16**：架构演进 16 项（IPC 拆模块 + safeHandle / 沙箱硬化 v2 / DbWorker pool / 4 进程模型 / 测试覆盖 / 文档对齐等）；详见 [`docs/Task/Archive/2026-09/POMREADER_ARCH_EVOLUTION_PLAN.md`](docs/Task/Archive/2026-09/POMREADER_ARCH_EVOLUTION_PLAN.md) 与 `.omc/fullauto/pomreader-arch-evo/`
- 累计 978 tests passing（63 files，src/ + electron/ 两侧）；外部审核 Round 9 APPROVED
- 主要 commit 锚点（详见 CHANGELOG §"Architecture Evolution"）：
  - EVO-1 `1765d00` BookRepository 拆出 → `d9979b1` 章节方法委托 ChapterLoader → `4af4c00` Loader/Updater 抽出 → `6a37fbe` BookUpdater 改用 BookRepositoryPort
  - EVO-2 `9628160` bulk-result helper
  - EVO-3 `97534be` / `e75c398` / `f2560f3` / `53d13d0` Worker Pool（factory → 完整 → 保守接通 → 池安全硬化）
  - EVO-4 `b226d6b` typed IPC schema via valibot safeHandle → `98c46eb` safeHandle rest args + DbService spec
  - EVO-6 `a63332a` OnPush 100% (15 component)
  - EVO-9 `04bb6bc` /search 路由 placeholder + AppComponent shell 常驻
  - EVO-11 `d3221f5` $localize wired (zh-Hans default)
  - EVO-12 `1e98637` / `d2affe9` reader / settings 拆纯逻辑 + service facade
  - EVO-16 集成在 EVO-1~8 commit 中：dev stale chunk 修复 + outputHashing:none + 懒加载自动重试
- **依赖大版本升级（2026-09-28）**：Angular 18→22 逐级迁移（ng-zorro / icons / angular-eslint lockstep）+ TS 6.0.3 + vitest 5.0 + zoneless；详见 [`docs/Task/Archive/2026-09/POMREADER_DEP_MAJOR_UPGRADE_PLAN.md`](docs/Task/Archive/2026-09/POMREADER_DEP_MAJOR_UPGRADE_PLAN.md)

## 下一步

- 加 CDP 截图对比原 app（视觉保真验证）
- 书源生态：完善 `smart-add` CSS 选择器 + `source-test` 自动化结果保存

## 排错（Linux 打包 / 运行）

| 症状 | 原因 | 解决 |
|---|---|---|
| 启动报 `Cannot find module 'iconv-lite'` 并卡死 | 该依赖被放在 `devDependencies`，electron-builder 只打包 `dependencies` | 把运行时依赖移到 `dependencies` 后重新打包 |
| 打开过阅读页后关闭窗口，进程不退出、再次启动打不开界面 | 抓取用的隐藏窗口（`render-handler.ts`）未随主窗口销毁，`window-all-closed` 不触发；单实例锁又把新启动转发给僵尸进程 | 已在 `electron/main.ts` 修复：主窗口 `closed` 时销毁所有残留窗口 |
| 启动报 `libva error: i965_drv_video.so init failed` / `vaInitialize failed` | Chromium 尝试 VA-API 视频硬解，系统只有旧 i965 驱动，在 Comet Lake+ / 混合显卡上初始化失败。**无害警告**，会自动退回软件解码 | 装新驱动即可消除：`sudo pacman -S intel-media-driver`（可用 `libva-utils` 的 `vainfo` 验证） |
| 打包 `pacman` 目标失败：`libcrypt.so.1: cannot open shared object file` | electron-builder 内置的 fpm(ruby) 需要 `libcrypt.so.1` | `sudo pacman -S libxcrypt-compat` |
| 打包警告 `desktopName is not set in package.json` | 窗口 WM_CLASS 与 .desktop 文件不匹配，任务栏/启动器无法关联窗口 | `desktopName` 放 package.json **根级**（非 `build` 内），并在 `build.linux` 设 `syncDesktopName: true` |
| Angular + Electron `file://` 报 `Failed to fetch dynamically imported module` | Angular 默认 `<base href="/">` + esbuild chunk hash 双重根因（base href 解析 + 陈旧 chunk） | 详见 `memory/angular-electron-file-base-href.md` 与 `memory/angular-electron-stale-chunk-hash.md`（同时改 `<base href="./">` + Angular `useHash=true` + 启动前清缓存） |
| `dist-electron/` 出现在仓库根目录 | `npm run build:electron` 产物未声明在 `.gitignore`（已修复）；构建过程中生成 | `.gitignore` 已配置忽略；无需清理仓库内残留（首次 `npm run dist` 后自然消失） |

## 相关文档

### 项目根
- [`LICENSE`](LICENSE) — MIT
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — 提交流程（commit / PR / 测试要求）
- [`CHANGELOG.md`](CHANGELOG.md) — 版本历史（含 EVO-1~16 commit 锚点表）

### 设计 & 架构
- [`docs/Architecture/2026-09-24-POMREADER_UI_CLONE_DESIGN.md`](docs/Architecture/2026-09-24-POMREADER_UI_CLONE_DESIGN.md) — 设计稿 v1.1
- [`docs/superpowers/specs/2026-09-24-online-search-import-design.md`](docs/superpowers/specs/2026-09-24-online-search-import-design.md) — 在线搜索+导入设计

### 任务归档
- [`docs/Task/README.md`](docs/Task/README.md) — 任务索引（active + archive 总览）
- [`docs/Task/Archive/2026-09/POMREADER_P1_P2_HARDENING_PLAN.md`](docs/Task/Archive/2026-09/POMREADER_P1_P2_HARDENING_PLAN.md) — P1+P2 基础设施硬化（已 completed）
- [`docs/Task/Archive/2026-09/POMREADER_ARCH_EVOLUTION_PLAN.md`](docs/Task/Archive/2026-09/POMREADER_ARCH_EVOLUTION_PLAN.md) — EVO-1 ~ EVO-16 演进计划（已 completed）
- [`docs/Task/Archive/2026-09/`](docs/Task/Archive/2026-09/) — 历史任务归档（13 项已完成计划）

> 历史 fullauto 审计记录保留在 `.omc/fullauto/` 下（`pomreader-arch-evo/`、`pomreader-arch-evo-2/`、`convention-normalize/`、`legado-migration/`）。