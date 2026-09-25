# LEGADO 能力迁移到 POMREADER

**状态**: ✅ 已完成 (完成时间: 2026-09-26)
> 对应 fullauto 状态：`.omc/fullauto/legado-migration/`（spec.md + plan.md + qa-blocker.md 已归档保留）

## 任务目标

将 `../legado`（Legado Tauri / Vue 3 / Rust / Boa JS 引擎）中的 4 大能力迁移到 pomreader（Angular 18 + Electron）：

1. **用户书源 JS 脚本系统** — 用户可编辑/启停 `.js` 书源文件，搜索/目录/正文走沙箱执行
2. **书源市场 / 仓库** — 在线仓库一键安装书源，AI 辅助生成
3. **封面下载 + 本地缓存 + 封面生成** — URL → Preload 层 reqwest 下载 → hash 缓存；`data:` URL 生成封面
4. **书源扩展 / 插件系统** — 与书源独立，扩展脚本（自定义解析规则/UI）

> 源仓 `legado` 是 Tauri+Vue+Rust，目标仓 `pomreader` 是 Electron+Angular+TS。
> **Rust 后端不能复用**；需在前端 + Preload 层全部用 TypeScript 重写。

## 问题分析

### 两个项目的现状差异

| 项 | pomreader（目标） | legado（源） |
|---|---|---|
| 技术栈 | Angular 18 standalone + signals + ng-zorro 18 + Electron | Vue 3 + Naive UI + Tauri 2 + Rust + Boa JS |
| 书源 | ✅ 已有 `BookSourceAdapter` 框架（笔趣阁 + 启发式通用）；硬编码选择器 | ✅ JS 书源 + Boa/Rust 沙箱执行；元数据头注释 + 函数式协议 |
| 封面 | ❌ SVG 程序生成/纯色占位 | ✅ URL hash 缓存 + data: URL + Referer 下载 |
| 扩展 | ❌ 无 | ✅ 独立 extension 系统 |
| 市场 | ❌ mock | ✅ useSourceMarket / 仓库协议 |
| 持久化 | localStorage + PouchDB | SQLite + filesystem + drafts |
| HTTP 代理 | preload IPC 走 net.request（绕 CORS） | 主进程 reqwest（绕 CORS） |

### 现有 pomreader 资产可复用

- `src/app/core/book-source/book-source.adapter.ts` — Adapter 接口 + `PageFetcher` 抽象
- `src/app/core/book-source/book-source.registry.ts` — 注册表 + resolve 优先级（专用优先 + 启发式兜底）
- `src/app/core/book-source/page-fetcher.service.ts` — 已通过 preload IPC 实现
- `src/app/core/book-source/adapters/heuristic-parser.ts` — 启发式解析（hS/fS + og:novel）
- `src/app/core/book-source/adapters/base-source.adapter.ts` — 6 站复用基类（DOMParser + 选择器）
- `src/app/core/book-source/book-source.config.ts` — 站点选择器配置
- `src/app/modals/import-online/` — 已有真实导入流程，可扩展
- `src/app/core/services/` — Toast/Book/Settings 已有
- electron/main.ts / preload — 已有 IPC + net.request + render-handler

### legado 设计可借鉴（不直接复用）

- **书源 JS 文件结构**：`// @key value` 头部元数据 + 函数 `search/bookInfo/toc/chapterList/content/chapterContent/explore`
- **元数据解析算法**：`parse_header_meta`（多值字段：description / url / require）
- **HTTP 代理**：reqwest + 多镜像 URL 轮询 + Cookie 持久化
- **封面缓存策略**：URL hash → 文件名（带扩展名） → 本地 `local://` 引用
- **书源健康检测**：search → bookInfo → toc 链路验证能力
- **草稿机制**：AI 生成书源时 `<dataDir>/booksource_drafts/` 隔离保存

## 子任务列表

> **任务粒度**：每个子任务为一个原子提交单元（可独立编译/单测通过）。

### Phase 2-A：基础设施（前置依赖）

