# Contributing to pomreader

感谢你考虑为本项目做出贡献！本文档汇总贡献流程与项目约定。

## 阅读顺序（贡献者必读）

1. [`README.md`](README.md) — 项目说明、技术栈、快速启动
2. [`AGENTS.md`](AGENTS.md) — **硬规则**（每会话必读；命名 / 目录 / 模板 / OnPush）
3. [`docs/CONVENTIONS.md`](docs/CONVENTIONS.md) — 长篇参考 + §exceptions 豁免清单
4. 本文档 — 提交流程

## 开发环境

- Node.js 18+ / npm 9+
- 推荐 Linux（项目以 Linux 为主验证平台；macOS / Windows 需自行验证 Electron 打包）

```bash
npm install
npm start                # → http://localhost:4200
npm test                 # Vitest 单测（src/ + electron/ 两侧）
npm run e2e              # Playwright e2e
npm run dev              # Electron 桌面开发（web + watch + 启动）
```

## Commit 规范

### Conventional Commits（强制）

```
<type>(<scope>): <subject>

<body>

Constraint: ...
Rejected:   ...
Directive:  ...
Confidence: high | medium | low
Scope-risk: low | medium | high
Not-tested: ...
```

- **type**：`feat` / `fix` / `refactor` / `test` / `docs` / `perf` / `style` / `chore`
- **scope**：模块名（`services` / `book-source` / `electron` / `reader` / `bookshelf` 等）
- **subject**：中文，祈使语气，≤ 50 字

### 禁用

- ❌ `Co-Authored-By:` 行（含 AI 工具归属）
- ❌ 任何 AI 工具/agent 归属标识
- ❌ 通用 ack 性质的 commit message（"update code", "fix bug"）

### Trailer block（必须）

按 `~/.claude/COMMIT_TEMPLATE.md` 模板，**保留** `Constraint` / `Rejected` / `Directive` / `Confidence` / `Scope-risk` / `Not-tested` 六个标签。即便内容简略也要保留结构。

## PR 流程

### 1. 分支策略

- 主分支：`main`（已合并所有 EVO-1~16 与最近硬化）
- 特性分支：`feat/<scope>-<short-desc>`（如 `feat/book-source-cs-analyzer`）
- 修复分支：`fix/<scope>-<short-desc>`

### 2. 提交流程

```bash
git checkout -b feat/your-feature
# ... 改动 + tests ...
npm test                    # 必须 691+ tests passing
git status                  # 确认无 throwaway scratch
git diff --staged --stat    # review staged
git add -A
git commit -m "..."
git push origin HEAD
gh pr create --base main
```

### 3. PR 描述

- 标题：Conventional Commits 格式（`feat(scope): subject`）
- 摘要：改动动机 + 实现要点（3-5 行）
- 测试：列出新增 / 修改的 spec 文件 + 测试用例数
- 验证：本地 `npm test` + `npm run e2e` 结果截图
- Risk：列出对其他模块的潜在影响

### 4. 审核 SLA

- 小改动（≤ 100 行）：1 个 reviewer，24h 内响应
- 中改动（100-500 行）：1 个 reviewer + 1 个 maintainer，48h 内响应
- 大改动（> 500 行 或 含架构决策）：触发外部审核（`review_code` MCP），最多 5 轮

## 测试要求

| 改动类型 | 单测要求 | e2e 要求 |
|---|---|---|
| `core/logic` 纯函数 | ≥ 90% 行覆盖 | 无需 |
| `core/services` 服务 | ≥ 80% 行覆盖 + forTest stub | 关键路径加 e2e |
| `core/book-source/*` 适配器 | 关键 happy-path + 边界 | 无需 |
| 组件（`pages/*` / `shared/*`） | 公共方法 + OnPush 锁定 | 关键交互加 e2e |
| Electron 主进程 (`electron/*.ts`) | `vitest.config.ts` 已 include | 桌面端加 e2e |

## 代码风格

- TypeScript 严格模式（`strict` + `noImplicitOverride` + `noImplicitReturns` + `strictTemplates`）
- OnPush 100%（每个新组件默认 OnPush；详见 AGENTS.md）
- Prettier 格式化（`npm run format` / `npm run format:check`）
- 文件行数：组件 .ts ≤ 300 行（> 300 拆 .html；> 500 拆 .scss）
- 命名：详见 AGENTS.md §命名

## 文档同步

任何代码改动必须**同步更新**：

- 改动接口 → `docs/CONVENTIONS.md` §exceptions
- 改动路由 → `README.md` §路由表
- 改动脚本 → `README.md` §快速启动
- 改动架构 → `docs/Task/Active/<plan>.md` 子任务状态

## 行为准则

- 尊重他人；拒绝人身攻击、骚扰、歧视性言论
- 接受建设性批评；以"对项目最有利"为出发点
- 优先协作；分歧走 review 流程，不在 PR 评论外争论

## 报告 Bug

GitHub Issues 需包含：

- 复现步骤（具体到 `npm run dev` / `npm start` / `npm run e2e`）
- 期望行为 / 实际行为
- 截图 / 日志 / 错误栈
- 环境（OS / Node / Electron 版本）

## 安全问题

**请勿在 GitHub Issues 公开报告安全问题**。私下联系 maintainer 后等待响应。