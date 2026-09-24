# 弃用依赖清理计划

**Status**: 🔄 In progress (2026-09-24)
**Scope**: 消除 `npm install` 输出的 15 条 deprecated 警告，分阶段执行、每阶段用户验收

---

## 背景

`npm install` 当前输出 15 条 `npm warn deprecated`，来源是 Angular 18 + electron-builder + jsdom + karma 的传递依赖生态。
其中 `glob@7/10` 与 `tar@6` 被 npm 明确标注存在"widely publicized security vulnerabilities"，且 `glob` 在 `ng serve` 长驻进程中加载，需要处理。

工作区干净（`git status` 干净），Node v24.15.0 满足所有目标版本要求。

---

## 执行策略

每一步独立 commit、独立验收。失败回退直接 `git revert` 或 `git checkout -- package.json package-lock.json`。

| 步骤 | 改动 | 预期消除警告 | 验收命令 |
|---|---|---|---|
| 1 | ~~karma@6→7~~ | **跳过** —— karma 无 7.x 版本，`angular.json:87` 的 `test` target 用 `@angular-devkit/build-angular:karma` 锁死 karma@6 | — |
| 2 | ✅ jsdom@25→26（已完成 2026-09-24） | `whatwg-encoding@3` | ✅ `npm run build` 通过 + `npm test` 36/36 通过 |
| 3 | electron@31→32 | `boolean@3` | 同上 + `npm run build:electron` |
| 4 | `overrides` 强锁 `glob@11` / `tar@7` / `uuid@11` | 多个 `glob@10.5.0` + `tar@6.2.1` + `uuid@8.3.2` | 同上 + `npm run build:electron` |
| — | （遗留：`critters@0.0.24` + 残余 `glob@10` + `rimraf@3` / `glob@7` / `inflight@1` 因 karma 锁死） | 绑死 Angular 18，等 Angular 19 升级任务单独处理 | — |

> 每步完成后**暂停**，等用户确认 `npm run build` 与 `npm test` 通过，再进下一步。

---

## 步骤 1：karma@6 → karma@7

**目标版本**：
- `karma`: `^6.4.0` → `^7.0.0`
- 配套插件保持现状（karma@7 与 karma-jasmine@5 / karma-coverage@2 / karma-chrome-launcher@3 / karma-jasmine-html-reporter@2 / jasmine-core@5 全部兼容）

**前置调研结论**：
- 项目无 `karma.conf.*` 文件，karma 是纯残留依赖（测试已统一迁移到 vitest）
- Node v24 ≥ karma@7 要求的 v18
- `npm ls karma` 确认 `karma@6.4.4` 仅被 `karma-jasmine-html-reporter@2.1.0` 间接引用一次

**改动文件**：
- `package.json` —— 调整 `karma` 版本号
- `package-lock.json` —— 由 `npm install` 自动重生成

**风险评估**：🟢 低
- 项目实际不跑 karma（`npm test` 用 vitest）
- 即使兼容性问题也只影响一条未被使用的命令

**回退方案**：
```bash
git checkout -- package.json package-lock.json
npm install
```

---

## 步骤 2：jsdom@25 → jsdom@26

**目标版本**：`jsdom`: `^25.0.1` → `^26.0.0`

**前置调研结论**：
- `npm ls whatwg-encoding` 显示来源：`jsdom@25 → html-encoding-sniffer@4`
- jsdom@26 已切换到内置解析（详见 npm release notes）
- 项目用 vitest 的 `environment: 'jsdom'` 跑组件测试

**改动文件**：
- `package.json`
- `package-lock.json`

**风险评估**：🟢 低
- jsdom 26 是 minor API 升级，向后兼容
- vitest@2.1.9 已声明支持 jsdom 26+

**回退方案**：同上

---

## 步骤 3：electron@31 → electron@32

**目标版本**：`electron`: `^31.0.0` → `^32.0.0`

