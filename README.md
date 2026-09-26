# pomreader

> **白虎阅读**（原 vendor）只发打包产物、无源码。本项目**自写 UI、行为级重写核心逻辑**，交付一份可在浏览器独立运行、与原应用视觉/交互高度一致的 Angular 应用。
> 父设计稿：[`docs/Architecture/2026-09-24-POMREADER_UI_CLONE_DESIGN.md`](docs/Architecture/2026-09-24-POMREADER_UI_CLONE_DESIGN.md)（v1.1 Round 1 APPROVED）

> 本仓库 2026-09-25 从父仓 `pomreader`（白虎阅读 macOS DMG Linux 重打包项目）拆分，保留子项目 `pomreader-ui-clone` 全部代码与历史，迁移相关文档。父仓后续仅维护白虎阅读 Linux 重打包。

## 快速启动

```bash
# 1. 安装依赖（首次）
npm install

# 2. 启动开发服务器
npm start
# → http://localhost:4200

# 3. 生产构建
npm run build
# → dist/pomreader/

# 4. 单元测试（Vitest）
npm test

# 5. E2E（Playwright，自动起 dev server）
npm run e2e

# 6. Electron 桌面开发（web + 主进程 watch + 启动）
npm run dev
```

## 技术栈

- Angular 18+（standalone + signals）
- ng-zorro-antd 18（与原 vendor 同源）
- Electron 44（桌面壳：抓取 / CF 过盾 / 封面缓存 / 自动导入）
- SCSS + CSS variables（`data-pom-theme` 驱动多主题）
- PouchDB（Book/Chapter 持久化）+ localStorage（设置）
- Vitest（core/logic + core/book-source 单测 ≥ 90%）+ Playwright（E2E）

## 书源与扩展

- [书源开发指南](docs/Usage/BOOKSOURCE_GUIDE.md) — JS 书源头部 `@key` 规范、函数签名、`legado.http` 宿主 API、沙箱硬化细节
- [扩展开发指南](docs/Usage/EXTENSION_GUIDE.md) — UserScript 头部、v1 限制（仅元数据加载 + eval 测试入口）、`ad-remover.js` 示例
- [封面缓存说明](docs/Usage/COVER_CACHE.md) — 缓存目录、SSRF 防护、`local://` / `asset://` / `data:` / `http(s)` 渲染协议、`/settings/cache` 管理页

## 项目结构

```
src/
├── app/
│   ├── core/
│   │   ├── logic/        # 纯函数：chapter-split / text-format / bookshelf-sort / auto-import-url
│   │   ├── models/       # Book / Chapter / Settings
│   │   ├── services/     # BookService / DbService(PouchDB) / ReaderService / SettingsService 等
│   │   ├── book-source/  # 书源体系：适配器注册表 + JS 书源沙箱 + legado 订阅源导入
│   │   │   ├── adapters/ # 专用站（笔趣阁）/ 启发式密度算法兜底
│   │   │   ├── js-source/# sandbox.worker（网络出口屏蔽 + 原型冻结）+ 健康检查/多镜像
│   │   │   ├── legado/   # Legado 订阅源 JSON 解析/翻译/导入
│   │   │   └── source-test/ # 书源五步测试
│   │   └── cover/        # 封面缓存 / 程序生成封面
│   ├── shared/components/# PageHeader / Sidebar / BookCard / RulesPanel 等
│   ├── pages/            # Bookshelf / UniversalSearch / Reader / Disclaimer
│   │   ├── book-source/  # 书源管理 6 子页：列表/搜索/智能添加/调试/测试/编辑
│   │   └── settings/     # 缓存管理
│   ├── modals/           # ImportOnline / ImportLocalTxt / ImportLegado
│   ├── app.config.ts     # bootstrapApplication providers（含书源适配器注册）
│   └── app.routes.ts     # lazy load 路由
├── assets/
│   ├── data/             # books.json + chapters/*.json（首次启动 seed）
│   └── sandbox.worker.js # build:worker 产物（esbuild 打包）
└── styles/               # tokens.scss / ng-zorro-overrides.scss / rules-panel.scss
```

## 路由