- **A1. 书源 JS 元数据解析器** — TypeScript 版 `parseHeaderMeta`，支持全部 `@key`（name/author/url/description/logo/version/required/tags/enabled/minDelayMs 等）
- **A2. 书源沙箱 Worker 框架** — Web Worker + ESM import() 隔离，`legado.http` shim 走 postMessage 到 preload
- **A3. BookSourceRegistry 扩展** — 注册 JS 书源 + 按 `match()` 选择 + 内置专用适配器兼容
- **A4. preload 扩展** — `booksource_http_proxy`（复用 `net.request`）+ `booksource_eval` + `cover_resolve_cache`

### Phase 2-B：核心能力

- **B1. 书源管理页** — 列表 / 编辑 / 启停 / 导入导出 / AI 草稿入口
- **B2. Universal Search 接入书源** — 多书源并行搜索，结果聚合去重
- **B3. ImportOnline 走书源** — 选书源 → 输入 URL/关键词 → 解析目录 → 入库
- **B4. 封面下载 + 缓存** — hash key → `<userData>/covers/` 缓存目录 → `asset://` 显示
- **B5. 封面生成** — `data:` URL 走 cache 写入；提供 SVG/纯色占位 fallback
- **B6. 书源扩展系统** — 独立目录 `<userData>/extensions/`；扩展脚本同样沙箱执行；UI 提供安装入口

### Phase 2-C：高级能力

- **C1. 书源市场 / 仓库** — 内置仓库 URL（GitHub raw / 自建 JSON）；批量安装；版本对比
- **C2. 书源健康检测** — detectCapabilities + search 健康度评分
- **C3. AI 辅助生成书源** — 草稿保存到 `booksource_drafts/`（纯前端 mock 即可，不接真实 LLM）
- **C4. 多镜像 URL 轮询 + Cookie 持久化** — 书源级别 + 全局级

### Phase 2-D：质量

- **D1. 单元测试** — 元数据解析器、Worker shim、BookSourceRegistry 解析 ≥ 90%
- **D2. 集成测试** — Playwright E2E（mock 离线书源 → 解析 → 入库 → 封面显示）
- **D3. 文档** — 书源开发指南（仿 legado `docs/booksource.md`）；用户 README 同步

## 每个子任务的改动内容

| ID | 文件 | 内容 |
|---|---|---|
| A1 | `src/app/core/book-source/js-source/header-parser.ts` | 解析 `// @key` → `BookSourceMeta` |
| A1 | `src/app/core/book-source/js-source/header-parser.spec.ts` | 单测覆盖全部 key |
| A2 | `src/app/core/book-source/js-source/sandbox.worker.ts` | Worker 入口，注入 legado.http shim |
| A2 | `src/app/core/book-source/js-source/sandbox.service.ts` | 主线程侧 spawn + postMessage |
| A3 | `src/app/core/book-source/js-source/js-source.adapter.ts` | `BookSourceAdapter` 实现，包装沙箱 |
| A3 | `src/app/core/book-source/book-source.registry.ts` | 改：初始化注册所有内置适配器 + JS 适配器 |
| A4 | `electron/preload.js` | 暴露 `booksourceHttpProxy / booksourceEval / coverResolveCache` |
| A4 | `electron/main.ts` | 注册 IPC handler，复用 `net.request` |
| B1 | `src/app/pages/book-source/*` | 书源管理页面（列表 / 编辑 / 启停） |
| B1 | `src/app/routes.ts` | 新增 `/book-sources` 路由 |
| B2 | `src/app/pages/universal-search/*` | 接入多书源搜索 |
| B3 | `src/app/modals/import-online/*` | 选书源 → URL/关键词 → 解析 |
| B4 | `src/app/core/services/cover.service.ts` | 封面缓存服务 |
| B4 | `electron/main.ts` | `cover_resolve_cache` 实现 |
| B5 | `src/app/shared/components/cover-img/*` | 封面组件，`local://` / `asset://` / data: / 占位 fallback |
| B6 | `src/app/core/extension/*` | 扩展系统（独立模块） |
| B6 | `electron/main.ts` | 扩展文件 CRUD + eval |
| C1 | `src/app/core/book-source/source-market.service.ts` | 市场/仓库协议 + 解析 |
| C2 | `src/app/core/book-source/source-health.service.ts` | 健康检测 |
| C3 | `src/app/core/book-source/ai-draft.service.ts` | 草稿 mock（纯前端生成 stub） |
| C4 | `src/app/core/book-source/multi-mirror.service.ts` | URL 轮询 + cookie |

