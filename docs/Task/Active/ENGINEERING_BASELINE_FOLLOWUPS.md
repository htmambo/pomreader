# 待办：工程基线后续优化项

**Status**: 🔄 Active（待启动）  
**Creator**: Claude Code  
**来源**：2026-11-12「项目规范债收口与安全依赖升级」外部代码审查（Round 1）中确认成立、但不属于本次整改范围的项目

## 背景

2026-11-12 的规范债收口任务已完成（详见 [归档计划](../Archive/2026-11/CONVENTION_DEBT_AND_SECURITY_PLAN.md)）。外部审查共提 10 条，其中多数为误报或既有状态，实测澄清如下：

- **误报**：`/assets/` 绝对路径在子路径部署下断裂 —— 实测迁移**前**产物 CSS 本就是 `url(/assets/...)` 绝对路径，本次改动逐字等价，未引入回归。
- **误报**：`source-health.service.ts` 存在悬空引用 —— `rg` 全仓核实零引用（README 结构树与 scss 注释的过期提及已同步修正）。
- **误报**：覆盖率阈值跳跃过大无缓冲 —— 阈值按实测值 -2~6pp 设定（lines 88/实测 93.62、functions 85/实测 90.75、statements 86/实测 91.68、branches 80/实测 86.19）。
- **误报**：5 处模板拆分存在逻辑丢失 —— 逐组件比对绑定集合，37/14/18/19/14 项全部逐字一致。
- **误报**：`no-undef` 可能覆盖 JS 文件 —— 该规则块 `files: ['**/*.spec.ts']`，且 `tseslint.configs.recommended` 本身已含 `no-undef: 'off'`。

以下 3 条确认为**真实且属于预存技术债**，本次未处理，理由如下。

## 待办项

- [ ] **S-1 Sass `@import` → `@use` 迁移**：`src/styles.scss` 4 处 `@import`（ng-zorro CSS / tokens / ng-zorro-overrides / reader）触发 Dart Sass 弃用警告（构建时可见 `Sass @import rules are deprecated and will be removed in Dart Sass 3.0.0`）。
  **为何本次不做**：属预存问题且与本轮整改主题无关；`@use` 语义与 `@import` 不同（创建命名空间、不泄漏变量），需逐文件核对 mixin/变量导出，机械替换有风险。
  **触发条件**：Dart Sass 3.0 发布前安排独立任务。

- [x] **S-2 CSS 资源路径改相对路径**：`reader.component.scss` 的 `url(/assets/...)` 已改为 `../../../assets/...`（2026-11-27，见 [安全与性能硬化](../Archive/2026-11/SECURITY_PERF_HARDENING_PLAN.md)）。
  **实际影响比原判断更大**：Electron 打包版以 `file://` 加载 `index.html`，根绝对 `/assets` 会解析到文件系统根（`file:///assets/...`），主题纹理在打包态直接 404；现已由 Angular 构建器改写为 `media/` 哈希资源。

- [ ] **S-3 CI lint 与 Playwright 安装并行化**：`.github/workflows/ci.yml` 的 `lint-unit-build` job 中 `npm run lint` / `format:check` 不依赖 Playwright 浏览器二进制，可拆为独立 job 与 e2e job 并行以缩短总时长。
  **为何本次不做**：CI 总时长由 e2e job（≤15min）主导，拆分后收益有限且增加 workflow 复杂度。
  **触发条件**：CI 排队时长成为瓶颈时。

## 备注

- 2026-11-12：外部审查 Round 1 完成，10 条中 7 条经实测证伪或属既有状态，3 条转为本清单 S-1/S-2/S-3。
