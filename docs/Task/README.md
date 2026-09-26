# Task Index

> 本仓库为 `pomreader-ui-clone` 子项目的独立仓库（2026-09-25 从父仓 `pomreader` 拆分）。
> 父仓（白虎阅读 macOS DMG Linux 重打包）的任务历史已留在原仓 `docs/Task/`。

## Active Tasks
- _(无)_

## Completed Tasks (Archive)

### 历史归档（拆分前父仓记录）
- ✅ [pomreader-ui-clone Angular 仿写 + 行为级重写](Archive/2026-09/POMREADER_UI_CLONE_PLAN.md) — Completed 2026-09-24
  - 子项目 `pomreader-ui-clone/` 入父仓；Angular 18 standalone + signals + ng-zorro 18
  - 4 主路由 + 2 弹窗（导入在线 + 导入本地 TXT）+ 1 抽屉（阅读器目录）+ 阅读设置（reader 内联）
  - 3 个行为级重写算法（chapter-split ≥ 90% 测试 / theme-resolver / online-source-resolver mock）
  - 15 本古典名篇 mock + 15 章 stub（2 本水浒/三国完整片段）
  - 30/30 单测全绿；prod bundle 611 kB（远低于 1.5 MB 预算）
  - 3 reviewer 全 APPROVED（architect Round 1 / security Round 1 / code-reviewer Round 2 — Round 1 修复 2 HIGH 后）
  - 父设计稿：[2026-09-24-POMREADER_UI_CLONE_DESIGN.md v1.1](../Architecture/2026-09-24-POMREADER_UI_CLONE_DESIGN.md) Round 1 APPROVED

### 2026-09（独立仓库阶段）
- ✅ [书源搜索桥接 JS 书源适配器 + 暗色 alert 样式](Archive/2026-09/BOOK_SOURCE_SEARCH_BRIDGE_PLAN.md) — Completed 2026-09-26
  - 真正根因：`registry.loadAllJsAdapters()` 从未被调用（app.config.ts APP_INITIALIZER 缺失），用户装的 JS 书源从未进 registry → 鸭子类型过滤全部排除 → 聚合搜索永远空
  - 修复 1：APP_INITIALIZER deps 加 SandboxService（绕开 NG0203 — async 函数 await 后脱离 Angular 注入上下文）
  - 修复 2：JsSourceAdapter.search() 暴露鸭子类型入口（委托沙箱 legado search 函数）
  - 修复 3：importBook 用 modal 替代不存在的 /import-online 路由（避免跳默认路由）
  - 字段规范化：RawSearchItem / ResolvedBook 加 kind? 字段（Book.kind 对应）；pickString helper 统一 fallback 链（legado 标准在前）
  - JsSourceAdapter.ensureLoaded() 去掉实例级缓存：书源脚本修改后无需重启 dev server 立即生效
  - 编辑书源页顶部加「测试按钮行为说明」alert（避免误以为「测试正文」能验证书源 JS chapterContent）
  - 18 条新增单测（203/203 全绿）；tsc 0 错误；外审 Round 1 NEEDS_CHANGES → Round 2 APPROVED
- ✅ [Book.bookSourceUuid 锚定具体书源 + 万能搜索域名匹配](Archive/2026-09/BOOK_SOURCE_UUID_ANCHOR_PLAN.md) — Completed 2026-09-26
  - Book / BookDoc 加 bookSourceUuid?: string（legado meta.uuid 锚定具体书源，方便后续重抓章节用书源特定方法）
  - importByUrl 返回值结构统一：JsSourceAdapter 来源 → meta.uuid；万能搜索 fallback → UNIVERSAL_BOOK_SOURCE_UUID；sourceName 显式但 match 失败 / 源不存在 → 抛 FetchError（不静默降级）
  - Registry 加 getByName（独立 API）/ findJsSourceAdapterByUrl（域名匹配）/ getByUuid 移除 name 兜底（保护 UNIVERSAL 黑名单 invariant）
  - universal-search.openImport 前域名匹配：URL 命中已启用书源 → 注入 source 到 ImportOnline → 自动锚定 meta.uuid
  - 抽 UNIVERSAL_BOOK_SOURCE_UUID 常量 + extractMetaUuid / hasMetaUuid 类型守卫（消除 4 处鸭子类型断言）
  - 12 条新增单测（219/219 全绿）；tsc 0 错误；外审 Round 1 NEEDS_CHANGES → Round 2 APPROVED（采纳 2 条高优先级建议：统一结构 + 改用 getByName）
