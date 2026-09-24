# pomreader-ui-clone

> **白虎阅读**（原 vendor）只发打包产物、无源码。本项目**自写 UI、行为级重写核心逻辑**，交付一份可在浏览器独立运行、与原应用视觉/交互高度一致的 Angular 应用。
> 父设计稿：`../docs/Architecture/2026-09-24-POMREADER_UI_CLONE_DESIGN.md`（v1.1 Round 1 APPROVED）

## 快速启动

```bash
# 1. 安装依赖（首次）
npm install

# 2. 启动开发服务器
npm start
# → http://localhost:4200

# 3. 生产构建
npm run build
# → dist/pomreader-ui-clone/

# 4. 单元测试（Vitest）
npm test
```

## 技术栈

- Angular 18+（standalone + signals）
- ng-zorro-antd 18（与原 vendor 同源）
- SCSS + CSS variables（驱动 light/dark）
- localStorage（仅元数据 + 阅读进度）
- Vitest（logic 单测 ≥ 90%）

## 项目结构

```
src/
├── app/
│   ├── core/
│   │   ├── logic/        # 行为级重写（chapter-split / online-source-resolver / theme-resolver）
│   │   ├── models/       # Book / Chapter / Settings / ColorMode
│   │   └── services/     # ThemeService / SettingsService / BookService / ReaderService / ToastService / GlobalErrorHandler
│   ├── shared/components/# PageHeader / Sidebar / BookCard
│   ├── pages/            # Bookshelf / UniversalSearch / Disclaimer / Reader
│   ├── modals/           # ImportOnline / ImportLocalTxt
│   ├── app.config.ts     # bootstrapApplication providers
│   ├── app.routes.ts     # 4 路由 lazy load
│   └── app.component.ts  # 根壳（nz-layout）
├── assets/
│   ├── data/             # books.json + chapters/*.json（mock）
│   ├── covers/           # （SVG 程序生成，留空）
│   └── themes/           # （背景纹理，留空）
└── styles/               # tokens.scss / ng-zorro-overrides.scss
```

## 路由

| 路径 | 组件 | 说明 |
|---|---|---|
| `/` | redirect | → `/bookshelf` |
| `/bookshelf` | BookshelfComponent | 15 本 mock 书 |
| `/search` | UniversalSearchComponent | 万能搜索（mock） |
| `/disclaimer` | DisclaimerComponent | 免责声明 |
| `/reader/:bookId/:chapterId` | ReaderComponent | 阅读器 + 抽屉 + 设置弹窗 |

## 关键文件

- `src/app/core/logic/chapter-split.ts` — TXT 章节切分（核心算法，单测 ≥ 90%）
- `src/app/core/services/theme.service.ts` — `applyToHtml()` 把 data-color-mode 打在 `<html>`（避免弹窗背景闪烁）
- `src/app/core/services/global-error-handler.ts` — 全局异常兜底 → ToastService
- `src/styles/ng-zorro-overrides.scss` — ng-zorro 暗色主题覆盖（与原 vendor 一致）

## 与原 vendor 的差异

| 项 | 原 vendor | 本项目 |
|---|---|---|
| 源码 | 仅打包产物 | Angular 18 TypeScript |
| 持久化 | PouchDB / IndexedDB | localStorage |
| 外部源 | 真实接入 | mock（5-10 章 + 5% 失败） |
| 主题切换 | `<body>` 上打标 | `<html>` 上打标（v1.1 §9.3 修订） |
| 路由参数 | `/:bookId` | `/:bookId/:chapterId`（v1.1 §15.2 修订） |

## 下一步

- 补全 15+ 本书的章节内容（当前 2 本有完整内容、13 本只有 stub 首章）
- 加 CDP 截图对比原 app（视觉保真验证）
- 加 Playwright E2E 测试

## 相关文档

- `../docs/Architecture/2026-09-24-POMREADER_UI_CLONE_DESIGN.md` — 设计稿 v1.1
- `../.omc/fullauto/pomreader-ui-clone/spec.md` — fullauto 执行规格
- `../.omc/plans/fullauto-pomreader-ui-clone-impl.md` — 实施计划