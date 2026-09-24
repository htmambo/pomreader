# 数据持久化迁移计划（v1 mock → v2 PouchDB）

**Status**: 🔄 In progress (2026-09-24)
**Scope**: BookService 从内存 mock 迁移到 PouchDB 持久化，对齐原 vendor 方案
**Strategy**: 单库（pouchdb）分文档（`_id` 前缀区分表），保留 localStorage 用于 settings/progress

---

## 背景

### 当前状态（v1 mock）

`src/app/core/services/book.service.ts`：
- `_books: signal<Book[]>([])` —— 内存 signal，重启即失
- `_chaptersCache: signal<Map<string, Chapter[]>>` —— 内存 Map
- `load()` 从 `assets/data/books.json` 加载 mock 数据
- `addBook` / `importOnlineBook` 仅更新内存 signal + Map

**结果**：用户手动导入的本地 TXT / 在线书源 → 重启 app 后全部消失

### 用户报告的现象
- 万能搜索 → 解析 quanben.io → 导入 modal → 确认导入 → 书架出现新书
- **重启 app → 新书消失**，只显示 mock 的 15 本

### 设计文档与原 vendor 对齐目标

| 来源 | 期望方案 |
|---|---|
| `README.md:76` | 原 vendor = `PouchDB / IndexedDB` |
| `electron/main.ts:6` | 已预留 "防双实例 IndexedDB 锁争用" 兼容补丁 |
| `docs/Architecture/...DESIGN.md:33` | v1 明确把 PouchDB/IndexedDB 列在 **Out of scope** —— 当前实现是 v1 mock 妥协 |
| 用户需求 (2026-09-24) | 章节正文（本地+网页导入）都需要持久化 |

---

## 目标

将 `BookService` 从内存 mock 迁移到 PouchDB 持久化层，达成：

1. **重启 app 后书架保留**（Book metadata + Chapter metadata + Chapter content 全部持久化）
2. **本地 TXT 导入 + 在线网页导入同等对待**（统一走 PouchDB）
3. **与原 vendor 方案对齐**（PouchDB/IndexedDB，方便未来云同步）
4. **现有 API 兼容**（`books()` signal / `getById()` / `addBook()` / `importOnlineBook()` 签名不变）
5. **localStorage 保留 settings + reader progress**（不强制迁移）

---

## 技术选型

### PouchDB vs 替代方案对比

| 方案 | 容量 | 与原 vendor 对齐 | 工作量 | 未来云同步 | 结论 |
|---|---|---|---|---|---|
| localStorage 扩展 | < 5MB | ❌ | 1-2h | ❌ | 不选：章节正文存不下 |
| 裸 IndexedDB | 数百 MB | ⚠️ 框架一致 | 半天 | ❌ | 不选：API 抽象差 |
| **PouchDB** | **数百 MB ~ 数 GB** | **✅** | **1-2 天** | **✅ CouchDB replication** | **采用** |
| Dexie | 数百 MB | ⚠️ API 类似 | 1 天 | ❌ | 备选（如果 PouchDB 失败） |

### PouchDB 选型细节

- **包**：`pouchdb-browser@^9.0.0`（IndexedDB 适配器，浏览器/Electron 双用）
- **类型**：`@types/pouchdb-browser@^6.1.5`（DefinitelyTyped，API 与 9.x 兼容）
- **包体**：pouchdb-browser 614KB unpacked（gzip ~120KB）
- **数据库**：单库 `pomreader` 三个文档类型用 `_id` 前缀区分
  - `book:{uuid}` — Book metadata
  - `chapter:{bookId}:{idx}` — Chapter metadata + content
  - `meta:*` — 预留（settings 仍走 localStorage，未来可迁）

---

## 数据模型

### PouchDB 文档结构

```ts
// Book metadata 文档（含阅读进度，嵌入设计）
interface BookDoc {
  _id: `book:${string}`;       // uuid
  _rev?: string;              // PouchDB 自动管理
  type: 'book';
  id: string;
  title: string;
  author: string;
  coverColor: string;
  chapterCount: number;
  totalChars: number;
  importedAt: string;         // ISO
  source: 'local' | 'online';
  sourceUrl?: string;
  /** 阅读进度（嵌入，与 bookId 强耦合；删除书时自动级联） */
  progress?: {
    chapterIndex: number;
    scrollOffset?: number;
    updatedAt: string;        // ISO
  };
}

// Chapter 文档（含正文）
interface ChapterDoc {
  _id: `chapter:${string}:${number}`;  // bookId:idx
  _rev?: string;
  type: 'chapter';
  bookId: string;
  index: number;
  title: string;
  content: string;            // 完整正文
  sourceUrl?: string;         // 在线章节的原始 URL
  loaded: boolean;
}
```

### 为什么进度嵌入 Book 而不是独立 `progress:{bookId}` 文档

| 方案 | 读路径 | 写路径 | 删除书 |
|---|---|---|---|
| **嵌入 Book** ✅ | 1 次查询（`bookGet`） | 更新 Book doc（_rev 冲突需重试） | **自动级联** |
| 独立 `progress:{bookId}` | 2 次查询 | 单 doc 写 | 需手动删 |

