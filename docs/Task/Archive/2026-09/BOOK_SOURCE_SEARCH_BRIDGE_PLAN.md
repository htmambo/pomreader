# 书源搜索桥接 JS 书源适配器 + 暗色 alert 样式

**Status**: 🔄 In progress (start time: 2026-09-26)
**Owner**: Claude (Opus 5)

## 背景

跨书源聚合搜索 (`MultiSourceSearchService`) 通过 duck-typing `typeof a.search === 'function'` 过滤参与搜索的适配器。但 `JsSourceAdapter`（legado JS 书源）只实现了 `BookSourceAdapter` 接口声明的 `match / fetchCatalog / fetchChapter`，**未暴露 `search()` 方法**，导致所有已装 JS 书源都被过滤掉 → 聚合搜索永远返回空 → 用户看到「未找到匹配结果」+「确认书源列表中至少有一个实现了 search() 接口」。

沙箱侧 `SandboxFn` 已包含 `'search'`（`sandbox.service.ts:6`），调试书源页也能调通。用户实际需求：**装了支持搜索的 JS 书源，应该在书源搜索页直接搜到**。

同时用户反馈：在暗色主题（theme=6）下 `nz-alert` 提示框反差过强、太扎眼。

## 问题分析

| # | 现象 | 根因 |
|---|---|---|
| 1 | 装好 JS 书源、调试页 search 有结果 | 沙箱 `search()` 已实现（`SandboxService.call` 支持 `fn: 'search'`） |
| 2 | 跨书源搜索页搜不到任何结果 | `JsSourceAdapter` 未暴露 `search()` → 鸭子类型过滤排除 → `searchAll()` 返回 `[]` |
| 3 | 空态提示文案太技术 | UI 没把"功能未桥接"转化为"暂未命中" |
| 4 | 暗色模式下 alert 太刺眼 | `ng-zorro-overrides.scss` 没有 alert 暗色覆盖，默认浅蓝/浅黄背景在黑底下反差过大 |

## 详细子任务清单

### 子任务 A：JsSourceAdapter 暴露 search 方法
**文件**: `src/app/core/book-source/js-source/js-source.adapter.ts`

变更：
1. **类型复用**（回应 P1-7）：把 `RawSearchItem` 从 `multi-source-search.service.ts` 提到 `book-source.adapter.ts`（适配器层公共类型），multi-source 改为 `import type { RawSearchItem } from './book-source.adapter'; export type { RawSearchItem };`（**保留**现有 export 路径，调用方零侵入），js-source 直接 `import { RawSearchItem }` 使用。理由：避免 js-source 重新定义（与 multi-source 类型漂移），同时不引入循环依赖（multi → registry → js-source 形成回路时类型提升到 adapter 层切断回路）。
2. 加 `search(keyword, page): Promise<RawSearchItem[]>` 方法
   - **空关键词前置拦截**（回应 P1-5）：`if (!keyword?.trim()) return [];`
   - 复用现有 `ensureLoaded()`（自动触发首次 load + 缓存命中跳过）
   - 委托 `this.sandbox.call(this.meta.fileName, 'search', [keyword.trim(), page ?? 1])`
   - **page 默认 1**（回应 P1-6）：与 `source-debug.component.ts:329` 调试页调用对齐（`exec<unknown[]>('search', [this.testKeyword.trim(), 1], ...)`），注释说明 legado 生态多数书源 1-based
   - 非数组返回 → 兜底空数组（用户书源未实现 search 时）
   - **沙箱错误**（回应 P0-3 + P1-8）：用 try/catch 包，先 `console.warn('[JsSourceAdapter] 书源 ${name} search 失败: ...')` 结构化日志，再 `throw e` 透传给 `MultiSourceSearchService.callSource` 的 catch（30s 超时熔断 + console.warn 二级隔离）。`SandboxService.call` 永远抛 `Error` 实例（sandbox.service.ts:263-267 重建 Ctor），所以 `(e as Error).message` 始终安全。
   - **结果截断**（回应 P2-10）：`raw.slice(0, 100)` 兜底（legado search 单源一般 <50 条；100 是宽限）
3. 字段映射：legado 风格 `bookUrl → url`、`description → intro`、`title → name`
4. 不动 `BookSourceAdapter` 接口（保持接口语义聚焦；duck-typed 增量扩展是项目既定模式）

### 子任务 B：单元测试
**文件 1**: `src/app/core/book-source/js-source/js-source.adapter.spec.ts`

新增用例：
- `search() 委托给沙箱并返回规范化后的数组`
- `search() 兼容 legado 多种字段命名（bookUrl / description / title 兜底）`
- `search() 在沙箱抛错时透传错误`
- `search() 非数组返回兜底为 []`

