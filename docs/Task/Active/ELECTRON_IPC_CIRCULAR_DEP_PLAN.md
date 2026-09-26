# 消除 Electron 主进程 IPC 模块循环依赖

**Status**: 📋 待实施（2026-09-27 记录）
**Owner**: 待定
**优先级**: 中 — 当前靠 CommonJS 惰性求值兜底可运行；若未来迁移 ESM 或更换打包方式会爆雷

## 背景

2026-09-27 项目体检发现：`electron/ipc/` 下 4 个模块互相 import 形成循环依赖（代码注释中已自认此隐患）。循环链如下（import 关系）：

```
fetch-handler.ts ── isCfChallenge ──▶ cf-guard.ts
      ▲                                 │
      └─────── isPrivateHost ◀──────────┘

fetch-handler.ts ── cfFetchHtmlHidden ──▶ render-handler.ts
      ▲                                      │
      └────────── isPrivateHost ◀────────────┘

booksource-handler.ts → cf-guard / render-handler（单向，不构成环）
```

根源是两个「放错位置」的共享工具：

1. **`isPrivateHost`**（SSRF 私网判定）定义在 `fetch-handler.ts`，但 `render-handler` / `cf-guard` / `safe-net` 都需要它 → 产生反向 import
2. **`cfFetchHtmlHidden`**（Tier 1 隐藏窗口自动过盾）定义在 `render-handler.ts`，但 `fetch-handler` / `booksource-handler` 需要它 → 产生反向 import

## 改动清单

### 1. 抽取叶子模块（打破所有环的关键）

- 新建 `electron/ipc/net-guard.ts`（或并入 `safe-net.ts`）：接收 `isPrivateHost`，不 import 任何 ipc 兄弟模块
- `fetch-handler` / `render-handler` / `cf-guard` / `safe-net` 全部改为从叶子模块 import

### 2. 梳理依赖方向（目标 DAG）

```
net-guard（叶子）◀── safe-net ◀── fetch-handler ──▶ cf-guard ──▶ render-handler
                                              └────────────▶ render-handler
booksource-handler ──▶ { cf-guard, render-handler, safe-net, booksource-meta }
```

- `isCfChallenge` 留在 `cf-guard`（`fetch-handler` → `cf-guard` 单向即可）
- `cfFetchHtmlHidden` 留在 `render-handler`（`fetch-handler` / `booksource-handler` → `render-handler` 单向即可）
- 完成后 ipc 内部不允许再有任何 import 环

### 3. 防御性验证

- 加 lint 规则防回归：可考虑 `eslint-plugin-import` 的 `no-cycle`，或 `madge --circular electron/` 进 CI（若不想加依赖，至少把 madge 命令记录在本文件）
- `madge --circular electron/` 当前基线：应输出上述 2 个环；修复后应为 0

## 验证

- `madge --circular electron/` → 0 cycles
- `npm run build:electron` → tsc 0 错误
- `npm run electron` 手动冒烟：在线导入一本书（走 fetch-handler → render-handler 降级链路）、CF 站点触发 Tier 1 过盾（走 booksource-handler → render-handler）
- `node scripts/e2e-cf-guard.cjs`（需 DISPLAY）双链路 PASS

## 备注

- 纯模块内搬运，不改任何行为；不涉及渲染端
- 与 2026-09-27 同一轮体检的其余 5 项（README / karma 清理 / 死代码 / scripts 端口）已在当轮修复完毕，本文件是唯一留待后续实施的项
