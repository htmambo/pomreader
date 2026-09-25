# POMREADER_UI_CLONE 完整设计方案

> **状态**：✅ v1.1 — Round 1 External Review: APPROVED（已应用 5 条 suggestions）
> **创建**：2026-09-24
> **位置**：本仓 `docs/Architecture/`（子项目 `pomreader-ui-clone/` 在仓根下）
> **审核记录**：§16 External Review Opinion（Round 1/5 — coding-bridge）

---

## 1. 目标与动机

**白虎阅读**（原 vendor）只发打包产物，无源码、无 sourcemap。本项目**自写 UI、行为级重写逻辑**，交付一份可在浏览器独立运行、与原应用视觉/交互高度一致的 Angular 应用。

| 维度 | 取舍 |
|---|---|
| 目标 | 纯 UI 复现 + 行为级重写核心逻辑 |
| 范围 | 高保真全画面（4 主路由 + 全弹窗 + 抽屉 + 动效） |
| 与原 vendor 的依赖 | 仅文档/截图参考；不加载原 bundle；不联原 _pouch_config |

---

## 2. 范围与非目标

### In scope
- 路由：`/书架`、`/万能搜索`、`/免责声明`、`/阅读器/:bookId/:chapterId`
- 弹窗：导入在线书页、导入本地 TXT、阅读效果配置、确认弹窗
- 抽屉：阅读页目录抽屉（nz-drawer）
- 主题：light/dark + 弹窗跟随方案 + 字体色/界面背景可配
- Mock：15+ 本假书 × 30-60 章；古典名篇片段拼接
- 算法：TXT→章节切分、外部源 URL 解析（行为级重写）、主题色变量解析
- 视觉保真：与原应用一致的暗色/亮色主题、纹理背景、antd 组件样式
- 动效：路由切换、抽屉/弹窗过渡、hover/focus 状态

### Out of scope（明确不做）
- 实际 PouchDB / IndexedDB 数据持久化（用 localStorage 替代）
- 原 vendor 真实在线书源的接入（mock "搜索中…"→"假结果"流程）
- 原 asar 替换/集成（独立项目）
- 移动端适配（仅桌面端宽屏）
- 国际化（仅中文 UI）
- 单元测试覆盖率 < 70% 的算法模块（章节切分需 ≥ 90%）

---

## 3. 技术栈

| 层 | 选型 | 理由 |
|---|---|---|
| 框架 | Angular 18+ (standalone + signals) | 与原应用同栈；官方推荐形态 |
| UI 库 | ng-zorro-antd 18+ | 原应用 UI 主库，1:1 视觉复用 |
| 样式 | SCSS + CSS variables | CSS variables 驱动 light/dark；SCSS 用于 token 复用 |
| 持久化 | localStorage | **仅**存：主题、设置（fontColor/screenBg/defaultTheme）、阅读进度（bookId + chapter index）。**不存**章节正文（避免 `QuotaExceededError`；TXT 全文仅留在内存 / Service 局部变量；mock 章节走静态 JSON + HTTP 缓存） |
| 测试 | Vitest + @testing-library/angular | 跑得快；Angular 官方推荐 |
| Lint | ESLint (angular-eslint) + Prettier | 默认 Angular CLI 配置 |
| 构建 | esbuild（Angular 18 默认） | 速度 |

### 关键依赖版本基线
```json
{
  "@angular/core": "^18.0.0",
  "ng-zorro-antd": "^18.0.0",
  "@angular/cdk": "^18.0.0",
  "rxjs": "~7.8.0",
  "vitest": "^2.0.0"
}
```

---

## 4. 目录结构