**文件 2**: `src/app/core/book-source/multi-source-search.service.spec.ts`

新增用例：
- `JsSourceAdapter 暴露 search 后能被聚合搜索识别并按 name|author 去重`

### 子任务 C：暗色 alert 样式覆盖
**文件**: `src/styles/ng-zorro-overrides.scss`

在已有 `[data-pom-theme='6']` 块内追加（沿用既有的 `#1f1f1f / #444 / #c9c9c9` 配色基调）。**回应 P2-9** —— 补全变体：

```scss
/* nz-alert 全局暗色覆盖（回应 user: 暗色下 alert 太刺眼） */
.ant-alert {
  background: #1f1f1f;
  border-color: #444;
  color: #c9c9c9;
}
.ant-alert-info    { border-left: 3px solid #2c5282; }   /* 暗蓝 */
.ant-alert-success { border-left: 3px solid #2d5a3d; }   /* 暗绿 */
.ant-alert-warning { border-left: 3px solid #8a6d3b; }   /* 暗琥珀 */
.ant-alert-error   { border-left: 3px solid #b53d3d; }   /* 暗红 */
.ant-alert .ant-alert-icon { color: #888; }
.ant-alert .ant-alert-message { color: #e0e0e0; }
.ant-alert .ant-alert-description { color: #aaa; }
.ant-alert .ant-alert-close-icon { color: #888; }
.ant-alert .ant-alert-close-icon:hover { color: #ed4259; }
/* 带描述时内边距调整 */
.ant-alert.ant-alert-with-description { padding: 12px 16px; }
.ant-alert-banner { border-radius: 0; }
```

### 子任务 D：UI 文案微调
**文件**: `src/app/pages/book-source/source-search.component.ts`

把空态提示文案「确认书源列表中至少有一个实现了 search() 接口」改为「未找到匹配结果，请尝试更换关键词」。技术性描述移到开发者文档。

## 预期效果

1. **主修复**：用户装的 JS 书源（含搜索能力）出现在聚合搜索结果中，可一键导入书架
2. **副修复**：暗色模式下 alert 改为低对比深色，不再扎眼
3. **可观测**：`MultiSourceSearchService.console.warn` 现在能区分"书源 search 抛错"vs"书源未实现 search"

## 验收标准

### 自动化验收
- [ ] vitest 跑 `js-source.adapter.spec.ts` 与 `multi-source-search.service.spec.ts`，全绿（含本计划新增用例）
- [ ] 不破坏已有 `MockAdapter` 测试用例（鸭子类型契约不变）
- [ ] `tsc --noEmit` 0 错误（双端 Angular + node 测试）

### 手工 e2e 验证（回应 P2-11）
- [ ] 步骤 1：在 `调试书源` 页确认某已知支持 search 的 JS 书源（如 legado 主流书源）能跑通 search
- [ ] 步骤 2：进入 `跨书源搜索` 页，输入调试页验证过的关键词（如 `斗破苍穹`）
- [ ] 步骤 3：预期结果列表非空，至少包含 1 条来自该 JS 书源的命中项（`sourceName` 等于书源名）
- [ ] 步骤 4：去重验证：同名同作者书籍只出现 1 次（multi-source 已有去重逻辑 line 105-108）
- [ ] 步骤 5：切到暗色主题（settings.theme=6），确认 `/book-sources` 的搜索页 alert 不再刺眼
- [ ] 步骤 6：触发错误路径（如某书源 load 失败），确认 console.warn 有 `[JsSourceAdapter] 书源 X search 失败: ...` 输出

### UI 验收
- [ ] 暗色模式下 nz-alert 视觉不再刺眼（用户反馈确认）
- [ ] 提示文案可读性提升

