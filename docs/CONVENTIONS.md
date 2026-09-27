# docs/CONVENTIONS.md — pomreader 项目约定（长篇参考）

> 本文是 `AGENTS.md` 的长篇展开版：每条规则附 **Why / Example / Anti-example / Escape hatch**。
> `AGENTS.md` 是 agent 必读精简版；本文供后续深入查阅、CI 校验、PR review 引用。
> 任何新增规则先写本文，再同步 `AGENTS.md` 一句话硬规则。

---

## §0. 一句话定位

Angular 18 standalone + signals + ng-zorro-antd 18 + PouchDB + Electron 44。
`src/` 是 Angular；`electron/` 是 Node 主进程；test 用 Vitest；e2e 用 Playwright。

---

## §1. 命名（Naming）

### §1.1 类后缀 `Component`
**Rule**: 类名必须 `Component` 结尾。

| ✅ Example | ❌ Anti-example |
|---|---|
| `BookSourceListComponent` | `BookSourceList` |
| `PageHeaderComponent` | `PageHeader` |

**Why**: Angular CLI 生成器默认后缀；grep `*.component.ts` 时类名自然映射文件。
**Escape hatch**: 无。

### §1.2 文件命名 `kebab-case.component.ts`
**Rule**: 文件名 `<name>.component.<ext>`，`<name>` 用 kebab-case。

| ✅ | ❌ |
|---|---|
| `book-source-list.component.ts` | `BookSourceList.ts`（无 .component.） |
| `book-source-list.component.html` | `book-source-list.html`（无 .component.） |
| `book-source-list.component.scss` | `book-source-list.css` |

**Why**: Angular CLI 默认；`*.spec.ts` 自动配对；编辑器 tab 排序按类型分组。
**Escape hatch**: 无。

### §1.3 Selector 前缀 `app-`
**Rule**: 所有组件 selector 以 `app-` 开头。

| ✅ | ❌ |
|---|---|
| `selector: 'app-book-source-list'` | `selector: 'book-source-list'` |
| `selector: 'app-page-header'` | `selector: 'pheader'` |

**Why**: 与第三方组件（`nz-*` 等）区分；防止全局命名空间污染。
**Escape hatch**: 无。

### §1.4 Service 命名 + 位置
**Rule**: 服务名 `<name>.service.ts`，默认位置 `src/app/core/services/`。

| 类型 | 位置 |
|---|---|
| 应用级 service（被 ≥ 2 个组件 import） | `src/app/core/services/<name>.service.ts` |
| 组件独享 helper service（被 ≤ 1 个组件 import） | `shared/components/<comp>/<name>.service.ts` |

机器校验（被 ≤ 1 个**组件** import）：
```bash
rg -lE --type ts --glob '!**/*.spec.ts' "from .*<comp>/<name>.service" src/ | wc -l
```
（与 §7.1 一致使用 `rg`，避免 BSD/GNU grep 正则差异。）

| ✅ | ❌ |
|---|---|
| `core/services/book.service.ts`（9 个组件 import） | `shared/components/book-card/book.service.ts`（9 个组件 import，违反共置规则） |
| `shared/components/page-header/page-header.service.ts`（0 组件 import；这种 helper 内部 state 不算 import） | `core/services/page-header.service.ts`（已迁出，按 AC-4） |

**Why**: 减少 `core/services/` 噪音；让组件阅读时本地可发现 helper。
**Escape hatch**: 全局 utility（无 owning 组件）放 `core/utils/`（暂无该目录，按需新建）。

### §1.5 路由 `kebab-case` 复数集合
**Rule**: 路由路径用 kebab-case；表示集合时用复数；单个资源用 `:id`。

| ✅ | ❌ |
|---|---|
| `/bookshelf` | `/BookShelf` |
| `/book-sources`（集合） | `/book-source`（单数） |
| `/reader/:bookId/:chapterId`（资源） | `/reader-book/:id` |

**Why**: REST 风格约定；与 Angular 路由生态一致。
**Escape hatch**: 旧路由可加 redirect 兼容：`{ path: 'book-source', redirectTo: 'book-sources' }`。

---

## §2. 目录结构（Directory）