```
pomreader-ui-clone/
├── src/
│   ├── app/
│   │   ├── app.config.ts                # bootstrapApplication providers
│   │   ├── app.routes.ts                # 路由表
│   │   ├── app.component.ts             # 根壳（nz-layout: 侧栏 + 页头 + 内容）
│   │   │
│   │   ├── core/                        # 单例：服务、模型、纯算法
│   │   │   ├── services/
│   │   │   │   ├── theme.service.ts           # 主题切换 + 持久化（signal）
│   │   │   │   ├── settings.service.ts        # 字号/字体色/界面背景（signal）
│   │   │   │   ├── book.service.ts             # 加载 books.json + 章节查询
│   │   │   │   ├── reader.service.ts          # 当前阅读位置 + 进度持久化
│   │   │   │   ├── import.service.ts           # 调用 chapter-split 逻辑
│   │   │   │   ├── external-source.service.ts  # 调用 online-source-resolver
│   │   │   │   └── toast.service.ts            # 全局消息提示
│   │   │   ├── models/
│   │   │   │   ├── book.model.ts
│   │   │   │   ├── chapter.model.ts
│   │   │   │   ├── settings.model.ts
│   │   │   │   └── color-mode.model.ts
│   │   │   └── logic/                        # 纯函数，无 Angular 依赖
│   │   │       ├── chapter-split.ts            # TXT → 章节
│   │   │       ├── online-source-resolver.ts  # URL → 假书页结构
│   │   │       └── theme-resolver.ts          # 弹窗跟随方案的颜色解析
│   │   │
│   │   ├── shared/                       # 跨页面复用
│   │   │   ├── components/
│   │   │   │   ├── page-header/                # 3 标签页头
│   │   │   │   ├── sidebar/                    # 侧栏导航
│   │   │   │   ├── book-card/                  # 书架单本书卡片
│   │   │   │   ├── color-picker/               # 颜色选择器（与原一致）
│   │   │   │   ├── empty-state/                # 空状态
│   │   │   │   └── skeleton-text/              # 加载骨架
│   │   │   └── directives/
│   │   │       └── theme-attribute.directive.ts  # 给宿主元素打 data-color-mode
│   │   │
│   │   ├── pages/                        # 路由级组件
│   │   │   ├── bookshelf/
│   │   │   │   ├── bookshelf.component.ts
│   │   │   │   └── bookshelf.component.html
│   │   │   ├── universal-search/
│   │   │   ├── reader/
│   │   │   │   ├── reader.component.ts
│   │   │   │   ├── reader-toolbar/             # 字号/主题/目录按钮
│   │   │   │   └── chapter-drawer/             # 目录抽屉
│   │   │   └── disclaimer/
│   │   │
│   │   └── modals/                       # nzModal 内容组件
│   │       ├── import-online/
│   │       │   ├── import-online.component.ts
│   │       │   └── url-parser-preview.ts       # 解析结果显示
│   │       ├── import-local-txt/
│   │       │   ├── import-local-txt.component.ts
│   │       │   └── upload-drop-zone.ts        # 拖放区（默认 #fafafa 暗色适配）
│   │       ├── reader-settings/
│   │       │   ├── reader-settings.component.ts
│   │       │   └── scheme-follow.ts           # 弹窗跟随方案逻辑
│   │       └── confirm/
│   │
│   ├── assets/
│   │   ├── data/
│   │   │   ├── books.json                    # 15+ 本书元数据
│   │   │   └── chapters/
│   │   │       ├── book-001.json             # 每本 30-60 章
│   │   │       └── ...
│   │   ├── covers/                           # 程序生成 SVG 封面（CSS var 上色）
│   │   └── themes/                           # 背景纹理（提取自原 assets/themes/）
│   │
│   ├── styles/
│   │   ├── tokens.scss                       # 设计 token（提取自原 styles bundle）
│   │   ├── themes.scss                       # light/dark CSS 变量映射
│   │   ├── ng-zorro-overrides.scss           # 适配 ng-zorro 默认样式
│   │   └── reset.scss                        # 极简 reset（仅必要的）
│   │
│   └── styles.scss                           # 入口
│
├── public/
│
├── docs/
│   ├── TOKENS.md                             # 提取的设计 token 与原始出处
│   ├── CDP-REFERENCE.md                      # CDP 截图与差异记录
│   └── CHAPTER-SPLIT-SPEC.md                 # 反推的章节切分规则文档
│
├── angular.json
├── package.json
├── tsconfig.json
└── README.md
```

