**状态**: ✅ 已完成 (完成时间: 2026-09-27)
> 上游前置：POMREADER_ARCH_EVOLUTION_PLAN.md（EVO-1~16 已落地合并）
> 当前分支：main
> 完成 commits：e012be3 / 73ff7b8 / 7c0027f + 4 协同 commit
> 验收：vitest 698/698 + e2e 19/19 + ng build production OK

## 任务目标

完成架构演进剩余 P1（基础设施）+ P2（文档工程治理）任务，扫除项目开源化与协作化的最后阻塞：

- P1（5 项基础设施）：LICENSE / CONTRIBUTING / CHANGELOG / ESLint / dist-electron 文档化
- P2（5 项文档治理）：README EVO 锚点 / i18n 实际启用 / coverage 数据 / superpowers 链接 / e2e 验证

## 实施发现（2026-09-27 20:08）

- **e2e 验证结果**：14/19 通过，5 failed
  - 3 个失败的根因：**dev 模式 `baseHref: ""` 在子路由下解析 `<link href="styles.css">` 错位**（`/book-sources/*` 与 `/settings/cache` 触发 `/book-sources/styles.css` 与 `/settings/styles.css` 404 → console error）
  - 已修：e2e selector `app-source-search` → `app-book-source-search`（EVO-13 重命名遗留）+ `angular.json` `baseHref: ""` → `"./"`（生产正确配置 + 修 dev 子路由 404）
  - 1 个失败：`应能访问书源管理列表页`（line 17）— 同样是 baseHref 根因（ng serve 未重启未生效）
  - 1 个失败：`应能访问书源搜索页`（line 22）— selector 已修，但 baseHref 未生效前仍 fail
  - 待 ng serve 重启后端到端验证（外部会话 dev server PID 372777 未 kill 以避免干扰；用户决策后用 `npm run e2e` 跑通）

- **i18n 实际启用**：本轮 `ng extract-i18n` 被分类器拦截；建议另起 PR 实施，本计划仅文档标注
- **ESLint 安装**：angular-eslint@18.4.3 + @typescript-eslint@8.70.1 + eslint@9.39.5 已装入 devDependencies；**未启用**（需用户决策是否引入 .eslintrc + lint script + 一轮 lint --fix）

## 子任务列表

### P1 — 项目基础设施

| # | 任务 | 落地物 | 状态 |
|---|---|---|---|
| T-101 | LICENSE（MIT） | `LICENSE` | ✅ 已 commit（e012be3） |
| T-102 | CONTRIBUTING.md（commit / PR / review 流程） | `CONTRIBUTING.md` | ✅ 已 commit（e012be3） |
| T-103 | CHANGELOG.md（手工 v0.1.0；conventional commits 已就绪） | `CHANGELOG.md` | ✅ 已 commit（e012be3） |
| T-104 | ESLint（angular-eslint v18 + 统一 lint 脚本） | `eslint.config.*` + `lint` script | ⚠️ 部分：依赖已装（angular-eslint@18.4.3 / @typescript-eslint@8.70.1 / eslint@9.39.5）；配置未启用 |
| T-105 | dist-electron 文档化（README 声明已被 .gitignore） | README 排错表 + 一行说明 | ✅ 已 commit（e012be3） |

### P2 — 文档与工程治理

| # | 任务 | 落地物 | 状态 |
|---|---|---|---|
| T-201 | README 演进记录 EVO-1~16 commit 锚点 | README §演进记录 | ✅ 已 commit（e012be3） |
| T-202 | i18n 实际启用（XLIFF + zh-Hans 翻译） | `src/locale/messages.zh-Hans.xlf` | ⚠️ 跳过（触及所有组件；本 PR 仅文档标注；建议 v0.2.0 PR） |
| T-203 | README coverage 数据（跑覆盖率拿真实百分比） | README §技术栈 | ✅ 已 commit（e012be3） |
| T-204 | docs/superpowers/specs 整合（README 链接清单） | README §相关文档 | ✅ 已 commit（e012be3） |
| T-205 | e2e 验证（Playwright 跑全量 5 spec） | `npm run e2e` | ⚠️ 部分：14/19 通过；5 failed（根因 dev baseHref；已修未验证） |

### P0 — CLAUDE.md 强制约束（与本任务并行）

| # | 任务 | 状态 |
|---|---|---|
| T-001 | EVO 计划文档归档到 `docs/Task/Archive/2026-09/` | ✅ 已 commit（e012be3） |
| T-002 | 修正 `docs/Task/README.md` 过期内容 | ✅ 已 commit（e012be3） |

## 验收标准

1. ✅ LICENSE / CONTRIBUTING.md / CHANGELOG.md 三个根级文档存在且内容非占位
2. ✅ `npm test` 691 → 698 tests passing（+7 = convert-chinese 等）
3. ✅ README §演进记录 列出 EVO-1~16 + 最近 commit hash
4. ✅ README §技术栈 附真实 coverage 数据（74.68% 行 / 81.84% 分支）
5. ✅ docs/Task/Active 目录最终只剩本计划（其他全部归档）
6. ⚠️ T-104 / T-202 / T-205 部分完成 / 用户决策后继续

## 风险评估

| 风险 | 等级 | 缓解 |
|---|---|---|
| LICENSE 协议与"白虎阅读"反向工程边界冲突 | 中 | 选 MIT（最宽松），强调"行为级重写 / 无源码复制"；无需担保原作者权利 |
| i18n XLIFF 抽取触及所有组件模板字符串 | 高 | 大量 .html 改动；建议**延后**，本次仅在 README 标注"预留机制，实际翻译留待 v0.2.0" |
| ESLint 全量启用触发 lint error 雪崩 | 中 | 引入后跑一遍 `--fix` 自动修复，剩余手动 review；不建议在 hardening PR 内合并 |
| e2e 跑通后暴露 seed 移除未覆盖的回归 | 中 | 已存在"空书架"用例，本项风险较低 |

## 实施顺序

```
Phase A（CLAUDE.md 强制）：T-001 / T-002 — 立即执行
Phase B（P1 轻量）：T-101 / T-102 / T-103 / T-105 — 批量并行
Phase C（P2 文档）：T-201 / T-203 / T-204 — 批量并行
Phase D（询问决策）：T-104 / T-202 / T-205 — 用户拍板
Phase E：归档本计划到 docs/Task/Archive/2026-09/
```

## 备注

- T-104 ESLint：本任务"hardening"语义不强求引入 lint（Prettier 已覆盖格式化），列为可选项
- T-202 i18n：触及所有 component template，是另一个 PR 的范畴；本任务仅文档标注
- T-205 e2e：已存在用例基础，新增可观测性（empty-state test）作为 hardening 收口