| 路径 | 组件 | 说明 |
|---|---|---|
| `/` | redirect | → `/bookshelf` |
| `/bookshelf` | BookshelfComponent | 书架首页 |
| `/search` | UniversalSearchComponent | 万能搜索（webview 浏览器式） |
| `/book-sources/*` | 子路由 | 书源列表/搜索/智能添加/调试/测试/编辑 |
| `/settings/*` | 子路由 | 缓存管理 |
| `/disclaimer` | DisclaimerComponent | 免责声明 |
| `/reader/:bookId/:chapterId` | ReaderComponent | 阅读器 + 抽屉 + 设置弹窗 |
| `**` | redirect | → `/bookshelf` |

## 关键文件

- `src/app/core/logic/chapter-split.ts` — TXT 章节切分（核心算法，单测 ≥ 90%）
- `src/app/core/services/book.service.ts` — 书架/章节中枢：导入、PouchDB 读写、章节内存缓存
- `src/app/core/book-source/js-source/sandbox.worker.ts` — JS 书源沙箱（屏蔽网络出口 + 冻结原型链）
- `src/app/core/services/settings.service.ts` — 阅读设置持久化与校验；主题经 `app.component.ts` 打在 `<html data-pom-theme>`
- `src/app/core/services/global-error-handler.ts` — 全局异常兜底 → ToastService
- `src/styles/ng-zorro-overrides.scss` — ng-zorro 暗色主题覆盖（与原 vendor 一致）

## 与原 vendor 的差异

| 项 | 原 vendor | 本项目 |
|---|---|---|
| 源码 | 仅打包产物 | Angular 18 TypeScript |
| 外部源 | 硬编码接入 | 书源适配器体系（专用 / 启发式 / JS 沙箱 / Legado 导入） |
| 主题切换 | `<body>` 上打标 | `<html>` 上打 `data-pom-theme`（避免弹窗背景闪烁） |
| 路由参数 | `/:bookId` | `/:bookId/:chapterId`（v1.1 §15.2 修订） |

## 下一步

- 补全 15+ 本书的章节内容（当前 2 本有完整内容、13 本只有 stub 首章）
- 加 CDP 截图对比原 app（视觉保真验证）

## 排错（Linux 打包 / 运行）

| 症状 | 原因 | 解决 |
|---|---|---|
| 启动报 `Cannot find module 'iconv-lite'` 并卡死 | 该依赖被放在 `devDependencies`，electron-builder 只打包 `dependencies` | 把运行时依赖移到 `dependencies` 后重新打包 |
| 打开过阅读页后关闭窗口，进程不退出、再次启动打不开界面 | 抓取用的隐藏窗口（`render-handler.ts`）未随主窗口销毁，`window-all-closed` 不触发；单实例锁又把新启动转发给僵尸进程 | 已在 `electron/main.ts` 修复：主窗口 `closed` 时销毁所有残留窗口 |
| 启动报 `libva error: i965_drv_video.so init failed` / `vaInitialize failed` | Chromium 尝试 VA-API 视频硬解，系统只有旧 i965 驱动，在 Comet Lake+ / 混合显卡上初始化失败。**无害警告**，会自动退回软件解码 | 装新驱动即可消除：`sudo pacman -S intel-media-driver`（可用 `libva-utils` 的 `vainfo` 验证） |
| 打包 `pacman` 目标失败：`libcrypt.so.1: cannot open shared object file` | electron-builder 内置的 fpm(ruby) 需要 `libcrypt.so.1` | `sudo pacman -S libxcrypt-compat` |
| 打包警告 `desktopName is not set in package.json` | 窗口 WM_CLASS 与 .desktop 文件不匹配，任务栏/启动器无法关联窗口 | `desktopName` 放 package.json **根级**（非 `build` 内），并在 `build.linux` 设 `syncDesktopName: true` |

## 相关文档

- [`docs/Architecture/2026-09-24-POMREADER_UI_CLONE_DESIGN.md`](docs/Architecture/2026-09-24-POMREADER_UI_CLONE_DESIGN.md) — 设计稿 v1.1
- [`docs/Task/Archive/2026-09/POMREADER_UI_CLONE_PLAN.md`](docs/Task/Archive/2026-09/POMREADER_UI_CLONE_PLAN.md) — 子项目入仓计划
- [`docs/superpowers/specs/2026-09-24-online-search-import-design.md`](docs/superpowers/specs/2026-09-24-online-search-import-design.md) — 在线搜索+导入设计

> 历史 fullauto 审计记录（`.omc/fullauto/pomreader-ui-clone/spec.md` 与 `.omc/plans/fullauto-pomreader-ui-clone-impl.md`）保留在原父仓 `pomreader`，独立仓库不再包含。