---

## 5. 数据模型

```ts
// src/app/core/models/color-mode.model.ts
export type ColorMode = 'light' | 'dark';

// src/app/core/models/settings.model.ts
export interface Settings {
  fontColor: string;            // #RRGGBB
  screenBg: string;             // #RRGGBB（亮色界面背景）
  defaultTheme: boolean;        // 是否跟随默认主题
  colorMode: ColorMode;
}

// src/app/core/models/book.model.ts
export interface Book {
  id: string;
  title: string;
  author: string;
  coverColor: string;           // 封面底色（CSS variable 名）
  chapterCount: number;
  totalChars: number;
  importedAt: string;           // ISO date
  source: 'local-txt' | 'online' | 'mock';
  sourceUrl?: string;           // online 来源时填
}

// src/app/core/models/chapter.model.ts
export interface Chapter {
  bookId: string;
  index: number;
  title: string;
  content: string;              // HTML 或纯文本（渲染时由 reader 决定）
}

export interface ImportedChapter {
  title: string;
  startLine: number;
  endLine: number;
}
```

---

## 6. 服务层接口

```ts
// src/app/core/services/theme.service.ts
@Injectable({ providedIn: 'root' })
export class ThemeService {
  readonly mode: WritableSignal<ColorMode>;
  readonly effectiveMode: Signal<ColorMode>;  // 跟随系统时计算

  toggleMode(): void;
  applyToBody(): void;                          // 给 document.body 打 data-color-mode
}

// src/app/core/services/settings.service.ts
@Injectable({ providedIn: 'root' })
export class SettingsService {
  readonly settings: WritableSignal<Settings>;

  update<K extends keyof Settings>(key: K, value: Settings[K]): void;
  resetToDefault(): void;
}

// src/app/core/services/book.service.ts
@Injectable({ providedIn: 'root' })
export class BookService {
  readonly books: Signal<Book[]>;
  getById(id: string): Book | undefined;
  getChapters(bookId: string): Promise<Chapter[]>;
}

// src/app/core/services/reader.service.ts
@Injectable({ providedIn: 'root' })
export class ReaderService {
  readonly currentBookId: WritableSignal<string | null>;
  readonly currentChapterIndex: WritableSignal<number>;
  readonly progress: Signal<{ bookId: string; chapter: number } | null>;

  openBook(bookId: string, chapter?: number): void;
  nextChapter(): void;
  prevChapter(): void;
  saveProgress(): void;
}

// src/app/core/services/import.service.ts
@Injectable({ providedIn: 'root' })
export class ImportService {
  async importFromFile(file: File): Promise<Book>;        // 调 chapter-split
  async importFromUrl(url: string): Promise<Book>;         // 调 online-source-resolver
}
```

所有服务都用 **signals** 暴露状态，组件用 `inject()` + `computed()` 订阅；无 NgModule。

---

## 7. 行为级重写算法

### 7.1 TXT 章节切分（核心）

**输入**：纯文本 File 对象 / string  
**输出**：`ImportedChapter[]`

**算法**（反推自原 STATUS.md "兼容补丁 ⑥" 隐含行为 + 原 CDP 试验）：

