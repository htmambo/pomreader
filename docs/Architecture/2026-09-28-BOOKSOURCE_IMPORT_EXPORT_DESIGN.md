# 书源导入 / 导出 / 订阅设计

**日期**：2026-09-28
**状态**：设计已确认，待实施
**范围**：Phase 1 备份还原（独立可用）+ Phase 2 订阅自动更新

**修订记录**

- 2026-09-29：按「书源 JSON 化方案 v2.1」（`2026-09-29-BOOKSOURCE-JSON-RULES-PLAN.md` §10）修订。主要变更：
  - bundle `sources[].content` 语义：内嵌 JS 全文 → 内嵌 **BookSourceDoc JSON 全文**（导入侧以 `BookSourceDocSchema` 做 valibot 校验，失败按损坏条目处理）；
  - 移除 `parseHeaderMeta` 依赖（新载体无 `// @key` 头注释，meta 在文档字段里）；
  - 删除 bundle 旁路 `enabled` 字段（启停已内联在 content 的 `enabled` 字段内，旁路携带会产生双真相）；
  - uuid / 基线 hash 口径改为基于 `doc.uuid`（缺省回退带扩展名文件名 `foo.json`，见方案 §3.1 uuid 注释）；
  - 书源文件扩展名引用 `.js` → `.json`，并补充与 `booksources_legacy/` 的关系说明。

---

## 1. 背景

书源在本项目里是 `<userData>/booksources/` 下的独立 `.json` 文件（BookSourceDoc：规则 + meta 合一，schema 见 `src/app/core/models/book-source-doc.model.ts`），启停状态内联在文档的 `enabled` 字段。JSON 化迁移前的 `.js` 原件备份在 `<userData>/booksources_legacy/`（只读，永不执行、永不删），不参与导入导出。

当前只有**一条腿**：即 `ImportLegadoComponent` 弹窗从订阅 URL 或粘贴 JSON 导入 Legado（阅读）格式的源，单向转换成 pomreader 书源。**导出完全不存在**，因此：

- 换机器 / 重装系统后，用户导入了上百个源，要重新去网上一份份找订阅重导；
- 用户自己写的源没有任何对外的迁移手段；
- 没有订阅概念，无法跟踪上游更新。

本设计补上序列化内核（导出 + 导入），并在同一内核上叠加订阅自动更新。

## 2. 目标与非目标

### 目标

1. 把本地书源导出为单个文件，用于备份与迁移还原（高保真，含启停状态）。
2. 从该文件完整还原书源，冲突可见、可逐项决策。
3. 订阅：登记一个 bundle 拉取地址，按周期检查更新；有变化时自动写入，本地被改动过的源交由用户裁决。
4. 订阅的调度在主进程，窗口最小化 / 后台时仍能运行。

### 非目标

- **不做**导出成 Legado 兼容格式（用户未选择「分享给他人」场景；且现有转换是单向的，反向会丢 `minDelayMs` / `requireUrls` / `enabled` 等 pomreader 特有字段）。
- **不做**云同步 / 跨设备自动同步。
- **不纳入**草稿目录 `<userData>/booksources_drafts/`。

## 3. 关键事实（已核对代码）

