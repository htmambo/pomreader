# AGENTS.md — pomreader Project Policy

> 必读：本文件由每个 agent 在每个会话启动时读取。规则刚性，不可协商。
> 长篇说明 + 反例 + 决策依据见 `docs/CONVENTIONS.md`。

## 一句话定位

Angular 18 standalone + signals + ng-zorro-antd 18 + PouchDB + Electron 44。
src/ 是 Angular；electron/ 是 Node 主进程；test 用 Vitest；e2e 用 Playwright。

## 硬规则（must）

### 命名（Naming）
- **类后缀 `Component`**。`BookSourceListComponent`、`PageHeaderComponent`。不允许 `BookSourceList`。
- **文件命名 `kebab-case.component.ts`**。`book-source-list.component.ts`，**禁止** `BookSourceList.ts` 或 `book-source-list.ts`（无 `.component.` 段）。
- **selector 前缀 `app-`**。`selector: 'app-book-source-list'`。
- **service 命名 `kebab-case.service.ts`**，**位置** `src/app/core/services/`。**唯一例外**：被 ≤ 1 个组件 import 的 helper 服务可共置 `shared/components/<comp>/<comp>.service.ts`（机器校验：`grep -rlE --include='*.ts' --exclude='*.spec.ts' "from .*<comp>/<comp>.service" src/ | wc -l` ≤ 1）。
- **路由 `kebab-case`**，路径用复数集合语义：`/bookshelf`, `/book-sources`（集合），`/reader/:bookId/:chapterId`（资源）。

### 目录结构（Directory）
- **任何组件都用子目录**：`<concern>/<name>/<name>.component.{ts,html,scss,spec.ts}`。**禁止** `<concern>/<name>.component.ts` 平铺。
  - 例：`pages/bookshelf/bookshelf.component.ts` + 可选 `.html` / `.scss` / `.spec.ts`。
- **`pages/`、`shared/components/`、`modals/`** 三个目录都遵循同样规则。
- **dialog 归位**：
  - **应用级流程**（导入/确认）→ `modals/<name>/`
  - **跨页复用 widget** → `shared/components/<name>-dialog/`
- **服务归位**：见上面"命名"段。

### 模板与样式（Template / Styles）
- **inline 阈值**：组件 .ts ≤ 300 行 → `template:` + `styles:` 内联。
- **拆分阈值**：组件 .ts > 300 行 → 拆 `.component.html`。
- **双拆分阈值**：组件 .ts > 500 行 → 同时拆 `.component.scss`。
- **拆分时必加 `preserveWhitespaces: true`** 到 `@Component` 装饰器（避免 Angular 默认折叠空白改变渲染语义）。
- **禁止** 组件 `.ts` 文件 `wc -l` 行数 > 300 且源码中存在 `^\s*template\s*:\s*` 字面 token（即未使用 `templateUrl:`），必须改为 `templateUrl: './<comp>.component.html'`。机器校验：`test $(wc -l < <f>) -gt 300 && grep -qE '^\s*template\s*:\s*' <f> && exit 1`。

### 变更检测（OnPush）
- **新组件默认 `ChangeDetectionStrategy.OnPush`**。需要时加 `// opt-out: <reason>` 注释。
- **modals/dialog 内容组件**：必须 OnPush，无 opt-out。
- **既有 default-detect 组件**：下次有意义的编辑时顺手加 OnPush。**触发条件**：相对 `git merge-base HEAD origin/main`，该文件 `git diff --numstat <base> -- <file>` 的 `(新增行 + 删除行) ≥ 5` 时必须加 OnPush。机器校验命令：`git diff --numstat $(git merge-base HEAD origin/main 2>/dev/null) -- <f> | awk 'NR==1 && $1+$2>=5 {exit 1}'`（exit 1 = 需加 OnPush；偏保守，纯 import/格式改动可能误触发，人工 review 可豁免并留 `// opt-out` 注释）。
- **详细豁免清单**见 `docs/CONVENTIONS.md §exceptions`。

### 格式（Format）
- **`imports: [...]` 数组格式**：交给 Prettier（`printWidth: 100`）自动决定单/多行。**禁止手工写单行 vs 多行规则**。
- **Prettier 配置**：`.prettierrc` 已纳入仓库；`npm run format` / `npm run format:check` 是唯一的格式化入口。
- **commit 信息**：Conventional Commits (`feat|fix|refactor|style|docs|chore|test|perf|build|ci|revert(scope)?: subject`，scope 可选，跨组件/跨模块变更建议保留 scope 便于按区域检索)。末尾 OMC trailer block (`Constraint:` / `Rejected:` / `Directive:` / `Confidence:` / `Scope-risk:` / `Not-tested:`)。**禁止** `Co-Authored-By:` 或 AI 署名。

## 软规则（should）

- **新功能前先看 `docs/Task/Active/`** 是否有相关计划文档，避免重复劳动。
- **测试**：新 service / 复杂 component 加 ≥1 vitest 单测。
- **e2e**：跨路由 / 复杂流程加 ≥1 Playwright 用例。

## 死代码处置

- 删除前 `rg` 验证 0 引用（含字符串键动态 import、`'./foo.component'` 等）。
- 删除时同 commit 在 `docs/CONVENTIONS.md §exceptions` 留痕（"曾经存在，已删，理由 X"）。

## 文档同步

- 改动 `src/app/<concern>/` 目录结构后，**必须**同步 `README.md §项目结构` 树。
- 改完跑 `rg "^##" docs/CONVENTIONS.md` 确认规则段未失同步。

## 单一新组件放置速查

| 是什么 | 放哪 |
|---|---|
| 路由页面 | `pages/<name>/<name>.component.ts` |
| 跨页复用 widget | `shared/components/<name>/<name>.component.ts` |
| 应用级弹窗（导入/确认） | `modals/<name>/<name>.component.ts` |
| 跨页复用弹窗 | `shared/components/<name>-dialog/<name>-dialog.component.ts` |
| 共享 service | `core/services/<name>.service.ts` |
| 路由 | `pages/<section>/<section>.routes.ts` |

<!-- ESCALATION (per NFR-11 / §1.5): CC-2 同 commit 必须建 docs/CONVENTIONS.md §exceptions 与 §escape-hatch；若未落地，本文件就地声明最少例外清单并改 preserveWhitespaces 规则为"默认 true，例外在本文件 §escape-hatch 列举"。-->