```ts
// src/app/core/logic/chapter-split.ts
export function splitChapters(
  text: string,
  opts?: { pattern?: RegExp; minLength?: number }
): ImportedChapter[] {
  const pattern = opts?.pattern ?? defaultChapterPattern();
  const lines = text.split(/\r?\n/);
  const chapters: ImportedChapter[] = [];
  let currentTitle = '__preamble__';
  let currentStart = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (pattern.test(line)) {
      // 关闭上一章
      if (i > currentStart) {
        chapters.push({
          title: currentTitle,
          startLine: currentStart,
          endLine: i - 1,
        });
      }
      currentTitle = line;
      currentStart = i + 1;
    }
  }
  // 最后一章
  if (currentStart < lines.length) {
    chapters.push({
      title: currentTitle,
      startLine: currentStart,
      endLine: lines.length - 1,
    });
  }
  return chapters.length > 1 ? chapters : [{ title: '全文', startLine: 0, endLine: lines.length - 1 }];
}

// 默认章节标题匹配规则（参考原 vendor 公开行为）
function defaultChapterPattern(): RegExp {
  // 匹配：第X章 / 第X回 / Chapter X / CHAPTER X
  return /^\s*(?:第[\s\S]{1,12}[章回][\s\S]{0,3}|chapter[\s\S]{0,3}\d+|chapter[\s\S]{0,3}[ivx]+)\s*$/i;
}
```

**测试用例**（必须通过的边界）：

| 输入 | 期望 |
|---|---|
| 纯文本无章节标题 | `[{ title: '全文', ... }]` |
| 多章但首尾有空行 | 正确切分且不丢章节 |
| 标题中间有全角空格 | `第 一 章` 也命中 |
| 标题含特殊符号 `【第X章】` | 命中（pattern `\s*[\s\S\S]*[章回]` 允许） |
| 极短文本（< 100 字） | 不切分，整体作为单章 |

**单测覆盖目标**：≥ 90%（所有边界 case）

### 7.2 外部源 URL 解析

```ts
// src/app/core/logic/online-source-resolver.ts
export interface ResolvedSource {
  title: string;
  author: string;
  chapters: { title: string; url: string }[];
}

export function resolveSource(url: string): Promise<ResolvedSource> {
  // 因无原 vendor 接入，固定返回 mock 结构
  // 真实接入时替换为 fetch(url) + 解析规则
  return Promise.resolve(mockResolvedSource(url));
}
```

**mock 行为**：
- 接收任何 URL
- 解析 host 作为 "书源"
- 返回 5-10 章 mock 章节（标题用 lorem-style 占位）
- 5% 概率返回 `{ error: 'source-unavailable' }`（模拟失败）

### 7.3 弹窗跟随方案的颜色变量解析

```ts
// src/app/core/logic/theme-resolver.ts
export function resolveSchemeColors(
  scheme: 'light' | 'dark',
  fontColor?: string,
  screenBg?: string
): { fg: string; bg: string } {
  if (scheme === 'dark') {
    return {
      fg: fontColor ?? '#666666',
      bg: screenBg ?? '#161819',
    };
  }
  return {
    fg: fontColor ?? '#262626',
    bg: screenBg ?? '#CDC0A4',
  };
}
```

---

## 8. 路由与组件树

### 路由表

```ts
// src/app/app.routes.ts
export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'bookshelf' },
  { path: 'bookshelf', loadComponent: () => import('./pages/bookshelf').then(m => m.BookshelfComponent) },
  { path: 'search', loadComponent: () => import('./pages/universal-search').then(m => m.UniversalSearchComponent) },
  { path: 'disclaimer', loadComponent: () => import('./pages/disclaimer').then(m => m.DisclaimerComponent) },
  { path: 'reader/:bookId', loadComponent: () => import('./pages/reader').then(m => m.ReaderComponent) },
  { path: '**', redirectTo: 'bookshelf' },
];
```

### 根壳层级

```
<App>                          # app.component.ts
├── <nz-layout>                # 全局布局
│   ├── <nz-sider>             # 侧栏
│   │   └── <Sidebar/>         # 三链接
│   ├── <nz-header>            # 页头
│   │   ├── <PageHeader/>      # 3 标签
│   │   └── <nz-button-group>  # 右侧按钮（导入、设置）
│   └── <nz-content>           # 路由出口
│       └── <router-outlet/>
```

### 路由层级