| 事实 | 位置 | 影响 |
|---|---|---|
| 书源 = 独立 `.json` 文件（BookSourceDoc，规则 + meta 合一） | `src/app/core/models/book-source-doc.model.ts` `BookSourceDocSchema` | 导出即整份文档 JSON，无需另行抽取元数据 |
| 启停内联在文档 `enabled` 字段（原 marker 文件已随 JSON 化取消） | `book-source-doc.model.ts` / `core/logic/build-book-source-doc.ts` | bundle **不单独携带** `enabled`，避免双真相 |
| `safeFileName` 拒绝 `/` `\` `..` 空串 | `booksource-meta.ts` | 导入的 `fileName` 必须二次校验 |
| `atomicWrite` = tmp + rename，失败清 tmp | `booksource-meta.ts` | 单文件写入原子；批量不原子（见 §8） |
| 渲染层无 node 访问，IO 全部走主进程 IPC | `electron/preload.ts` / `main.ts` | 调度与写盘放主进程 |
| `safeNetRequest` 已含 SSRF 防护与编码转换 | `electron/ipc/safe-net.ts` | 订阅拉取复用，不新开网络通道 |
| `dialog.showSaveDialog` 已有先例 | `electron/auto-import.ts:127` | 导出保存对话框沿用同款 |
| 已有 Legado 导入弹窗的列表-勾选-统计骨架 | `src/app/modals/import-legado/` | 三个新弹窗复用同一视觉 |

## 4. 序列化内核：bundle 格式

### 4.1 格式

```jsonc
{
  "format": "pomreader.booksource.bundle",  // 常量，演进时用于拒绝未知值
  "version": 1,
  "exportedAt": 1789000000000,              // number ms，与项目现有 modifiedAt 同单位
  "app": "1.0.0",                          // 导出方版本，仅供排查
  "sources": [
    {
      "uuid": "3f2a…",                     // 来自 doc.uuid；缺省回退带扩展名文件名（`foo.json`，见方案 §3.1 uuid 注释）
      "fileName": "example-source.json",
      "content": "{ \"format\": \"pomreader.booksource\", \"schemaVersion\": 1, … }"   // BookSourceDoc JSON 全文；enabled 等 meta 均在其中
    }
  ]
}
```

### 4.2 有意的设计决策

**不存冗余 `meta` 对象。** 预览界面需要名称、标签、类型，但 `content` 本身就是 BookSourceDoc（meta 与规则合一），valibot parse 一次即得全部字段。存两份真相必然出现不一致（改了 meta 没改 content，导入时以谁为准？）。故 bundle 只保留无法推导的字段：`exportedAt`（纯信息）。修订前另有旁路 `enabled` 字段 —— 彼时启停是独立 marker 文件；JSON 化后 `enabled` 内联进文档，旁路字段随之删除。

**`content` 是权威副本。** 导入时 `content` 覆盖整个文件；落盘前逐条过 `BookSourceDocSchema`（valibot），校验失败按损坏条目处理（见 §5.3 `invalid`）。这保证了「导出 → 还原」逐字节一致。

### 4.3 纯函数模块

新增 `electron/shared/booksource-bundle.ts`，只做纯计算，无 Electron 依赖，与 `booksource-meta.ts` 同构（可被 vitest 直接单测）：

| 导出 | 职责 |
|---|---|
| `parseBundle(text: string): BookSourceBundle` | 解析 + 校验。未知 `format`、缺字段、单条 `content` 未通过 `BookSourceDocSchema`、超限条目、超限总量一律抛错，**整体拒绝**，不做部分导入 |
| `buildBundle(items: BundleSourceInput[]): BookSourceBundle` | 组装 |
| `diffBundle(incoming, local, baseline?): DiffEntry[]` | 分类，见 §5 |

校验上限（防止手滑拖入巨型 JSON 撑爆渲染进程）：单条 `content` ≤ 2 MB，整个 bundle ≤ 20 MB。

## 5. 导入 / 导出数据流

### 5.1 导出

```
渲染层勾选书源
  → IPC pom:booksource-bundle-export(fileNames[])
  → 主进程逐个读 content（复用现有 booksource-read 通道，不新开读通道）
  → buildBundle
  → dialog.showSaveDialog（默认文件名 pomreader-sources-YYYY-MM-DD.json）
  → atomicWrite
  → 返回实际写入路径与条数
```

### 5.2 导入

```
IPC pom:booksource-bundle-open()
  → dialog.showOpenDialog
  → parseBundle（失败则整体拒绝并提示原因）
  → diffBundle 返回逐条分类
  → 渲染层预览（按分类分组、勾选、统计）
  → 用户确认
  → IPC pom:booksource-bundle-apply(decisions[])
  → 写前全量预校验：safeFileName + BookSourceDocSchema 必须成功
  → 逐条 atomicWrite（enabled 已内联在 content 内，随文件落盘，无 marker）
  → sender.send('pom:booksource-updated', {...})
  → 列表页刷新
