# Electron 大版本升级计划（31 → 44.4.5）

**Status**: 🔄 In progress (2026-09-24)
**Scope**: electron `31.0.0` → `44.4.5` + electron-builder `24.13.3` → `26.16.1` 一步直接升级
**Strategy**: 一步直接（基于原 vendor 已用 electron 4x 验证运行的 baseline）

---

## 背景

项目当前 electron `31.7.7`（package.json `^31.0.0`），electron-builder `24.13.3`。

原 vendor「白虎阅读」已使用 electron 4x 并正常运行（用户提供信息），其打包脚本 `pack-pacman.sh` 注释 `#   ./pack-pacman.sh --electron-version 44.4.5` 明确锁定了 electron `44.4.5` —— 这就是本项目要精确对齐的目标版本。

本次目标：升级到 electron `44.4.5`（精确对齐原 vendor）+ 配套 electron-builder `26.16.1`。

---

## 现状摸底（已完成 2026-09-24）

### 版本与 Node 要求矩阵

| Major | 最新版 | Node 要求 | Chromium | 备注 |
|---|---|---|---|---|
| 31 (当前) | 31.7.7 | >= 12.20.55 | 128 | Node 20 |
| 32 | 32.3.3 | >= 12.20.55 | 132 | Node 20 |
| 33 | 33.4.11 | >= 12.20.55 | 138 | Node 22 |
| 34-39 | 38.8.6 | >= 12.20.55 | 142-162 | Node 22 |
| 40+ | 44.4.5 | >= 22.12.0 | 166-198 | **Node 22** 跳跃 |

**本机 Node**: v24.15.0（满足 electron 40+ 要求）

### 项目 electron API 使用清单

| 文件 | API | 风险评估 |
|---|---|---|
| `electron/main.ts` | `app.requestSingleInstanceLock`, `app.setDesktopName`, `app.on('second-instance')`, `app.on('window-all-closed')`, `app.on('activate')`, `app.whenReady`, `BrowserWindow`, `BrowserWindow.getAllWindows`, `mainWindow.loadURL/loadFile`, `webContents.openDevTools`, `app.on('web-contents-created')`, `setWindowOpenHandler`, `webviewTag: true` | 🟢 全部是 stable API，13 major 跨度不破坏 |
| `electron/preload.ts` | `contextBridge.exposeInMainWorld`, `ipcRenderer.invoke` | 🟢 基础 API，跨 13 major 兼容 |
| `electron/ipc/fetch-handler.ts` | `IpcMain`, `net.request`, `URL`, `ipcMain.handle` | 🟢 稳定 API |
| `electron/ipc/external-handler.ts` | `IpcMain`, `shell.openExternal` | 🟢 稳定 API |

### electron-builder 兼容性关键点

| 项 | 当前 | 升级到 | 风险 |
|---|---|---|---|
| `linux.target` | `["tar.gz", "pacman"]` | 不变 | 🟢 仅 Linux 打包 |
| `win.target` | `nsis` | electron 44 移除 Windows ia32 | 🟡 不打 Windows 包则无影响；本项目 `dist:linux` 不打 win |
| `arch` | 未设置（默认当前架构） | electron-builder v27 起 `arch: "all"` 不含 ia32 | 🟢 项目未用 arch: all |
| `app-builder-lib` | 24.13.3 | 26.16.1 | 🟡 主版本跳跃，需验证打包脚本 |

### electron 44+ 已知 breaking changes 对本项目影响

| Breaking change | 本项目影响 |
|---|---|
| 移除 Windows ia32 / Linux armv7l | 🟢 项目不打这些 target |
| `arch: "all"` 不含 ia32 | 🟢 项目未用 `arch: all` |
| `setWindowOpenHandler` API 强化 | 🟡 主进程已有完整实现，需验证仍生效 |
| Chromium 198 默认隐私/cookie 行为 | 🟡 webview 内站点可能受影响，需 dev 验证 |

---

## 升级策略

**一步直接升级**（用户已确认）：
- 一次 commit 完成 `package.json` 修改 + `npm install`
- 单次 build + test + dev + dist:linux 完整验证链
- 失败回退：一个 `git revert HEAD` 即可

**不采用渐进式** 的原因：原 vendor 已用 electron 4x 验证过同 codebase 模式；Angular 18 + ng-zorro 18 + electron 44 的组合风险点都是已知 stable API 行为，无重大探索成本。

---

## 具体改动清单

### 主改动

```diff
// package.json devDependencies
-    "electron": "^31.0.0",
-    "electron-builder": "^24.13.3",
+    "electron": "^44.4.5",
+    "electron-builder": "^26.16.1",
```

### 同步可能需要的微调

| 可能需要的改动 | 触发条件 | 预案 |
|---|---|---|
| `tsconfig.electron.json` target/module | electron-builder 26 可能需要更新 TS 配置 | 升级后跑 `npm run build:electron`，若有报错再调 |
| `electron/main.ts` 的 `app.on('web-contents-created')` 行为 | Chromium 198 默认拦截策略变化 | dev 测试 webview 链接打开 |
| Angular `angular.json` builder 配置 | 无（angular.json 不涉及 electron） | — |
| `dist:linux` 打包脚本 | electron-builder 26 输出路径可能变化 | 验证 `release/` 目录产物 |

**所有微调以"先跑一遍验证、报错再改"为原则**，避免过度预测。

---

## 验收清单

每项必须全部通过：

### 1. 静态检查
- [ ] `npm run build` —— Angular 构建通过（已包含 lint）
- [ ] `npm run build:electron` —— electron 主进程 tsc 编译通过
- [ ] `npm test` —— vitest 36/36 全绿