| 路由 | 组件 | 关键子组件 | 调用的 Service |
|---|---|---|---|
| `/bookshelf` | BookshelfComponent | BookGridComponent | BookService |
| `/search` | UniversalSearchComponent | SearchBox, SearchResults | (inline) |
| `/disclaimer` | DisclaimerComponent | MarkdownRender | (none) |
| `/reader/:bookId` | ReaderComponent | ReaderToolbar, ChapterDrawer | ReaderService, SettingsService, ThemeService |

---

## 9. 主题系统

### 9.1 CSS 变量映射

```scss
// src/styles/themes.scss
:root[data-color-mode='light'][data-default-theme='1'] {
  --pom-bg: #e2d1a5;          // 主体背景（亮色，含纹理）
  --pom-fg: #f4eac7;          // 阅读区背景
  --pom-text: #262626;
  --pom-text-muted: #8c8c8c;
  --pom-border: #d4cba0;
  --pom-card: #faf6e8;
  --pom-text-on-card: #262626;
}

:root[data-color-mode='dark'][data-default-theme='1'] {
  --pom-bg: #161819;
  --pom-fg: #0e0f11;
  --pom-text: #666666;
  --pom-text-muted: #999999;
  --pom-border: #26292b;
  --pom-card: #1b1d1e;
  --pom-text-on-card: #999999;
}
```

（变量值与原 `白虎阅读_asar/app/index.prod.html` 中的内联 style 一致）

### 9.2 ng-zorro 主题覆盖

```scss
// src/styles/ng-zorro-overrides.scss
[data-color-mode='dark'] {
  --ant-primary-color: #177ddc;        // 与原 app 暗色主色一致
  .ant-modal-content { background: var(--pom-card); color: var(--pom-text); }
  .ant-modal-header  { background: var(--pom-card); border-color: var(--pom-border); }
  .ant-modal-title   { color: var(--pom-text-muted); }
  .ant-input         { background: var(--pom-bg); border-color: var(--pom-border); color: var(--pom-text-muted); }
  // ... 其它组件
}
```

### 9.3 主题持久化

`ThemeService.applyToBody()` 在初始化和切换时给 `document.body` 设置 `data-color-mode` / `data-default-theme`；ng-zorro 与自定义组件通过 CSS 选择器自动响应。

---

## 10. Mock 数据策略

### 10.1 books.json 结构

```json
[
  {
    "id": "shuijing-zhuan-001",
    "title": "水浒传",
    "author": "施耐庵",
    "coverColor": "#8b4513",
    "chapterCount": 40,
    "totalChars": 950000,
    "importedAt": "2026-09-20T10:00:00Z",
    "source": "mock"
  },
  ...15 本
]
```

### 10.2 章节内容

每本书章节文件结构：

```json
[
  { "bookId": "shuijing-zhuan-001", "index": 0, "title": "第一回 张天师祈禳瘟疫 洪太尉误走妖魔", "content": "..." },
  ...30-60 章
]
```

**章节内容生成**：
- 用古典名篇（《古文观止》《世说新语》《水浒传》《三国演义》片段）拼接
- 每章 1500-2500 字
- 通过脚本 `scripts/generate-mock-data.ts` 生成（生成后 commit 进 assets/）

### 10.3 封面

**不用图片**——用 SVG + CSS variable 上色：

```html
<div class="book-cover" [style.--cover-color]="book.coverColor">
  <svg viewBox="0 0 100 140">
    <rect width="100" height="140" fill="var(--cover-color)"/>
    <text x="50" y="70" text-anchor="middle" fill="rgba(255,255,255,.85)">{{ book.title }}</text>
  </svg>
</div>
```

---

## 11. 视觉保真验证流程

### 11.1 设计 token 提取（一次性）

从 `白虎阅读_asar/app/styles.85fd6d0ea1595431a919.css` 和 `index.prod.html` 内联 style 提取：