### §2.1 任何组件都用子目录
**Rule**: `<concern>/<name>/<name>.component.ts`；可选 `.html` / `.scss` / `.spec.ts`。

| ✅ | ❌ |
|---|---|
| `pages/bookshelf/bookshelf.component.ts` | `pages/bookshelf.component.ts`（平铺） |
| `pages/disclaimer/disclaimer.component.ts`（单 .ts 也放在目录里） | `pages/disclaimer.component.ts`（平铺） |
| `shared/components/book-card/book-card.component.ts` | `shared/components/book-card.component.ts` |

**Why**: `*.spec.ts` / `*.html` / `*.scss` 共置；编辑器 tree-view 一致。
**Escape hatch**: 无。

### §2.2 `pages/` / `shared/components/` / `modals/` 同规则
**Rule**: 三个目录都遵循 §2.1。

### §2.3 Dialog 归位
**Rule**:
- 应用级流程（导入 / 确认 / 一次性向导）→ `modals/<name>/`
- 跨页复用 widget（设置 / 编辑 / 跳转）→ `shared/components/<name>-dialog/`

| ✅ | ❌ |
|---|---|
| `modals/import-online/import-online.component.ts` | `modals/change-book-source-dialog/...`（实际是复用 widget，应放 shared） |
| `shared/components/change-book-source-dialog/change-book-source-dialog.component.ts` | `pages/reader/jump-chapter-dialog.component.ts`（按 AC-5 已迁出） |

**Why**: 应用级流程的 modal 通常一次性使用；复用 widget 应全局可访问。
**Escape hatch**: 单页面独享的 dialog 也放 `shared/components/<name>-dialog/`，方便未来复用。

### §2.4 服务位置
见 §1.4。

---

## §3. 模板与样式（Template / Styles）

### §3.1 Inline 阈值（300 行）
**Rule**: 组件 `.ts` 文件 `wc -l` ≤ 300 → `template:` + `styles:` 内联。

### §3.2 拆分阈值（300 / 500 行）
**Rule**:
- `wc -l > 300` → 拆 `.component.html`（`templateUrl`）
- `wc -l > 500` → 同时拆 `.component.scss`（`styleUrls`）

### §3.3 preserveWhitespaces
**Rule**: 拆分时必加 `preserveWhitespaces: true` 到 `@Component`。

**Why**: Angular 默认 `preserveWhitespaces: false` 折叠空白；内联 `template:` 保留空白。语义差会导致 inline-block 间距、`<pre>` 等场景渲染变化。
**Escape hatch**: 在本文 §exceptions 列出允许默认 false 的组件（如纯文本展示、无 inline 空白依赖）。

### §3.4 禁止 inline template 在 > 300 行
**Rule**: `.ts > 300` 且存在 `template:` 字面 token → 违反。

机器校验：
```bash
test $(wc -l < <f>) -gt 300 && grep -qE '^\s*template\s*:\s*' <f> && exit 1
```

---

## §4. 变更检测（OnPush）

### §4.1 新组件默认 OnPush
**Rule**: 新 `@Component` 默认 `ChangeDetectionStrategy.OnPush`。
**Escape hatch**: 加 `// opt-out: <reason>` 注释。

### §4.2 modals/dialog 必须 OnPush
**Rule**: 所有 modal / dialog 内容组件必须 OnPush，无 opt-out。

**Why**: Modal 默认是顶层组件，输入稳定，OnPush 性能优势明显。

### §4.3 既有 default-detect 组件加 OnPush 触发条件
**Rule**: 相对 `git merge-base HEAD origin/main`，`git diff --numstat <base> -- <f>` 的 `(新增行 + 删除行) ≥ 5` 时必须加 OnPush。

机器校验：
```bash
git diff --numstat $(git merge-base HEAD origin/main 2>/dev/null) -- <f> | awk 'NR==1 && $1+$2>=5 {exit 1}'
```

- exit 1 = 需加 OnPush
- 偏保守；纯 import/格式改动可能误触发；人工 review 可豁免并留 `// opt-out` 注释
- merge-base 失败（浅克隆无 `origin/main`）时 `2>/dev/null` 让命令静默退化 working-tree vs index 模式；浅克隆 CI 应手动 `git fetch --unshallow` 或对照 PR diff 确认

