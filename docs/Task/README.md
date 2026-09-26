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