阅读进度通常在翻章/退出阅读时更新（不是每次滚动），频率不高；嵌入方案读路径收益大、删除书自动级联，胜出。

### 存储分配最终方案

| 数据 | 存储 | 理由 |
|---|---|---|
| Book metadata + 阅读进度 | **PouchDB**（同一 doc） | 强绑定 bookId，删除级联 |
| Chapter metadata + content | **PouchDB** | 大、绑定 |
| settings（主题/字号/字体色/背景色） | **localStorage** | 全局偏好，不绑定 bookId |

### 查询模式

| 需求 | PouchDB 方法 | 说明 |
|---|---|---|
| 列所有书架 | `db.allDocs({ startkey: 'book:', endkey: 'book:￰', include_docs: true })` | `_id` 前缀范围查询 |
| 单本书 | `db.get(\`book:${id}\`)` | 精确查询 |
| 单章 | `db.get(\`chapter:${bookId}:${idx}\`)` | 精确查询 |
| 某书全部章节 | `db.allDocs({ startkey: 'chapter:{bookId}:', endkey: 'chapter:{bookId}:￰', include_docs: true })` | 前缀范围查询 |

### 与 v1 接口兼容

`BookService` 公开 API 保持不变：
- `readonly books: Signal<Book[]>` —— 从 PouchDB 加载并缓存
- `getById(id): Book | undefined` —— 内存 lookup
- `getChapters(bookId): Promise<Chapter[]>` —— 从 PouchDB 查询
- `addBook(book, chapters): void` —— 写入 PouchDB（异步 + 乐观更新 signal）
- `importOnlineBook(book, catalog): Promise<void>` —— 写入 Book metadata + Chapter metadata（content=''）
- `loadChapterContent(bookId, index): Promise<void>` —— 按需抓取并写 PouchDB
- **`updateProgress(bookId, chapterIndex, scrollOffset?)` —— 新增，写入 Book 文档 progress 字段**

`load()` 语义变化：从 `fetch('books.json')` 改为 `db.allDocs` 取所有 Book 文档。mock 数据作为"种子"：首次启动时如果 PouchDB 空，则灌入 books.json。

### reader.service.ts 改造（迁移阅读进度到 PouchDB）

- `getProgress(bookId)` 改为 `BookService.getById(bookId)?.progress`
- `setProgress(bookId, chapterIndex, scrollOffset?)` 改为调 `BookService.updateProgress(...)`
- **首次启动向后兼容**：扫描 localStorage 里的旧 progress key（如 `reader.progress`），迁移到对应 Book 文档后清除 localStorage 数据
- 旧的 `localStorage.setItem(PROGRESS_KEY, ...)` 调用全部移除

---

## 实施步骤

### Phase 1: 依赖 + 基础设施
1. `npm install pouchdb-browser @types/pouchdb-browser`
2. 新增 `src/app/core/services/db.service.ts` —— PouchDB 单例封装
   - `db = new PouchDB('pomreader')`
   - `seedIfEmpty()` —— 启动时检查，灌入 mock books.json（仅 Book metadata，Chapter 占位）
   - 提供 `bookAll()` / `bookGet(id)` / `bookPut(doc)` / `chapterAll(bookId)` / `chapterGet(bookId, idx)` / `chapterPut(doc)` 等方法