## 预期效果和验收标准

### 功能验收（每项必须可演示）

1. ✅ 用户能在 `/book-sources` 页面看到所有已注册书源（含 5 个内置 + 用户导入）
2. ✅ 用户可编辑 .js 书源源码 → 保存 → 启停状态生效
3. ✅ 用户导入 URL（如笔趣阁书页）→ 选书源 → 解析出 10+ 章 → 加入书架
4. ✅ 用户在万能搜索输入关键词 → 跨 3+ 书源并发搜索 → 聚合去重结果
5. ✅ 书架卡片封面从网络 URL 下载 → 缓存到本地 → 二次访问无网络请求
6. ✅ 书源市场提供至少 1 个内置仓库（GitHub raw JSON）→ 一键安装 3+ 书源
7. ✅ 书源健康检测：在书源管理页点"检测" → 显示能力图标（search/bookInfo/toc/content）
8. ✅ 扩展系统：至少 1 个示例扩展（如"去广告规则"）

### 质量验收

- ✅ `npm run build` 通过
- ✅ `npm test` 通过（单测 ≥ 90% 覆盖核心逻辑）
- ✅ `electron-builder --linux` 打包成功
- ✅ 3 reviewer 全 APPROVED

### 性能验收

- ✅ 跨书源搜索 3 源并发 ≤ 30s（超时主动 cancel）
- ✅ 封面首次加载 ≤ 5s（带 loading skeleton）
- ✅ 沙箱执行无主线程阻塞（Worker 隔离）

## 风险评估和缓解措施

| 风险 | 影响 | 缓解 |
|---|---|---|
| Web Worker 沙箱隔离弱于 Boa | 书源 JS 误操作可访问全局 | postMessage 桥接 + 严格白名单（仅 legado.http） |
| `danger_accept_invalid_certs` 导致 HTTPS 站失败 | 封面/章节下载失败 | pomreader 暂保留宽松证书（与原 vendor 一致），正式版收紧 |
| JS 书源与现有 `BookSourceAdapter` 冲突 | 已实现的内置适配器失效 | 注册顺序：JS 书源按 `@url` 域名匹配优先；无匹配时专用适配器接管 |
| 大量书源导致列表渲染卡顿 | 书源管理页白屏 | 流式分批（`booksource_list_streaming` 同款）+ 虚拟滚动 |
| Preload `net.request` 缺 cookie 持久化 | 登录类书源无法访问 | 接入 Electron `session.cookies` API，按书源命名空间 |
| AI 草稿纯前端 mock 不可用 | 用户期望接真实 LLM | 明确写"v1 仅 mock 模板生成"；未来对接 OpenAI 兼容 API |
| electron-builder 打包体积增加 | install 变慢 | 评估每个新依赖；Worker 不需要额外依赖 |
| 扩展系统开放权限被滥用 | 恶意脚本读 localStorage | 扩展 API 白名单 + 用户手动授权 |

## 实施顺序和依赖关系

```
Phase 2-A（基础设施，并行）：
  A1 ─┬─→ A3 ─→ (注册到 registry)
      └─→ A4 (preload IPC)
  A2 ─┴─→ A3 (沙箱注入)

Phase 2-B（核心能力，依赖 A）：
  B1 (书源管理页) → B2 (搜索) → B3 (导入流程)
  B4 (封面缓存) ─┬─→ B5 (封面组件)
                 └─→ B1 (书源管理卡片显示封面)
  B6 (扩展系统，独立分支)

Phase 2-C（高级能力，依赖 B）：
  C1 (市场) ─→ C2 (健康检测)
  C3 (AI 草稿) ─→ B1 (UI 入口)
  C4 (多镜像) ─→ B2/B3 (搜索/导入)

Phase 2-D（质量，并行）：
  D1 (单测，贯穿全程)
  D2 (E2E，最后跑)
  D3 (文档，最后写)
```

## 阶段 0 输出（spec）

- 路径：`.omc/fullauto/legado-migration/spec.md`
- 包含：4 大模块需求（FR-1..FR-4）+ 5 类非功能需求（NFR-1..NFR-5）+ 15 条 Assumptions + 12 条 Decisions + 文件树 + API 契约 + Worker postMessage 协议 + 数据模型 + 验收标准 + 风险 + 实施顺序