**前置调研结论**：
- `npm ls boolean` 显示来源：`electron@31.7.7 → @electron/get@2 → global-agent@3 → boolean@3`
- electron@32 起 `@electron/get` 升级到 3.x，剔除 `global-agent`
- electron 32 仍使用 Chromium 128 + Node 20.18，API 兼容 31
- **本项目 electron 主进程代码纯 Electron API 调用（app / BrowserWindow / ipcMain 等），未触碰 Node 内部 API**

**改动文件**：
- `package.json`
- `package-lock.json`

**风险评估**：🟡 中低
- electron 32 主版本切换，需验证 `npm run build:electron` 通过
- `dist:linux` 打包脚本涉及 electron-builder（已验证 v24.13.3 与 electron 32 兼容）

**回退方案**：
```bash
git revert HEAD
# 或
git checkout HEAD~1 -- package.json package-lock.json
npm install
```

---

## 步骤 4：overrides 强锁 glob / tar / uuid

**新增字段**：
```json
"overrides": {
  "glob": "^11.0.0",
  "tar": "^7.4.0",
  "uuid": "^11.0.0"
}
```

**预期消除警告**：
- `glob@10.5.0` × 5（来自 @angular/cli → pacote/@npmcli 系列、@vitest/coverage-v8 → test-exclude、electron-builder → read-config-file）
- `tar@6.2.1` × 2（来自 @angular/cli → pacote、electron-builder → app-builder-lib）
- `uuid@8.3.2` × 1（来自 @angular-devkit/build-angular → webpack-dev-server → sockjs）

**残留警告**（绑死 Angular 18，无法通过 overrides 强解）：
- `critters@0.0.24` × 1（来自 @angular-devkit/build-angular → @angular/build）
- 可能残存 1-2 个 `glob@10.5.0`（如 Angular CLI 内部硬依赖 glob@10）

**风险评估**：🟡 中
- `glob@11` 要求 Node ≥ 20（本机 v24 ✅）
- `tar@7` 要求 Node ≥ 18（本机 v24 ✅）
- `uuid@11` CommonJS 兼容（本项目是 Angular + ESM/TS，CJS 路径走 webpack 打包，应无问题）
- @angular/build 内部对 webpack-dev-server 调用 uuid 的方式是否兼容 uuid@11 —— **需实际跑 `ng build` 验证**

**回退方案**：
```bash
git checkout -- package.json package-lock.json
npm install
```

---

## 验收清单

每步完成后用户需确认：
- [ ] `npm install 2>&1 | grep -c deprecated` —— 数字减少（脚本统计 deprecated 行数）
- [ ] `npm run build` —— Angular 构建通过
- [ ] `npm test` —— vitest 测试通过
- [ ] 步骤 3 额外：`npm run build:electron` —— tsc 编译 electron 主进程通过
- [ ] 步骤 4 额外：`npm run dev`（可选）—— 启动 ng serve + electron 联调通过

---

## 进度记录

| 步骤 | 状态 | 完成日期 | 验收人 | 备注 |
|---|---|---|---|---|
| 1 (karma) | ⏭️ Skipped | — | — | karma 无 7.x，angular.json builder 锁死 karma@6 |
| 2 (jsdom) | ✅ Completed | 2026-09-24 | 用户 + build/test | npm 11 默认已隐藏 deprecation 警告，详见 Remarks |
| 3 (electron) | ⏳ Pending | — | — | — |
| 4 (overrides) | ⏳ Pending | — | — | — |

---

## Remarks

### 已确认事实
- `npm ls` 验证所有 deprecation 警告来源（截至 2026-09-24）
- `package.json` 无 karma 配置文件（karma 是残留依赖）
- Node v24.15.0 远超所有目标依赖的版本要求
- `git status` 工作区干净

### 遗留事项（独立任务）
- Angular 18 → 19 升级时一并清理 `critters@0.0.24` + 残留 `glob@10.5.0`
- 该任务不在本计划范围内