### Phase 2: BookService 重构 + reader.service 迁移
3. 改 `book.service.ts`：
   - 注入 `DbService`
   - `_books` 从 `db.bookAll()` 初始化（不再 fetch books.json）
   - `addBook` / `importOnlineBook` 写 PouchDB
   - `getChapters` 从 PouchDB 取（替代 fetch chapters/*.json）
   - `loadChapterContent` 抓取后写 PouchDB（替代仅内存）
   - 新增 `updateProgress(bookId, chapterIndex, scrollOffset?)` —— 写入 Book 文档的 `progress` 字段
4. 新增 signal `loadState: 'idle' | 'loading' | 'ready' | 'error'`，初始化时设置
5. 改 `reader.service.ts`：
   - `getProgress(bookId)` 改为从 BookService 读 Book 文档的 `progress` 字段
   - `setProgress(bookId, chapterIndex, scrollOffset?)` 改为调 BookService.updateProgress
   - 首次启动时把 localStorage 里的旧 progress 迁移到对应 Book 文档（一次性向后兼容）
6. 删除 `assets/data/books.json` 和 `assets/data/chapters/*.json`（如果不再需要）
   - **保守**：保留为 seed 源，DB 空时灌入一次
   - **激进**：删除，依赖用户自己导入
   - **决策**：保留为 seed（不破坏 v1 mock 测试体验）

### Phase 3: UI 适配
6. `bookshelf.component.ts` 初始化时确保 `BookService.load()` 已完成（避免书架空）
7. `reader.component.ts` 章节加载改为 async（已部分支持）
8. 全局处理 PouchDB 初始化失败（隐私模式 / quota）→ 降级到内存模式 + ToastService 提示

### Phase 4: 验证
9. `npm run build` + `npm test` 通过
10. 手动 e2e：
    - 导入本地 TXT → 书架显示 → 重启 app → 书架仍在 → 阅读章节有正文
    - 万能搜索 → 解析 quanben.io → 导入 → 重启 → 阅读章节正文按需抓取（不存）
    - 容量边界：导入 5 本书各 100 章 → IDB 容量检查不报错

### Phase 5: 文档
11. 更新 `README.md:76` —— "PouchDB / IndexedDB" 改为主动选型而非差异
12. 更新 `docs/Architecture/...DESIGN.md` —— 标 v2 已实现持久化

---

## 验收清单

| Phase | 项 | 状态 |
|---|---|---|
| 1 | `pouchdb-browser` + `@types/pouchdb-browser` 安装 | ⏳ |
| 2 | `DbService` 单例封装 + seed 机制 | ⏳ |
| 3 | `BookService` 改造 + signal 兼容 + `updateProgress` 新增 | ⏳ |
| 4 | `reader.service` 阅读进度迁移到 PouchDB + 旧 localStorage 一次性兼容 | ⏳ |
| 5 | `bookshelf.component` 初始化适配（`loadState` signal 订阅） | ⏳ |
| 6 | `npm run build` 通过 | ⏳ |
| 7 | `npm test` 全绿 | ⏳ |
| 8 | 手动 e2e：本地导入 → 重启保留 | ⏳ |
| 9 | 手动 e2e：在线导入 → 重启保留 | ⏳ |
| 10 | 手动 e2e：阅读进度跨重启恢复 | ⏳ |
| 11 | 容量边界：5 本 × 100 章无 quota 错误 | ⏳ |
| 12 | README + 设计文档更新 | ⏳ |

---

## 风险评估

| 风险 | 等级 | 缓解 |
|---|---|---|
| PouchDB 9 + Angular 18 兼容性 | 🟢 低 | pouchdb-browser 无 peerDep，纯 JS 包 |
| `@types/pouchdb-browser` 6.1.5 vs pouchdb-browser 9.0.0 类型错位 | 🟡 中 | 核心 API 稳定，错位只在边缘 API（replication 等） |
| IndexedDB 配额（5%-10% 磁盘空间） | 🟢 低 | 本项目用户书库规模远不到配额 |
| PouchDB 异步 + signal 同步的初始化竞态 | 🟡 中 | 用 `loadState` signal 显式状态，组件订阅 |
| PouchDB 损坏 / 升级失败 | 🟢 低 | 数据在浏览器本地，无云同步，损坏可重建 |
| 包体增加 ~120KB gzip | 🟢 低 | 可接受 |
| Chapter 文档数过多（100 本书 × 1000 章 = 10 万文档） | 🟡 中 | PouchDB 官方建议单库 < 5 万文档；本项目典型用户 < 1000 章 |

---

## 回退方案

```bash
git revert HEAD          # 撤销本次 commit
rm -rf node_modules package-lock.json
npm install              # 移除 pouchdb-browser
npm test                 # 确认 v1 mock 恢复
```

回退时间：~5 分钟

---

## 进度跟踪

| Phase | 状态 | 完成日期 | 验收人 | 备注 |
|---|---|---|---|---|
| 1. 依赖 + DbService | ⏳ Pending | — | — | — |
| 2. BookService 重构 + reader 迁移 | ⏳ Pending | — | — | — |
| 3. UI 适配 | ⏳ Pending | — | — | — |
| 4. 验证（build/test/e2e） | ⏳ Pending | — | — | — |
| 5. 文档更新 | ⏳ Pending | — | — | — |

---

## Remarks

### 已确认事实（2026-09-24）
- 原 vendor 持久化方案：`PouchDB / IndexedDB`（README + 设计文档 + main.ts 注释三处证据）
- `electron/main.ts` 已预留 IndexedDB 单实例锁兼容补丁，无需主进程改造
- 当前 `BookService` 100% 内存存储，重启即失
- `settings.service` 保留 localStorage（全局偏好，不绑定 bookId）
- `reader.service` 阅读进度迁移到 PouchDB（嵌入 Book 文档的 `progress` 字段）

### 关键决策（已与你对齐 2026-09-24）
- ✅ `books.json` / `chapters/*.json` mock 数据保留为 seed
- ✅ 在线导入章节正文存 PouchDB（按你原话"不管是本地还是网页导入都需要保存"）
- ✅ 阅读进度嵌入 Book 文档（你的观点正确 —— 与 bookId 强绑定）

### 暂未覆盖风险
- pouchdb-browser 9 + Angular 18 zone-less 模式下的 signal 兼容性（执行时验证）
- IndexedDB 在 Electron 44 + Chromium 198 下的具体配额行为（执行时验证）

### 关联任务
- `DEPRECATION_CLEANUP_PLAN.md` —— deprecation 清理（Step 2 已完成）
- `ELECTRON_UPGRADE_PLAN.md` —— Electron 大版本升级（Phase 4 部分通过）
- 本任务完成后，`books.json` / `chapters/*.json` 是否保留待 Phase 2 决策