**Escape hatch**: 纯重命名 / import 调整 / 注释 / 格式改动不算 meaningful touch（人工判断）。

---

## §5. 格式（Format）

### §5.1 `imports: [...]` 交给 Prettier
**Rule**: 不写手工格式规则。Prettier `printWidth: 100` 自动决定单/多行。

**Why**: Prettier 自动 wrap 与宽度一致；手工规则导致 PR diff 噪音。

### §5.2 Prettier 入口
**Rule**: `npm run format` / `npm run format:check` 是唯一格式化入口。

### §5.3 Conventional Commits
**Rule**: `feat|fix|refactor|style|docs|chore|test|perf|build|ci|revert(scope)?: subject`；scope 可选；跨组件/跨模块变更建议保留 scope 便于按区域检索。

**OMC Trailer block**（commit message 末尾，使用 plain trailer 语法，与 `git interpret-trailers` 兼容）：
```
Constraint: <...>
Rejected: <alt> | <reason>
Directive: <...>
Confidence: <high|medium|low>
Scope-risk: <narrow|medium|wide>
Not-tested: <...>
```

每个 trailer 单独一行，**无** `>` markdown blockquote 前缀。

**Validation** (机器校验): `rg -ne '^Confidence: (high|medium|low)$'` 和 `rg -ne '^Scope-risk: (narrow|medium|wide)$'` 校验枚举值。

**禁止** `Co-Authored-By:` 或 AI 署名。

---

## §6. 软规则（should）

- 新功能前先看 `docs/Task/Active/` 是否有相关计划文档
- 新 service / 复杂 component 加 ≥ 1 vitest 单测
- 跨路由 / 复杂流程加 ≥ 1 Playwright 用例

---

## §7. 死代码处置

### §7.1 删除前 rg 验证
**Rule**: 删除文件前 `rg` 验证 0 引用（含字符串键动态 import、`'./foo.component'` 等）。本规则与 §1.4 共用 `rg`（ripgrep）作为机器校验工具——全文统一使用 `rg`，避免与 BSD/GNU `grep` 正则差异。
```bash
rg "<ComponentName>\|<file-name>\|<selector>" src/ electron/
```

### §7.2 死代码留痕
**Rule**: 删除时同 commit 在 §exceptions 留痕（"曾经存在，已删，理由 X"）。

---

## §8. 文档同步

### §8.1 README §项目结构同步
**Rule**: 改动 `src/app/<concern>/` 目录结构后，必须同步 `README.md §项目结构` 树（按 AC-10）。

### §8.2 CONVENTIONS 自检
**Rule**: 改完跑 `rg "^##" docs/CONVENTIONS.md` 确认规则段未失同步。

---

## §9. 单一新组件放置速查

| 是什么 | 放哪 |
|---|---|
| 路由页面 | `pages/<name>/<name>.component.ts` |
| 跨页复用 widget | `shared/components/<name>/<name>.component.ts` |
| 应用级弹窗（导入/确认） | `modals/<name>/<name>.component.ts` |
| 跨页复用弹窗 | `shared/components/<name>-dialog/<name>-dialog.component.ts` |
| 共享 service | `core/services/<name>.service.ts` |
| 路由 | `pages/<section>/<section>.routes.ts` |

---

## §exceptions (OnPush + preserveWhitespaces 豁免清单)

> 本节列出 §4 / §3.3 中明确允许偏离硬规则的组件 + 理由。
> 新增例外：在 §exceptions 表格加一行，commit 信息含 `exceptions` 段引用。

**Schema**: `| # | Component | Path | OnPush Status | preserveWhitespaces Status | Reason | Audit Ref | Date |`

**Status 取值**: `exempt` (明确豁免) / `monitored` (纳入清单但当前未触发豁免条件，仅留痕)