## 风险评估与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| legado `search()` 返回结构差异大 | 字段兜底失败 → 空 url/name | `RawSearchItem` 多字段兜底（`url \|\| bookUrl`），名称用 `name \|\| title \|\| ''` |
| `search()` 抛错阻塞其他书源 | 部分书源报错拖累全页 | `MultiSourceSearchService.callSource` 已有 `try/catch` + console.warn 隔离，单源失败不影响其他；JsSourceAdapter 内增加二级 console.warn |
| 沙箱 `search()` 内调用 `http` 慢 → 30s 单源超时 | 单书源卡 30s 拖累并发 | 30s 超时熔断已在 `callWithTimeout` 实现 |
| `BookSourceAdapter` 接口加 search 破坏既有适配器 | 编译失败 | 不动接口，duck-typed 增量扩展（沿用项目既定模式） |
| 暗色 alert 覆盖影响其它页面（非书源搜索） | 误伤 | 改的是 `[data-pom-theme='6']` 块内的全局 alert 样式，其它页面同样受益（一致性提升） |
| 并发 `ensureLoaded()` 重入（**非本期修复**） | 同一书源被并发触发多次 sandbox.load（sandbox 内部按 fileName 缓存，相同 source 命中跳过，但首次 race 双 load） | **已知既有 bug，本期不修**。JsSourceAdapter 是单实例（registry 内每书源 1 个），并发 search 由 multi-source 触发，现状与修复前一致。后续如需修复，给 `ensureLoaded` 加 `Promise` 缓存即可 |
| 字段全缺失（name+author 都空）的去重合并（**非本期修复**） | 多个无名字无作者的条目合并为 1 条 | **已有行为**（`multi-source-search.service.ts:106` `name\|\|author` 全空 → key=`\|`），非本次改动引入。后续如需修复，给空字符串加随机后缀或丢弃 |

## Commit 拆分策略（回应 P0-2）

按「功能修复」与「视觉优化」拆为独立 commit，便于 selective revert：

| Commit | 内容 | 风险范围 | 回滚成本 |
|---|---|---|---|
| 1 | `refactor(book-source): 提取 RawSearchItem 到 adapter 层 + JsSourceAdapter.search + 测试` | 功能：JS 书源参与聚合搜索 | `git revert` 即可 |
| 2 | `fix(ui): 暗色主题 nz-alert 配色 + 搜索空态文案微调` | 视觉/文案：暗色 alert 配色 + 提示文案 | `git revert` 即可 |

两个 commit 无强依赖，可独立部署 / 独立回滚。

## 实施顺序与依赖

```
A1. RawSearchItem 提到 adapter 层 + multi-source 改 import ──┐
                                                              │
A2. JsSourceAdapter.search() ──→ B.1 js-source.adapter.spec.ts ──┐
                                                                    ├──→ Commit 1
       B.2 multi-source-search.service.spec.ts ────────────────────┘
                                                                  
       C. 暗色 alert ──┐
                       ├──→ Commit 2（独立）
       D. UI 文案微调 ─┘
```

Commit 1（A + B.1 + B.2）与 Commit 2（C + D）无强依赖，可并行。代码改动预估 **+90 行（含测试）/ -10 行**。

## External Review Opinion

### Round 1（kind=plan，verdict=NEEDS_CHANGES，2026-09-26）

技术负责人 review：
- ✅ 优点：根因精准、duck-typed 增量扩展遵从项目约定、字段兼容务实、测试用例有针对性、CSS 改动范围正确、改动量合理
- ⚠️ P0-1（去重逻辑归属不明）→ **已修复**（见 B 子任务，明确去重在 multi-source 已有，本次只验证）
- ⚠️ P0-2（无回滚方案）→ **已修复**（见 Commit 拆分策略）
- ⚠️ P0-3（沙箱错误类型未明确）→ **已修复**（见 A-2：try/catch + console.warn + throw 透传）
- ⚠️ P1-4（并发 ensureLoaded 重入）→ **标注非本期范围**（见风险表）
- ⚠️ P1-5（空关键词未处理）→ **已修复**（A-2 前置拦截）
- ⚠️ P1-6（page 默认依据缺失）→ **已修复**（A-2 注释 + 与调试页对齐说明）
- ⚠️ P1-7（RawSearchItem 类型复用）→ **已修复**（A-1 提到 adapter 层）
- ⚠️ P1-8（无监控/可观测性）→ **已修复**（A-2 console.warn 结构化日志）
- ⚠️ P2-9（CSS 变体覆盖不完整）→ **已修复**（C 补 success/closable/with-description/banner）
- ⚠️ P2-10（单源结果无上限）→ **已修复**（A-2 slice 0,100 兜底）
- ⚠️ P2-11（e2e 步骤缺失）→ **已修复**（验收标准补充具体步骤）
- ⚠️ P2-12（字段全缺失去重合并）→ **标注非本期范围**（已有行为）

→ Round 2 待补：

### Round 2（kind=plan，verdict=？，2026-09-26）
> _由 `mcp__coding-bridge__review_plan` 写入_

## 备注

- 本次改动属"补 by-design 功能缺口"，不修用户已经测通的链路
- 文案微调 D 仅是表面改动，不影响契约
- 暗色 alert 覆盖范围是全局 `nz-alert`，跨页面收益
- 计划文档维护在 `docs/Task/Active/`，完成后归档到 `Archive/2026-09/`