| Token | 取值 | 出处 |
|---|---|---|
| dark-bg-base | `#161819` | 原 index.prod.html line 12 |
| dark-text | `#666666` | 同上 |
| dark-text-muted | `#999999` | 同上 |
| dark-border | `#26292b` | 同上 |
| light-bg-base | `#e2d1a5` | 同上 line 20 |
| ... | ... | ... |

归档到 `docs/TOKENS.md`。

### 11.2 截图对比（每 phase 验收时）

```bash
# 1. 起原 app（pack-linux.sh 启动）
# 2. 起新 UI clone（ng serve，端口 4200）
# 3. 用 puppeteer/playwright 同时截图同样页面
# 4. 用 pixelmatch 生成 diff 图
# 5. 归档到 docs/CDP-REFERENCE.md
```

### 11.3 验收口径

| 阶段 | 视觉验收 | 行为验收 |
|---|---|---|
| Phase 1 | 路由壳视觉对齐原应用 | 跳转/刷新正常 |
| Phase 2 | 3 主页面在 light/dark 下视觉对齐 | 主题切换正常 |
| Phase 3 | 阅读器 + 抽屉对齐 | 翻页/进度持久化正常 |
| Phase 4 | 4 弹窗 + 拖放区对齐 | 章节切分/外部导入逻辑通过单测 |
| Phase 5 | 动效时长、缓动对齐 | hover/focus 状态完整 |

---

## 12. 测试策略

| 层 | 工具 | 覆盖目标 |
|---|---|---|
| 单元（logic） | Vitest | ≥ 90%（章节切分必达） |
| 单元（services） | Vitest | ≥ 80% |
| 组件 | @testing-library/angular | 关键交互（每个 modal/drawer 至少 1 用例） |
| E2E | Playwright | 4 路由全流程 happy path |
| 视觉 | pixelmatch（脚本） | 每 phase 一次 baseline 对比 |

**章节切分测试 fixtures**（保存在 `core/logic/__fixtures__/`）：
- `text-with-chapters.txt`（标准）
- `text-no-chapters.txt`
- `text-edge-cases.txt`（特殊符号/全角空格/英文）
- `text-very-short.txt`

---

## 13. 实施阶段与里程碑

### Phase 1：脚手架 + 设计 token（2h）
- `ng new pomreader-ui-clone --standalone --style=scss`
- 安装 ng-zorro-antd
- 复制并改写 `styles/tokens.scss` + `themes.scss`
- 根壳：nz-layout + 侧栏 + 页头骨架（无数据）
- 路由：4 路由空壳

**验收**：`ng serve` 打开，路由切换正常，light/dark 切换正常（用 dev tools 切 class）

### Phase 2：3 主页面 + 静态视觉（3h）
- books.json + 15 本 mock 数据（首先生成 3 本验证流程，再扩到 15+）
- BookshelfComponent（书卡 + 空状态）
- UniversalSearchComponent（搜索框 + 假结果）
- DisclaimerComponent（写死 markdown）
- 主题切换按钮接入 ThemeService

**验收**：CDP 截图对比原 app 书架页，差异 < 5%

