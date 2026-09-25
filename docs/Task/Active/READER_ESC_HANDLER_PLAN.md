# 阅读页 Esc 按键栈式关闭

**Status**: 🔄 In progress (2026-09-25)
**Scope**: 阅读页添加 Esc 按键栈式退出逻辑（弹窗 → panel → 返回书架）
**Review Loop**: Round 0/5 — 待外部审查

---

## 背景

阅读页 (`src/app/pages/reader/reader.component.ts`) 已有 `@HostListener('document:keydown')` 处理 ArrowLeft / ArrowRight 翻章/翻页，但**未处理 Esc**。当前需要：
- 按 Esc 时如有弹窗/panel，按"栈"语义逐层关闭
- 弹窗栈深度 ≥ 2 时只关顶层
- 全部关闭后再按 Esc 才返回书架

调研见上方对话历史，关键事实：
- 阅读页现有 6 个"弹窗"入口：2 个 panel（`catalogOpen` / `settingsOpen` signal）+ 4 个 NzModal（`JumpChapter` / `EditBookInfo` / `confirmDelete` / `refreshContent`）
- ng-zorro 18.2.1 暴露 `NzModalService.openModals: NzModalRef[]`（弹窗栈）
- `NzModalService.closeAll()` / `NzModalRef.close() / destroy()` 可关闭
- 默认 `nzKeyboard: true` —— modal 自带 Esc 监听，**会与 ReaderComponent 的 Esc 重复触发**

---

## 已确认的决策点（用户 2026-09-25 答复）

| # | 决策点 | 决策 |
|---|---|---|
| Q1 | 关闭优先级栈 | NzModal 顶层 → `settingsOpen` panel → `catalogOpen` panel → `router.navigate('/bookshelf')` |
| Q2 | 禁用 ng-zorro modal 自带 Esc | 4 处 modal 入口全部加 `nzKeyboard: false`，由 ReaderComponent 统一接管 |
| Q3 | `modalOpen` 升级 | 删除 `modalOpen: signal<boolean>`，改 `modalOpen = computed(() => this.modal.openModals.length > 0)` |
| Q4 | 章节加载/翻页测量中是否屏蔽 Esc | **始终响应**（Esc 走导航路径，与翻页测量正交） |
| Q5 | 删除确认 modal 的 Esc 语义 | 等价"取消删除"，无副作用（P3 注释已确认） |
| Q6 | 输入态过滤覆盖 SELECT | 是，`closest('input, textarea, [contenteditable=true], select')` |

---

## 实施步骤

### 步骤 1：升级 `modalOpen` 语义 + 输入态过滤

**文件**：`src/app/pages/reader/reader.component.ts`

**改动 1.1**：删除现有 4 处 `modalOpen.set(true)` + 4 处 `modalOpen.set(false)` 样板（共 8 处）
**改动 1.2**：`modalOpen = signal(false)` → `modalOpen = computed(() => this.modal.openModals.length > 0)`
**改动 1.3**：扩展输入态过滤 → `target.closest('input, textarea, [contenteditable=true], select')` 覆盖 nz-select 内部 button 的失焦场景

**风险**：🟢 低
- modalOpen 由 signal 改 computed 是纯派生，不破坏现有调用
- 4 处 modal 入口代码更干净（去掉 8 行样板）

### 步骤 2：4 处 modal 加 `nzKeyboard: false`

**文件**：`src/app/pages/reader/reader.component.ts`

| 入口 | 行号 | 改动 |
|---|---|---|
| `openJumpDialog` | 709 | `this.modal.create({ ..., nzKeyboard: false, ... })` |
| `confirmDelete` | 735 | `this.modal.confirm({ ..., nzKeyboard: false, ... })` |
| `openEditBookInfoDialog` | 765 | `this.modal.create({ ..., nzKeyboard: false, ... })` |
| `refreshContent` | 793 | `this.modal.create({ ..., nzKeyboard: false, ... })` |

**风险**：🟡 中
- modal 自带 Esc 关闭被关掉，**必须依赖 ReaderComponent 的 Esc 处理**；若 Esc 处理遗漏，用户无法用键盘取消弹窗（仍可点"取消"按钮）
- 兜底：测试阶段手动验证每个 modal 的"取消/×"按钮仍可用

### 步骤 3：新增 `case 'Escape'` 分支 + 栈式退出

**文件**：`src/app/pages/reader/reader.component.ts`

**新增函数**：
```typescript
private closeTopLayer(): void {
  // 优先级：modal 顶层 → settings panel → catalog panel → 返回书架
  // 用 triggerCancel 走 ng-zorro 标准 cancel 流程（保留未来 nzOnCancel 钩子扩展点）
  const topModal = this.modal.openModals[this.modal.openModals.length - 1];
  if (topModal) {
    topModal.triggerCancel();
    return;
  }
  if (this.settingsOpen()) {
    this.settingsOpen.set(false);
    return;
  }
  if (this.catalogOpen()) {
    this.catalogOpen.set(false);
    return;
  }
  this.router.navigate(['/bookshelf']);
}
```