### 2. 运行时检查（dev 模式）
- [ ] `npm run dev` 启动无报错
- [ ] electron 主窗口能加载 Angular 应用
- [ ] 万能搜索 → webview 加载百度能正常打开/前进/后退/刷新
- [ ] 点击 webview 内链接 → 主进程 `setWindowOpenHandler` 拦截生效（在当前 webview 跳转，不新开窗口）
- [ ] 导入在线 modal → 章节列表渲染正常（用 quanben.io URL 验证）
- [ ] IPC：万能搜索编码切换（auto/utf-8/gbk）能正常生效

### 3. 打包检查
- [ ] `npm run dist:linux` 成功生成 tar.gz 和 pacman 包
- [ ] 包大小相比升级前变化合理（±20% 内属正常）
- [ ] 包内 electron 二进制版本是 44.4.5

### 4. deprecation 检查
- [ ] 升级后 `npm install` 输出无新增 deprecation 警告（npm 11 已默认隐藏，但通过 `npm explain` 抽查关键包）

---

## 风险评估

| 风险 | 等级 | 缓解 |
|---|---|---|
| electron-builder 26 与 electron 44 实际打包失败 | 🟡 中 | dist:linux 立即验证；失败回退到 26.0.x 或继续 25.x |
| Chromium 198 默认行为影响 webview | 🟡 中 | dev 模式实测万能搜索和导入在线 |
| Node 22+ 内部 API 行为差异（fs、net）影响 IPC handlers | 🟢 低 | IPC handler 用法保守（标准 fs/url/net） |
| 第三方书站（启发式解析目标）在 Chromium 198 下行为变化 | 🟢 低 | 启发式算法不依赖浏览器行为 |
| 项目 webpack 编译产物在 electron 44 + Chromium 198 下兼容 | 🟡 中 | `npm run build` 通过 + 实际运行验证 |

**总体风险等级**: 🟡 **中等** —— 一步直接升级 vs 渐进式升 13 major 的最大风险。

---

## 实施顺序

### Phase 1: 改动 package.json + 安装
1. 改 `package.json` 两个版本号
2. `npm install` —— 可能需要 `rm package-lock.json` 强制重新解析
3. 确认 `npm ls electron electron-builder` 显示新版本

### Phase 2: 静态验证
4. `npm run build` —— Angular 构建
5. `npm run build:electron` —— electron 主进程 tsc
6. `npm test` —— vitest

### Phase 3: 用户运行时验收（关键）
7. `npm run dev` 启动 → 用户手动测试 webview、IPC、导入在线 modal
8. **用户报告测试结果**
9. 若失败 → 排查报错 → 修复（commit）→ 回到 Phase 3
10. 若通过 → 进入 Phase 4

### Phase 4: 打包验证
11. `npm run dist:linux` 生成 tar.gz + pacman
12. 检查产物
13. 最终 git commit

---

## 回退方案

```bash
git revert HEAD         # 撤销升级 commit
rm -rf node_modules package-lock.json
npm install             # 恢复 electron 31
```

回退时间成本：~5 分钟（依赖重新安装）

---

## 进度跟踪

| Phase | 状态 | 完成日期 | 验收人 | 备注 |
|---|---|---|---|---|
| 1. 改 package.json + install | ✅ Completed | 2026-09-24 | 自动 | electron 44.4.5 + electron-builder 26.16.1 已安装 |
| 2. 静态验证 (build/test) | ✅ Completed | 2026-09-24 | 自动 | Angular build / tsc / vitest 36/36 全通过 |
| 3. 用户运行时验收 | ✅ Completed | 2026-09-24 | 用户 | 功能基本正常 |
| 4. 打包验证 (dist:linux) | 🟡 Partial | 2026-09-24 | 自动 | tar.gz ✅ 133MB, pacman ❌ 缺 libcrypt.so.1 (Manjaro 系统问题) |

---

## Remarks

### 已确认事实（2026-09-24）
- electron latest stable: `44.4.5`（与原 vendor `pack-pacman.sh` 注释 `--electron-version 44.4.5` 精确对齐）
- electron-builder v26 latest: `26.16.1`，v27 是 beta
- electron 44 Node 要求: `>= 22.12.0`（本机 Node v24.15.0 满足）
- 项目 electron API 使用均为 stable 基础 API
- electron 44+ breaking changes（Windows ia32、Linux armv7l）本项目不受影响
- 原 vendor「白虎阅读」已用 electron `44.4.5` 验证运行（用户提供打包脚本注释确认）

### 已知未覆盖风险
- Chromium 198 默认行为变化对 webview 内嵌第三方站点的实际影响（只能通过 dev 模式实测确认）
- electron-builder 26 打包脚本可能的输出路径/格式变化

### 关联任务
- `DEPRECATION_CLEANUP_PLAN.md` —— deprecation 清理（Step 2 已完成）
- 本次升级可能顺带消除 Step 3/4（electron 31→44 干掉 boolean、某些 glob@10 间接依赖）的 deprecated 警告

### 原 vendor `pack-pacman.sh` 脚本（独立后续任务）
- 用户在原 vendor 仓库发现打包脚本注释：`./pack-pacman.sh --electron-version 44.4.5`
- 当前本项目用 `electron-builder --linux`（npm script `dist:linux`）打包
- **本次升级不引入 pack-pacman.sh 移植** —— 保持现有 electron-builder 路径，避免范围扩大
- 如未来需要对齐原 vendor 的打包细节（自定义参数、输出路径、签名等），可作为独立任务