## 外部审核意见（Phase 0）

- provider: coding-bridge
- verdict: **APPROVED**
- risks（5 条）：
  1. **高**：`new Function` 在 Web Worker 中执行用户 JS 存在逃逸风险，若未严格冻结原型链或屏蔽 `globalThis`，恶意脚本可通过原型链越权
  2. **高**：`booksourceEval` 语义模糊，必须确保仅向 Worker 转发，绝不在 preload/main 执行
  3. **中**：用户编辑/保存书源后 Worker 按 fileName 缓存的模块未强制刷新会导致旧代码生效
  4. **中**：100+ 书源多源搜索缺少 Worker pool 容量限制与超时熔断
  5. **低**：缺少迁移期间回滚开关，无法快速切回原内置适配器
- hardening（已应用）：
  - FR-1.3.1：书源保存/更新时 postMessage 通知 Worker 清除该 fileName 模块缓存
  - FR-1.3.2：Worker pool 最大并发数 = 6，单书源超时 15s 自动熔断
  - 风险表新增：Worker 沙箱逃逸 → 深度冻结全局对象原型链；迁移回退 → Feature Flag `enableJsSource`
- diff：已应用 spec.md FR-1.3 段 + §9 风险表

## 实施计划

- 路径：`.omc/plans/fullauto-legado-migration-impl.md`
- 任务数：**20 个**（含 T-019 缓存管理 UI + T-020 app.routes 改造 — Round 1 Critic 触发新增）
- 阶段分布：2-A:4 / 2-B:8 / 2-C:4 / 2-D:4
- 单文件 ≤ 200 行
- §0 Spec 偏离声明（D-1..D-9）覆盖 Worker pool / invalidate / ad-remover / NFR-1 性能 / DEBUG flag / updateUrl / 原子写 / 扩展路由 / 缓存 UI
- §6 循环审核策略（v2.2 单文件粒度 + 软上限 + 死循环防护）

## 外部审核意见（Phase 1）

### Critic Round 1（自审）
- verdict: REJECT（3 CRITICAL + 6 MAJOR + 5 Open Q）
- 触发 ADVERSARIAL 模式

### Critic Round 2（自审）
- verdict: **OKAY**
- 14/14 修复确认（mermaid 3 处缺边 + T-006 重构 + §0 偏离声明 + T-003 流式/原子写 + T-019/T-020 新增 + T-002 沙箱硬化 + T-010 ad-remover eval-only）
- 剩余 6 MINOR 瑕疵（§1 计数、T-006 表述脱节、T-013 依赖、T-018 依赖、D-2 端到端、T-019/T-020 编号）— 不阻断

### 外部审核顾问（runReview kind=plan）
- provider: coding-bridge
- verdict: **APPROVED**
- risks（5 条）：
  1. **高** SSRF 防护不完整（10/172.16-31/192.168/DNS rebinding）
  2. **高** 单 Worker 串行队列性能瓶颈（多源搜索 + 批量封面）
  3. **中** 计划文本与依赖声明不一致（M-3/M-4/M-5）
  4. **中** 沙箱逃逸与资源耗尽（缺 CPU 时间片 + 内存配额）
  5. **低** 自动化性能监控缺失（D-4 仅手动）
- hardening diff（已应用）：
  - ✅ §1 任务数 19→20 / 2-B 7→8
  - ✅ FR-1 验收加 bookInfo 端到端
  - ✅ FR-3 SSRF 扩到内网段 + 防 DNS rebinding
  - ⏸ 高风险（沙箱资源配额）— 落入 Phase 2 实施期在 T-002 任务卡补

## 增量需求（2026-09-26 用户）

- **HTTP 代理配置预留**：v1 在 `safeNetRequest` 接 `options.proxy?: { enabled, url?, bypass? }` schema，UI 开关推迟 v1.1
- 已记录到 spec §6 ASSUMPTION-16 + plan §7 DM-13/DM-14/DM-15
- 当前 qa-blocked 状态不动代码；待用户决策（P1 修复 / 重启 fullauto / 直接放行）后再实施