- ✅ [legado → pomreader 能力迁移（书源 JS / 市场 / 封面 / 扩展 / 代理）](Archive/2026-09/LEGADO_MIGRATION_PLAN.md) — Completed 2026-09-26
  - 4 大模块 20 个任务全部完成；140/140 单测 + 0 TS 错误 + ng build 成功
  - Phase 0 spec + Phase 1 plan（Critic Round 2 OKAY + 外部 APPROVED）
  - Phase 2-A review 5 → 临时放宽 10 → Round 8 APPROVED（沙箱硬化 + SSRF 重定向 + 代理 session.setProxy）
  - Phase 4 综合 APPROVED
  - 增量需求：HTTP 代理配置 schema + session.setProxy（用户 2026-09-26）
- ✅ [阅读页 Esc 栈式关闭](Archive/2026-09/READER_ESC_HANDLER_PLAN.md) — Completed 2026-09-25
  - 阅读页 `@HostListener('document:keydown')` 增加 `Escape` 分支
  - 4 处 modal 加 `nzKeyboard: false` 由组件统一接管 Esc
  - `modalOpen` 由 `signal<boolean>` 升级为派生自 `NzModalService.openModals.length`（避免多 modal 堆栈双源真相）
  - Esc 优先级：modal 打开时优先关闭顶层 modal（无视输入态）；无 modal 时输入态 Esc 不响应
- ✅ [目录点击延迟 + 自动滚到当前章节](Archive/2026-09/CATALOG_SCROLL_PLAN.md) — Completed 2026-09-25
  - 在线书 N 章大时 catalog-list 每章 `<span nz-icon>` 组件实例化导致首渲卡顿 → 改用 CSS 伪元素（mask-image + SVG data URI）+ `var(--r-muted)` 主题变量
  - DOM 移动：panel-wrap 移出 `.left-bar-list` 消除 painting layer 调度延迟
  - `ngOnInit` 优先 `getChaptersSync` 同步读缓存 + 浅拷贝 + 销毁守卫
  - 目录打开时 `effect` 监听 + `setTimeout(0)` 等 DOM 渲染 + `chapters()/chapterIndex()` 直接算 scrollTop
- ✅ [智能添加支持 CSS 选择器规则](Archive/2026-09/SMART_ADD_CSS_SELECTOR_PLAN.md) — Completed 2026-09-26
  - 6 个规则字段全链路 CSS/正则双模式：`smart-rules.ts` 启发式判定（`css:` 前缀 + REGEX_HINT 兜底）→ UI hint → codegen 注入 `isCssRule`/`ruleSelector` → 沙箱 `legado.query` 主线程代理（detached DOMParser）
  - CSS 模式按 URL 去重（非空 name 优先），同一书籍的 img/书名/按钮三同 href 收敛为 1 条
  - 用户样例 `dl.list dd a` 在渲染器与沙箱 codegen 两条路径均命中 `{name:'庆余年', url:'.../book/5/index.html'}`
  - Feature Flag: `localStorage['pom.cssRules']==='0'` 全量回退正则（运行时止血开关）；5MB 解析上限；`MAX_EXTRACT_LINKS = 500` 魔数提常量
  - 17 文件 / 175 用例全绿（含 8 条新增），双端 tsc 0；评审 Round 3 APPROVED