**修改 `onKeydown` switch**：
```typescript
switch (event.key) {
  case 'Escape':
    event.preventDefault();
    this.closeTopLayer();
    break;
  // ... 现有 ArrowLeft / ArrowRight 保留
}
```

**修改现有 `if (this.modalOpen()) return;`**：
- 移到 `onKeydown` 顶部仅挡 ArrowLeft/Right（保留"modal 期间不翻页"语义）
- Escape 分支不受此 return 影响
- 等价改写：
  ```typescript
  onKeydown(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    const inEditable = target?.closest('input, textarea, [contenteditable=true], select');
    
    if (event.key === 'Escape') {
      if (inEditable) return;  // 输入框中 Esc 不响应（避免丢输入）
      event.preventDefault();
      this.closeTopLayer();
      return;
    }
    
    // 翻页键：modal 期间 + 输入态 + 章节加载/测量中 全部 return
    if (this.modalOpen() || inEditable) return;
    if (this.chapterLoading() || !this.pageReady()) return;
    
    switch (event.key) { /* ... */ }
  }
  ```

**风险**：
- 🔴 R1：与 ng-zorro 自带 Esc 冲突（步骤 2 已通过 `nzKeyboard: false` 解耦）
- 🟡 R3：Panel 与 Modal 同开时优先级已固定为 modal 先关
- 🟢 R7：始终响应 Esc（章节加载/测量中也响应），与用户确认的 Q4 一致

### 步骤 4：单 commit 提交

**单 commit 信息**（遵循项目 commit 风格）：
```
feat(reader): Esc 栈式关闭（modal → panel → 返回书架）

- modalOpen 由 signal 升级为 computed，派生自 NzModalService.openModals
- 4 处 modal 入口加 nzKeyboard: false，统一由 ReaderComponent 接管 Esc
- 新增 closeTopLayer() 实现栈式退出（modal 顶层 → settings → catalog → navigate）
- 输入态过滤扩展为 closest('input, textarea, [contenteditable], select')
- Escape 分支不依赖 chapterLoading/pageReady，紧急退出场景生效
```

---

## 风险评估汇总

| # | 风险 | 严重度 | 处置 |
|---|---|---|---|
| R1 | ng-zorro 默认 Esc 与 ReaderComponent Esc 重复触发 | 🔴 | 步骤 2 全部 modal 加 `nzKeyboard: false` |
| R2 | `modalOpen` 布尔无法表达栈深度 | 🟡 | 步骤 1.2 改 computed |
| R3 | Panel + Modal 同开时优先级 | 🟡 | 步骤 3 优先级栈固定 |
| R4 | `confirmDelete` 失败时 Esc 行为 | 🟢 | 等价"取消删除"，符合直觉 |
| R5 | `refreshContent` 自定义 footer 无显式 cancel | 🟢 | 触发默认 triggerCancel，ref.destroy() 已保护 |
| R6 | 输入态过滤不完整 | 🟢 | 步骤 1.3 扩展 closest 判定 |
| R7 | 章节加载/测量中是否屏蔽 Esc | 🟢 | Q4 决策：始终响应 |
| R8 | focus 在 modal nz-button 上按 Esc | 🟢 | 等价"按取消"，可接受 |
| R9 | 全局快捷键冲突 | 🟢 | 已扫：无其他 Esc 监听 |

---

## 回退方案

**整 commit 回退**（用户偏好 — 翻页失败时整体 revert，参考 `feedback-pagination-revert-preference`）：
```bash
git revert HEAD
# 或
git reset --hard HEAD~1 && git push --force
```

**回退点识别**：
- 步骤 1 / 2 / 3 在**同一 commit**内（用户偏好：dep 引入 + 首次使用合并单 commit）
- 验收失败时直接 `git revert`，无需分析哪一步错了

---

## 验收清单

- [ ] `npm run build` 通过
- [ ] `npm test` 通过（如有相关单测）
- [ ] `npm run build:electron` 通过（如有改动影响 electron）
- [ ] 手动验证（dev 启动 ng serve 后）：
  - [ ] 打开目录 → Esc → 关闭目录（不留层）
  - [ ] 打开设置 → Esc → 关闭设置
  - [ ] 打开跳章节 modal → Esc → 关闭 modal
  - [ ] 打开删除确认 modal → Esc → 关闭 modal，书籍未被删除
  - [ ] 打开编辑书籍信息 modal → Esc → 关闭 modal
  - [ ] 打开刷新内容 modal → Esc → 关闭 modal，未触发任何刷新动作
  - [ ] 打开目录 + 再打开跳章节 modal → Esc → 仅关闭 modal，目录保留
  - [ ] 多 modal 嵌套（理论上 ng-zorro 允许叠加）：连开跳章节 + 编辑书籍信息 modal → Esc → 仅关闭顶层编辑 modal，跳章节 modal 焦点与遮罩恢复正常可交互
  - [ ] 无任何弹窗/panel → Esc → 返回书架
  - [ ] 焦点在 nz-select / nz-input / textarea 时 → Esc → 不关闭弹窗（保护输入）
  - [ ] 焦点在 modal nz-button 上 → Esc → 关闭 modal
  - [ ] 章节加载中 → Esc → 直接返回书架（不等待）