### Phase 3：阅读器 + 抽屉 + 主题色可配（3h）
- chapters/*.json 生成（3 本先验证，再扩）
- ReaderComponent 渲染 + 字号/背景应用
- ChapterDrawer（nz-drawer）
- ReaderSettingsModal（含「使用默认配置」checkbox + 弹窗跟随方案）
- SettingsService + 持久化

**验收**：阅读、翻章、改字号背景都正常；CDP 截图对比阅读器

### Phase 4：导入弹窗 + 行为级重写（4h）
- ImportOnlineModal（URL 解析 + 预览）
- ImportLocalTxtModal（拖放 + chapter-split + 章节预览）
- chapter-split.ts + 单测（≥ 90% 覆盖）
- online-source-resolver.ts + mock 实现

**验收**：导入 txt 真能切分；导入 url 真能出预览章节；单测全绿

### Phase 5：动效 + 高保真精修（3h）
- 路由切换动画
- 抽屉/弹窗过渡
- hover/focus 状态补齐
- 滚动条样式（与原 app 一致：8px 细条）
- 页头/body 背景传播（CDK 滚动条槽白条修复——如原 STATUS.md ⑤）
- dark mode 持久化（localStorage）

**验收**：所有交互动画与原 app 一致；pixelmatch diff < 2%

### 总耗时估计
**20-24 小时** 集中工作（≈ 3 个工作日；含视觉对齐与逆向调试的 buffer）  
> Round 1 review 建议：从 15h 上调，预留 ng-zorro 暗色覆盖 + 逆向边界调试的余量；Phase 2 末设检查点，若视觉 diff > 5% 则提前讨论对策。

---

## 14. 风险与缓解

| 风险 | 等级 | 缓解 |
|---|---|---|
| 行为逆向结果不准（原 vendor 算法多变种） | 中 | 单测覆盖多种边界；与 CDP 实际试验对比；记录差异到 `CHAPTER-SPLIT-SPEC.md` |
| ng-zorro 主题切换与原 app 不一致 | 中 | 优先用 CSS variable 覆盖；若仍不一致，记录差异接受（接受度 ≤ 5%） |
| 15+ 本 × 30-60 章生成耗时 | 低 | 写脚本 `scripts/generate-mock-data.ts`，一次性生成后 commit |
| 视觉保真验收耗时超过预期 | 中 | phase 2 起每 phase 必做截图对比；diff > 5% 不进入下个 phase |
| `ng-zorro-antd` 升级 breaking | 低 | 锁定 18.x；不主动升级 |
| 章节切分失败导致用户报错 | 中 | 兜底返回 `[{ title: '全文', ... }]`；UI 给出"未识别章节标题，是否整体导入？"提示 |
| 抽屉/弹窗暗色主题 ng-zorro 默认类覆盖不全 | 中 | 提前在 Phase 2 加一组 `--pom-modal-fg/bg` 变量；Phase 4 再补 drawer-header/title/close 等细节 |
| 子项目过大、ng serve 启动慢 | 低 | 路由全 lazy load；vendor chunk 拆分 |

---

## 15. 验收标准（DoD）

**整体 DoD**（满足所有才能视为完成）：

### 全局异常与降级

- `app.config.ts` 注册自定义 `ErrorHandler`：捕获未处理异常 → `ToastService.error()` + 控制台埋点；UI 不白屏
- `resolveSource` 返回 `error` 字段时，ImportOnlineModal 给出明确文案（"该书源暂时不可用"）而非静默失败
- `chapter-split` 兜底已覆盖（§7.1）；导入 TXT 时即使无章节标题也能完成"全文导入"

### 路由参数对齐

**v1 → v1.1 修订**：路由改为 `/阅读器/:bookId/:chapterId`，与 §2 In scope 一致：

```ts
{ path: 'reader/:bookId/:chapterId', loadComponent: () => import('./pages/reader').then(m => m.ReaderComponent) }
```

`ReaderComponent` 启动时校验 `chapterId` 是数字、落在 `[0, chapterCount)`；非法 → 重定向到第一章节 + 0。

### 主题作用域

**v1 → v1.1 修订**：`ThemeService.applyToBody()` 重命名为 `applyToHtml()`，**改打在 `document.documentElement`（`<html>`）**，确保 nz-modal / nz-drawer / nz-notification 等默认渲染到 `body` 下的覆盖层组件能稳定继承 CSS 变量（避免暗色模式下弹窗背景闪烁）。

---

**整体 DoD**（满足所有才能视为完成）：

- [ ] 4 路由均可独立访问，所有交互可完成
- [ ] light/dark 切换不刷新持久化
- [ ] 15+ 本 mock 书在书架显示，封面颜色不同
- [ ] 任意一本可正常阅读、翻章、改字号/背景
- [ ] 阅读进度刷新后恢复
- [ ] TXT 导入：边界 case 单测全绿，UI 流程可走通
- [ ] 在线导入：URL 输入出 mock 预览，可"导入"到书架
- [ ] 弹窗跟随方案：改字体色/界面背景，弹窗实时反映
- [ ] pixelmatch diff < 2%（5 张关键截图）
- [ ] ng build --configuration production 成功，bundle < 1.5MB
- [ ] README 含启动 / 构建 / 测试说明

---

## 附录 A：参考文档（在仓内 `pomreader-ui-clone/docs/` 下创建）

- `TOKENS.md` — 设计 token 与原始出处
- `CDP-REFERENCE.md` — 截图与差异记录
- `CHAPTER-SPLIT-SPEC.md` — 章节切分规则（含所有边界 case）

## 附录 B：行为逆向方法

1. 启原 Electron app（pack-linux.sh 启动）
2. 实际操作各功能并观察变化
3. 抓 CDP 网络请求看外部源 URL 规律
4. 拖一个样本 TXT 进原 app，看章节如何被切分（用 DevTools → Memory 看数据结构）
5. 记录所有观察结果到对应 spec 文档
6. 重写算法 + 单测复现
7. 在新 UI 中接入并与原 app 并排截图对比

---

> **审阅请求**：本设计稿涵盖架构/数据/服务/算法/路由/主题/Mock/验证/测试/阶段/风险/验收 12 个维度。请逐项确认或指出需要修订之处。批准后进入 `writing-plans` 阶段输出分阶段实施计划。

---

## 16. External Review Opinion（Round 1/5）

**Provider**: coding-bridge（默认）  
**SESSION_ID**: `8220810e-f9d6-4470-8f01-ded286761b59`  
**Verdict**: **APPROVED**

### 4 条优点（reviewer 提取）
1. 范围与边界极其清晰（In scope / Out of scope 划分有效防止范围蔓延）
2. 技术选型合理且现代（Angular 18 standalone + signals + localStorage 轻量化）
3. 验证策略完备（pixelmatch 视觉回归 + 每 phase 验收口径）
4. 算法防御性好（章节切分兜底 + ≥ 90% 单测覆盖）

### 5 条 risks（reviewer 提取 — 已全部应用）
| # | 风险 | 缓解落地 |
|---|---|---|
| R1 | 路由参数定义不一致（§2 写 `:bookId/:chapterId`，§8 路由表只写 `:bookId`） | §8 路由表改为 `reader/:bookId/:chapterId`；ReaderComponent 启动校验 chapterId |
| R2 | localStorage 容量溢出（大 TXT 触发 QuotaExceededError 无 try-catch） | §3 持久化限定为元数据 + 阅读进度；TXT 全文仅留内存 |
| R3 | 进度评估极度乐观（15h 完成高保真不现实） | §13 总耗时上调至 20-24h + Phase 2 末检查点 |
| R4 | Mock 失败处理与全局异常兜底缺失（5% 失败无降级 UI、无 ErrorHandler 白屏） | 新增"全局异常与降级"段 + ToastService + 自定义 ErrorHandler |
| R5 | ng-zorro 动态组件暗色主题穿透失效（弹窗渲染在 body 下，CSS 变量不继承） | §9 `applyToBody()` → `applyToHtml()`，data-color-mode 打在 `<html>` |

### 5 条 suggestions（reviewer 提取 — 已全部应用）
1. 对齐路由参数 → R1
2. 存储策略优化（TXT 全文不入 localStorage）→ R2
3. 进度 Buffer 预留 → R3
4. 全局异常与降级（ErrorHandler + Toast）→ R4
5. 主题作用域修正（document.documentElement）→ R5

### 主助手独立判断
- 5 条 risks 中 R1 / R5 是设计稿**真 bug**（与 §2 / §3 自身矛盾），必修
- R2 / R4 是设计完整性（兜底缺失），必修
- R3 是估算问题，suggestion 合理
- 没有发现 reviewer 漏看的问题