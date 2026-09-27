# npm run dev 启动竞态与 watch 重建导致懒加载失败修复

**Status**: ✅ Completed (completion time: 2026-09-27)
**Created**: 2026-09-27 · 果农

## 问题分析

`npm run dev` 通过 `wait-on electron/www/browser/index.html` 判定构建就绪，
但该文件是**上次构建的残留**，`wait-on` 立即放行 → Electron 以 `file://` 加载旧
index.html（引用旧 hash chunk）→ 新一轮 `ng build --watch` 清空输出目录并写入新
hash chunk → 旧 chunk 被删 → 点击懒加载路由报
`Failed to fetch dynamically imported module`。重启后产物配套故正常。

同类问题：dev 运行中每次 watch 重建都会使已加载页面引用的旧 chunk 失效。

## 变更内容

| # | 文件 | 变更 |
|---|---|---|
| 1 | `package.json` | `dev` 脚本前置 `rm -rf electron/www`，确保 `wait-on` 等到的是本次构建的 index.html |
| 2 | `angular.json` | development 配置加 `"outputHashing": "none"`（入口 bundle 去 hash；懒加载 chunk 因 CLI 限制仍带 hash） |
| 3 | `src/main.ts` | 监听 `unhandledrejection`，检测到 `dynamically imported module` 失败自动刷新一次（10s 时间窗防死循环） |

## 覆盖范围（验收标准）

- ✅ 启动竞态：#1 解决
- ✅ 渲染层（Angular）改动的 watch 重建：#3 兜底，下次点击自动刷新加载新产物，无需重启
- ❌ 不覆盖：`electron/`（主进程 / preload）、`angular.json`、`package.json` 的改动 —— 运行中的
  Electron 进程不会热替换主进程代码，仍需退出重启 `npm run dev`

## 验证

- `npx ng build --configuration development` 构建通过；入口输出为 `main.js` / `polyfills.js`（无 hash）

## External Review Opinion

本次未经过 External Review MCP 评审（coding-bridge / codex MCP 工具在当前会话不可用）。
以本地构建验证 + 根因分析交叉确认。