```

### 5.3 diff 分类

**匹配键：uuid 优先，fileName 兜底。** uuid 取 `doc.uuid`（缺省 = 带扩展名文件名 `foo.json`，与 §4.1 同口径）；显式 uuid 的源改过文件名后仍认作同一源，避免重复导入产生两份。

| 类别 | 判定 | 默认勾选 | 说明 |
|---|---|---|---|
| `new` | 无本地匹配项 | ✅ | |
| `identical` | `content` 逐字节相同 | 灰显 | 不计入统计 |
| `update` | 同源、`content` 不同、**无本地改动基线** | ✅ | 备份还原场景就是要覆盖 |
| `conflict` | 同源、`content` 不同、**本地在上次订阅写入后被改过** | ❌ | 订阅场景才可能命中 |

本地导入（无基线）只会产生 `new` / `identical` / `update`。订阅更新（带 `applied` 基线）才会产生 `conflict`。

`invalid`（`fileName` 非法或 `content` 未通过 `BookSourceDocSchema` 校验）在 `parseBundle` 阶段即被拒（整体拒绝，见 §4.3），不进入预览列表。

## 6. 订阅

### 6.1 状态文件

`<userData>/booksource-subscriptions.json`：

```jsonc
{
  "version": 1,
  "items": [
    {
      "id": "s1",                          // 随机 uuid，导入侧引用
      "name": "示例订阅",
      "url": "https://example.com/sources.json",
      "enabled": true,
      "intervalHours": 12,                 // 默认 12
      "lastCheckedAt": 1789000000000,      // null = 从未成功
      "lastError": null,                   // 最近一次失败原因，列表页展示
      "applied": {                         // 冲突判定基线
        "3f2a…": "<sha256(content)>"
      }
    }
  ]
}
```

### 6.2 `applied` 基线机制

`applied[uuid]` = 上次该订阅成功写入时，`content`（BookSourceDoc JSON 全文）的 sha256；uuid 取 `doc.uuid`，缺省回退带扩展名文件名（`foo.json`，与 §4.1 同口径）。下次拉取时对每个远端源：

- 远端 hash **等于** `applied[uuid]` → 本地自上次写入后未被外部改动 → 可安全自动写入（`update`）
- 远端 hash **不等** → 远端更新了，但本地可能也改过 → 判 `conflict`，交给用户
- `applied` 中无此 uuid 且本地无此源 → `new`
- 本地有源但 `applied` 无记录（手工导入的书源）→ 无基线，按 `update` 处理

不需要为这个额外造一个状态文件 —— 订阅表本身就是状态存储。

### 6.3 调度

主进程持有，**单条** `setInterval`，30 分钟一跳：

- 应用启动后 60 秒跑一次（避开冷启动磁盘高峰）
- 每跳只处理 `enabled === true` 且已到期（`lastCheckedAt + intervalHours * 3600_000 <= now`）的订阅
- 拉取走 `safeNetRequest`，沿用既有 SSRF 防护与编码转换
- 命中变化 → `atomicWrite` → 更新 `applied` 与 `lastCheckedAt` → 逐个窗口 `sender.send('pom:booksource-updated', { subscriptionId, changed, conflicts })`；渲染层弹 toast 并刷新列表
- 失败只记 `lastError`，**不重试风暴**（等下一跳），**不打断同跳的其他订阅**
- `BrowserWindow.getAllWindows().length === 0` 时跳过本跳（无窗口可通知，也无人在意）
- 应用退出时清 timer

### 6.4 渲染层交互

书源列表页工具栏新增三个按钮：**导入** / **导出** / **订阅**。

- 导出弹窗：书源列表（复用列表页的过滤逻辑）+ 全选/反选 + 确认
- 导入弹窗：解析 → 按 `new` / `update` / `conflict` / `identical` 分组的预览 + 逐项勾选 + 统计行 → 应用
- 订阅弹窗：订阅表（名称 / URL / 上次检查 / 下次检查 / 状态）+ 新增 / 编辑 / 删除 / 立即检查

三个弹窗复用 `ImportLegadoComponent` 的视觉骨架。

## 7. 安全边界

| 面 | 措施 |
|---|---|
| 导入文件名 | `parseBundle` 与写盘前各过一次 `safeFileName` |
| 导入内容大小 | 单条 2 MB / 总量 20 MB 硬上限 |
| 订阅 URL | 走 `safeNetRequest`（既有 SSRF 防护），不新开网络出口 |
| 渲染层信任边界 | 渲染层无 node 访问；导入内容为纯数据 JSON，经 `BookSourceDocSchema` 校验后由 JSON 规则引擎解释执行，无 eval 链路（JS 书源的 `pom:booksource-eval` 随 JSON 化方案 P4 删除） |
| 未知格式 | `format` 常量不匹配即整体拒绝，避免误读他人 JSON |

## 8. 接受的取舍

1. **批量写入不做整体回滚。** 单文件靠 `atomicWrite` 原子，但批量非原子。取舍为「写前全量预校验（`safeFileName` + `BookSourceDocSchema` 必须成功），再逐个写，失败项收集后报告」。整体回滚的复杂度远高于收益 —— 写入幂等，用户重试即可。
2. **草稿目录不进 bundle。** 草稿是需要手写的半成品，备份它只会污染还原结果。
3. **不做 Legado 反向导出，不做云同步。** 见 §2 非目标。
4. **`identical` 项灰显而非隐藏。** 让用户确认「这些确实已存在」比静默消失更有说服力。

## 9. 测试策略

| 文件 | 覆盖 |
|---|---|
| `electron/shared/booksource-bundle.spec.ts` | 编解码往返；`parseBundle` 拒绝未知 `format` / 缺字段 / 超限 / `content` 未通过 `BookSourceDocSchema`；`diffBundle` 五类判定；uuid 优先匹配；基线 hash 变化触发 `conflict`；`parseBundle` 对恶意 `fileName`（`../x.json`）的拒绝 |
| `electron/ipc/booksource-bundle-handler.spec.ts` | dialog 取消；`safeFileName` 拒绝路径穿越；写入后 `enabled` 状态随文档落盘正确（无 marker 文件）；部分失败时报告结果（沿用 `booksource-handler.spec.ts` 的 mock 风格） |
| `electron/ipc/booksource-subscription.spec.ts` | 到期计算；单订阅失败不阻断同跳其他订阅；`applied` 更新；通知 payload 内容 |
| 渲染层组件 spec | 预览分类渲染、勾选与统计、默认勾选规则（比照现有 `import-legado.component` 测试风格） |

## 10. 实施分期

**Phase 1（备份还原，独立可用）**
1. `electron/shared/booksource-bundle.ts` + spec —— 内核纯函数
2. `electron/ipc/booksource-bundle-handler.ts` + spec —— 导出 / 打开 / 应用
3. `electron/preload.ts` 补通道
4. 导出弹窗 + 导入预览弹窗 + 列表页按钮
5. `BookSourceListStateService` 监听 `pom:booksource-updated` 并触发刷新

**Phase 2（订阅更新，复用 Phase 1 内核）**
6. `electron/ipc/booksource-subscription.ts` + spec —— 状态读写 / 调度 / 拉取 / diff / 写盘
7. `main.ts` 注册与生命周期
8. `preload.ts` 订阅 CRUD 通道
9. 订阅管理弹窗

## 11. 未决与风险

- **External Review 未执行。** 本设计经与用户两节确认，但 `coding-bridge` MCP 返回 429（月度配额耗尽），本会话未安装 codex MCP，无法切换 fallback provider。本次结论来自与现有代码事实（`booksource-meta.ts` / `safe-net.ts` / `booksource-handler.spec.ts`）的本地交叉核对，**未经外部评审**。实施前建议在配额恢复后补一轮。
- **主进程定时器与系统休眠。** 休眠期间不触发，唤醒后下一跳补跑；间隔判断基于绝对时间戳，休眠不会导致重复触发。
- **订阅表并发写。** 仅主进程单点写，渲染层只发指令，无并发风险。