| # | Component | Path | OnPush | preserveWhitespaces | Reason | Audit Ref | Date |
|---|-----------|------|--------|---------------------|--------|-----------|------|
| 1 | app.component.ts | `src/app/app.component.ts` | exempt | exempt | Root component, 频繁响应路由变化 + 副作用 effect，OnPush 增加调试成本；preserveWhitespaces exempt 因根组件模板含结构性指令空白敏感 | D-7 / NFR-13 | 2026-09-27 |
| 2 | book-source-list.component.ts | `src/app/pages/book-source/` | monitored | monitored | 既有 default-detect，未触发 §4.3 阈值；下次 ≥5 行编辑时升级 | NFR-13 / R-13 | 2026-09-27 |
| 3 | book-source-editor.component.ts | `src/app/pages/book-source/` | monitored | monitored | 同上 | NFR-13 / R-13 | 2026-09-27 |
| 4 | book-source-search.component.ts | `src/app/pages/book-source/` | monitored | monitored | 纯重命名不算 meaningful touch (§4.3) [pending CC-4 rename] | R-13 / NFR-13 | 2026-09-27 |
| 5 | book-source-smart-add.component.ts | `src/app/pages/book-source/` | monitored | monitored | 纯重命名不算 meaningful touch (§4.3) [pending CC-4 rename] | R-13 / NFR-13 | 2026-09-27 |
| 6 | disclaimer.component.ts | `src/app/pages/disclaimer/` | monitored | monitored | 静态展示，56 行 < 300 阈值 | NFR-13 | 2026-09-27 |
| 7 | cache-settings.component.ts | `src/app/pages/settings/` | monitored | monitored | 已用外部 .html/.scss/templateUrl，未触及 §3 阈值 | NFR-13 | 2026-09-27 |
| 8 | search-placeholder.component.ts | `src/app/pages/universal-search/` | monitored | monitored | 14 行空 template，纯占位 | NFR-13 | 2026-09-27 |
| 9 | universal-search.component.ts | `src/app/pages/universal-search/` | monitored | monitored | CC-9 仅加 JSDoc（不算 meaningful touch）；CC-13 可能合并触发拆分但未在 plan 中 | NFR-13 / R-13 | 2026-09-27 |
| 10 | book-card.component.ts | `src/app/shared/components/book-card/` | monitored | monitored | 组件独享，按需触达；目前未触发 | NFR-13 | 2026-09-27 |
| 11 | cover-img.component.ts | `src/app/shared/components/cover-img/` | monitored | monitored | 纯展示 widget，未触发 | NFR-13 | 2026-09-27 |
| 12 | page-header.component.ts | `src/app/shared/components/page-header/` | monitored | monitored | 路由订阅 + page header service signals，复杂 effect | NFR-13 | 2026-09-27 |
| 13 | rules-panel.component.ts | `src/app/shared/components/rules-panel/` | monitored | monitored | 输入驱动的展示组件 | NFR-13 | 2026-09-27 |
| 14 | sidebar.component.ts | `src/app/shared/components/sidebar/` | monitored | monitored | 路由订阅 + 导航逻辑 | NFR-13 | 2026-09-27 |
| 15 | import-local-txt.component.ts | `src/app/modals/import-local-txt/` | monitored | monitored | 既有 import 流程弹窗，未来可能加 OnPush | NFR-13 | 2026-09-27 |

---

## §escape-hatch (preserveWhitespaces false 例外)

> 本节列出 §3.3 中允许 `preserveWhitespaces: false`（即默认折叠空白）的组件。

**Schema**: `| Component | Setting | Reason | Added-by | Approved-by | Date |`

**准入条件** (新增条目必须满足):
1. 组件已在 §exceptions 表中列出
2. 经 code review 确认 Angular 默认 `preserveWhitespaces` 行为导致可复现 bug
3. 获 maintainer 批准（PR review 中至少 1 个 maintainer +/ok）

**与 §exceptions 关系**: escape-hatch 是 §exceptions 中 `preserveWhitespaces` 列为 `exempt` 的子集 — 本表记录具体 `false` 声明。

| Component | Setting | Reason | Added-by | Approved-by | Date |
|-----------|---------|--------|----------|-------------|------|
| _暂无 — CC-2 已落地，NFR-11 escalation 不触发_ | — | — | — | — | — |

---

## §changelog

- 2026-09-27 — 创建本文（CC-2）；引用 11 项 audit findings + spec §9 D1-D24 + NFR-11/12/13 协议