---

## 进度记录

| 步骤 | 状态 | 完成日期 | 验收人 | 备注 |
|---|---|---|---|---|
| 1 (modalOpen computed) | ⏳ Pending | — | — | — |
| 2 (nzKeyboard: false) | ⏳ Pending | — | — | — |
| 3 (closeTopLayer) | ⏳ Pending | — | — | — |
| 4 (commit) | ⏳ Pending | — | — | — |
| External Review (Round 1) | ⏳ Pending | — | — | — |

---

## External Review Opinion

> 本节由外部 review MCP（coding-bridge）按 CLAUDE.md §1.5 协议驱动，主 assistant 单方面写入 round 计数。

### Round 1/5 — 2026-09-25

**Provider:** coding-bridge
**Kind:** plan
**VERDICT:** NEEDS_CHANGES（审查员结论："修复 P1 和 P2 的建议后，方案即可进入实施阶段"）

**Findings（6 条，按严重程度）**：
- P1-A: `<select>` 原生下拉 Esc 被输入态过滤屏蔽（项目无原生 select 使用 → **不修**）
- P1-B: nz-select 下拉浮层 Esc 被穿透关闭宿主 modal（项目无 nz-select 使用 → **不修**）
- P2-A: `topModal.close()` 绕过 `nzOnCancel` 生命周期（4 个 modal 均无 nzOnCancel 配置 → **修复：改用 `topModal.triggerCancel()`**）
- P2-B: Focus Trap 残留（ng-zorro 内部仍管焦点 trap，仅 Esc 路径被接管；验收阶段手动验证）
- P3: `event.preventDefault()` 阻止全屏退出（项目无 Fullscreen API，仅 `.fullscreen` CSS class → **不修**）
- P4-A: 路由跳转无防抖（Angular Router 18 默认忽略同 URL 重复 navigate → **不修**）
- P4-B: 多 Modal 堆叠验收清单缺一项 → **修复：补验收项**

**Round 1 修复计划**：
1. `closeTopLayer` 中 `topModal.close()` → `topModal.triggerCancel()`
2. 验收清单新增"多 modal 嵌套堆叠"条目

### Round 2/5 — 2026-09-25

**Provider:** coding-bridge
**Kind:** plan
**VERDICT:** ✅ **APPROVED**

**Round 1 修复验证**：
- ✅ P2-A（triggerCancel）：采纳，`closeTopLayer` 中已用 `triggerCancel()` 替代 `close()`
- ✅ P4-B（多 Modal 嵌套验收项）：采纳，已补入验收清单

**5 条不修 finding 的独立核实结论**：
- ✅ P1-A select / P1-B nz-select：项目确实无使用，接受
- ✅ P2-B Focus Trap：triggerCancel 走 ng-zorro 标准销毁流程，焦点陷阱随浮层销毁自动卸载
- ✅ P3 preventDefault 全屏：项目仅 CSS class 模拟全屏，无 Fullscreen API
- ✅ P4-A 路由防抖：Angular Router 18 默认对同 URL navigate 触发 NavigationIgnored

**非阻断 P4 建议**（采纳）：
1. 在 `closeTopLayer` 方法内补充注释，指明栈仅覆盖 NzModal + 2 个 signal panel；未来扩展 Drawer 等浮层时需更新此处
2. 输入态 Esc 直接 return 维持现状（符合验收清单，未来可评估"二次 Esc 强制关闭"）

**Review Loop 状态**：CLOSE（APPROVED），进入实施

---

<!-- VERDICT PROTOCOL TAIL (per CLAUDE.md §1.5 "Coding-bridge verifier cheat") -->

## Reviewer Verdict Anchor

请 review MCP 在本节末尾返回**严格 JSON**：

```json
{
  "verdict": "APPROVED | NEEDS_CHANGES | REJECTED",
  "risks": [
    { "severity": "P1 | P2 | P3 | P4", "summary": "...", "fix": "..." }
  ],
  "suggestions": ["..."],
  "diff": "（可选）unified diff patch"
}
```

**判定规则**：
- `verdict: APPROVED` → 通过，进入实施
- `verdict: NEEDS_CHANGES / REJECTED` → 修复后重 review，最多重试 5 轮
- 未返回严格 JSON 视为 `UNKNOWN` → NOT_APPROVED（fail-closed）