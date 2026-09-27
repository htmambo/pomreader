# External Review Log

记录所有通过 `mcp__coding-bridge__review_code` / `review_plan` 收到的 review verdict，
按 CLAUDE.md §1.5 Review Loop Protocol 处置。

---

## Round 1/5 — 2026-09-24 (commit f7ab390..70da9f4 累积改动)

**Provider:** coding-bridge
**Kind:** code
**VERDICT:** NEEDS_CHANGES

### Findings (按严重程度)

#### P1 - 严重

1. **`db.service.ts` chapterAllRaw / bookDelete 前缀冲突**
   - 风险：`chapter:{bookId}:` 前缀匹配，若 bookId 形如 `a` 与 `a-extra`，查询 `a` 的章节会误命中 `a-extra`
   - 实际 bookId 形态：`online-{ts}` 或本地 txt id，目前不含 `-` 后跟其他字符的情形；但代码鲁棒性差

2. **`db.service.ts` chapterPutMany 串行写入**
   - 千章规模 2000 次 IndexedDB 事务，导入慢且阻塞 UI
   - 应改 `db.bulkDocs`

#### P2 - 高

3. **`import-online.component.ts` 第 30 行 placeholder 是真实盗版站点 URL**
   - `https://www.xbiquge.cc/book/9231/` 违反 CLAUDE.md 中性 placeholder 规则
   - 改为 `https://example.com/book/123/`

4. **`db.service.ts` bookPut 读-改-写竞态**
   - 编辑书籍与自动进度保存可能并发，`bookPut` 会丢失中间进度
   - 用 PouchDB put 409 冲突检测 + 重试

5. **`reader.component.ts` 键盘事件 modal 期间仍响应**
   - Modal 打开时焦点在背景/按钮时按方向键仍翻页
   - 加 `modalOpen` signal 拦截

#### P3 - 中

6. **`jump-chapter-dialog.component.ts` 缺校验反馈**
   - `nz-input-number` 无 `[nzStatus]` 绑定
   - 加 error signal + nzStatus

7. **`db.service.ts` bookDocToBook / chapterDocToChapter `void _i` 不优雅**
   - 改 rest-sibling 解构 + 在 BookDoc 里把 type/_id/_rev 显式 mark

8. **`db.service.ts` seedIfEmpty 用 `info.doc_count` 判断空库**
   - doc_count 含 design docs，未来若引入 views 会误判
   - 改用 `bookAll().length === 0` 判断

9. **历史 commit 边界：`f7ab390` + `d4f4041` 不可独立 revert**
   - deps 引入 pouchdb-browser 与首次使用拆在不同 commit
   - 教训：未来 dep 引入 + 首次使用合并；本轮不可修复（已 push）

#### P4 - 低

10. **`edit-book-info-dialog.component.ts` coverColor 多控件 ngModel 双向同步闪烁**
    - color picker 输出小写 hex，手输可能大写；过程中轻微不一致
    - 加 `(ngModelChange)` 实时 lowercase + 校验

11. **`ng-zorro-overrides.scss` `.ant-modal .ant-list-items` 选择器脆弱**
    - 强依赖 ng-zorro 内部类名，大版本升级会断
    - 加自定义 class（如 `.modal-list-scrollable`）

---

## Round 2/5 — 2026-09-24 (commit 59a8e85 修复后 re-review)

**Provider:** coding-bridge
**Kind:** code
**VERDICT:** NEEDS_CHANGES

### Findings (Round 1 修复验证 + 新风险)

#### Round 1 修复验证（11 项）

| # | Finding | 状态 |
|---|---|---|
| P1.1 | chapter _id 前缀冲突 (U+001F 分隔) | ✅ Fixed（但引入新风险 1：历史数据兼容） |
| P1.2 | chapterPutMany bulkDocs | ✅ Fixed |
| P2.3 | placeholder 真实 URL | ✅ Fixed |
| P2.4 | bookPut 409 retry | ⚠️ Partially Fixed（无 backoff/jitter；本地够用） |
| P2.5 | modalOpen signal 拦截键盘 | ✅ Fixed |
| P3.6 | jump dialog error signal + nzStatus | ✅ Fixed |
| P3.7 | eslint-disable 注释 | ⚠️ Partially Fixed（注释位置错 → 见新风险 2） |
| P3.8 | seedIfEmpty 改 bookAll().length | ✅ Fixed |
| P4.10 | coverColor 实时 lowercase | ✅ Fixed |
| P4.11 | .modal-list-scrollable 自定义 class | ✅ Fixed |

#### 新 Risks

1. **P1 严重：CHAPTER_SEP `:` → `\x1f` 是 breaking change**
   - 旧库 chapter 文档 _id 仍是 `chapter:bookId:1`，新查询不到；bookDelete 不级联
   - 修复：DbService 构造时 fire-and-forget 调 `migrateLegacyChapterIds()`：扫描旧 _id + bulkDocs 「删旧 + 建新」

2. **P2 低：eslint-disable-next-line 注释位置错误**
   - 之前放在函数签名行，应在解构语句上一行
   - 修复：移动注释到 `const { _id, _rev, type, ...rest } = doc;` 上一行

3. **P3 低：afterClose 订阅未销毁隐患**
   - 直接 `subscribe` 返回的 Subscription 未管理（虽然 NgModal 自动 complete 自身 Subject）
   - 修复：加 `.pipe(take(1))` 明确只触发一次

4. **P3 低：chapterPutMany 缺少 409 冲突容忍**
   - 部分文档失败时整批 throw；本地单机不会触发，业务上 OK
   - 决定：暂不修（本地场景，业务可接受；后续接入远程同步时再补 retry）

---

## Round 3/5 — 2026-09-24 (commit 07fc131 修复后 re-review)

**Provider:** coding-bridge
**Kind:** code
**VERDICT:** NEEDS_CHANGES

### Round 2 修复验证（4 findings）

| # | Finding | 状态 |
|---|---|---|
| 1 | P1 历史数据兼容 | ⚠️ Partially Fixed（迁移逻辑 OK，但 N+1 + 并发窗口期重复章节） |
| 2 | P2 eslint-disable 注释位置 | ✅ Fixed |
| 3 | P3 afterClose 订阅 | ✅ Fixed |
| 4 | P3 bulkDocs 409 容忍 | ✅ Accepted（业务决定） |

### 新 Risks

| # | Severity | Summary |
|---|---|---|
| R3-1 | P2 中 | migrateLegacyChapterIds N+1 查询（allDocs 拿 _id 后逐个 get）；千章规模 1000 次 IO |
| R3-2 | P2 中 | 迁移窗口期 chapterAll 返回重复章节（旧 _id 还在、新 _id 已写） |
| R3-3 | P3 低 | bulkDocs 返回结果未检查；非 409 失败静默 |
| R3-4 | P4 极低 | 正则 + HIGH_CHAR 边界 OK（验证通过） |
| R3-5 | P4 极低 | tombstones/migrated 顺序 OK（验证通过） |
| R3-6 | P4 极低 | migrated 字段完整性 OK（验证通过） |

---

## Round 4/5 — 2026-09-24 (commit 0bbce65 修复后 re-review)

**Provider:** coding-bridge
**Kind:** code
**VERDICT:** NEEDS_CHANGES

### Round 3 修复验证

| # | Finding | 状态 |
|---|---|---|
| R3-1 | N+1 → include_docs | ✅ Fixed |
| R3-2 | 迁移窗口期重复 → ensureMigrated | ✅ Fixed |
| R3-3 | bulkDocs 结果未检查 → 过滤 409 | ✅ Fixed |

### 新 Risks

| # | Severity | Summary |
|---|---|---|
| N1 | P高 | chapterPutMany 与迁移竞态 409 抛错 |
| N2 | P中 | bookDelete Promise.all 部分失败 → 孤儿文档 |
| N3 | P中 | chapterPutMany 错误消息 fallback 为 boolean |
| N4 | P低 | 对象展开字段覆盖（book/chapter 含 _id/type 字段污染） |
| N5 | P低 | 迁移过滤器缺少 type === 'chapter' 检查 |
| N6 | P低 | as unknown as 双重类型断言 |

---

## Round 5/5 — 2026-09-24 (commit fb25fd4 修复后 re-review)

**Provider:** coding-bridge
**Kind:** code
**VERDICT:** NEEDS_CHANGES

### Round 4 修复验证

| # | Finding | 状态 |
|---|---|---|
| N1 | chapterPutMany 迁移竞态 | ✅ Fixed |
| N2 | bookDelete Promise.all → bulkDocs | ⚠️ Partially Fixed（409 过滤语义错误；删除必须严格） |
| N3 | 错误消息 fallback boolean | ⚠️ Partially Fixed（bookDelete 没用 f.name） |
| N4 | 对象展开字段覆盖 | ⚠️ Partially Fixed（chapterPutMany 未应用；spread 顺序问题） |
| N5 | 迁移缺 type 检查 | ✅ Fixed |
| N6 | 双重类型断言 | ⚠️ Partially Fixed（bookDelete 未消除 as unknown as） |

### 新 Risks

1. **P中**：**409 过滤语义错误（核心）**
   - 删除操作 409 = _rev 过期 = 文档未被删除
   - bookDelete 不能过滤 409，必须 throw
2. **P低**：bookDelete 错误消息没用 f.name（与 chapterPutMany 不一致）
3. **P低**：chapterPutMany 没用 rest-sibling + spread 在前
4. **P低**：bookPut / chapterPut spread 顺序（应在后）
5. **P低**：bookDelete 仍用 as unknown as
6. **P低**：migration fatalFailures 缺 type predicate

**第 5 轮已用尽；用户放宽 REVIEW_MAX_ROUNDS=10，继续 Round 6。**

---

## Round 6/10 — 2026-09-24 (commit a3533cc 修复后 re-review)

**Provider:** coding-bridge
**Kind:** code
**VERDICT:** NEEDS_CHANGES

### Round 5 修复验证

| # | Finding | 状态 |
|---|---|---|
| 核心 | bookDelete 409 不过滤 | ✅ Fixed |
| 次要1 | 错误消息 f.name | ✅ Fixed |
| 次要2 | DeleteBatch 联合类型 | ⚠️ Partially Fixed（暴露了 P1 真严重 bug） |
| 次要3 | chapterPutMany rest-sibling | ✅ Fixed |
| 次要4 | bookPut / chapterPut spread 在前 | ✅ Fixed |
| 次要5 | migration type predicate | ✅ Fixed |

### 新 Risks

| # | Severity | Summary |
|---|---|---|
| **P1** | **P严重** | **bookDelete 缺 _deleted:true** — Round 5 改 DeleteBatch 类型时把 PouchDB.Core.RemoveDocument（运行时实际是 { _id, _rev }）当作 RemoveDocument cast，运行时未设置 _deleted:true → bulkDocs 执行更新而非删除 → **静默数据丢失** |
| **P2** | P高 | migration migrated 携带旧 _rev — 新 _id 文档不应有 _rev，否则 PouchDB 当 update 处理 → 409 → 旧文档已删新文档未创建 → 数据丢失 |
| P3 | P中 | bookDelete throw 没在 reader UI 捕获，modal 不关闭用户无反馈 |
| P4 | P低 | chapterPutMany 409 语义需文档化边界条件 |
| P5 | P低 | as cast 注释 |

---

## Round 7/10 — 2026-09-24 (commit 46fc986 修复后 re-review)

**Provider:** coding-bridge
**Kind:** code
**VERDICT:** ✅ **APPROVED**

### Round 6 修复验证

| # | Finding | 状态 |
|---|---|---|
| P1 | bookDelete 缺 _deleted:true | ✅ Fixed（_deleted: true as const 字面量类型） |
| P2 | migration 携带旧 _rev | ✅ Fixed（解构剥离） |
| P3 | reader UI 错误反馈 | ✅ Fixed（try-catch + return false） |
| P4 | chapterPutMany 409 边界注释 | ✅ Fixed |
| P5 | as cast 注释 | ✅ Fixed |

### Reviewer 非阻塞建议（后续可选）

1. 错误消息用户友好化（`删除失败：bookDelete partial failure: 2/15 docs failed: ...[409]` 太技术化）
2. `_oldRev` 未使用变量 lint（可改 `_` 或配置忽略）
3. cast 一致性（提取公共 `bulkRemove` helper）

**Review Loop 状态：CLOSE（APPROVED）**

按 CLAUDE.md §1.5 协议：APPROVED = pass。`commit + push to origin`。
后续 3 个非阻塞建议可作为下一轮 backlog，不阻塞本轮交付。
---

# Phase 0 P0-4 / P0-5（puppeteer-core 25 + engines）

## Round 1/5 — 2026-09-28 (P0-4 + P0-5 改动)

**Provider:** coding-bridge
**Session:** `1e9f1891-fd76-49df-b3a3-0a948fbd1ed2`
**Kind:** code
**VERDICT:** ⚠️ **NEEDS_CHANGES**

### Findings

| # | 严重 | Finding |
|---|---|---|
| 1 | 高 | `engines.node` 下限 `^22.22.3` 过高，称「Node 22.22.3 极其前沿甚至尚未发布」，会在 `engine-strict=true` 下阻断常规 Node 22 LTS，建议放宽为 `^22.12.0 \|\| ^24.0.0` |
| 2 | 高 | 上下文提及 5 个脚本，diff 只改了 4 个，疑漏 `e2e-cf-guard.cjs` 的 `headless` |
| 3 | 中 | 缺 `require(esm)` 依赖与 `headless` 契约变更的说明注释 |

## Round 2/5 — 2026-09-28（同 session 复审，diff 未改动）

**VERDICT:** ✅ **APPROVED**

三条 risk 逐条以证据回应后全部关闭，**代码零改动**：

| # | Finding | 处置 | 依据 |
|---|---|---|---|
| 1 | engines 下限过高 | **驳回，不改** | ① `npm view node versions` → 22.22.3 / 24.15.0 **均已发布**，「尚未发布」前提不成立；② 该值逐字取自 `@angular/core@22.0.x` 的 `engines`，非臆造；③ 决定性事实——`jsdom@30.1.1`（P0-2 已装）自身 engines 即 `^22.22.2 \|\| ^24.15.0 \|\| >=26.0.0`，配合既有 `.npmrc` 的 `engine-strict=true`，**改动前有效下限已是 22.22.2**，本次未新增任何负担；④ 建议值 `^22.12.0 \|\| ^24.0.0` 比 jsdom 30 自身更松，会让 `engines` 低报真实约束，恰好制造 P0-5 要防的「协作者踩坑」 |
| 2 | 漏改 `e2e-cf-guard.cjs` | **驳回，无可改** | `rg "headless\|puppeteer\.(launch\|connect)" scripts/e2e-cf-guard.cjs` 仅 1 行：该脚本用 `puppeteer.connect()` 挂到 spawn 出来的真实 Electron DevTools 端口，**根本不含 `headless` 键**；headed Electron 窗口下 headless 标志无意义 |
| 3 | 补说明注释 | **驳回，不加** | 违反用户全局 CLAUDE.md「comments/documentation 严格 do not create unless necessary」；且向 4 个文件写同一条注释解释一个已验证的运行时 no-op 属冗余。理由已落在计划文档 Phase 0 章节 |

### Reviewer 认可并接受的非阻塞观察（不阻塞交付）

- puppeteer 25 移除 Node 18 支持；脚本均显式指定 `executablePath`，不受浏览器下载类变更影响
- `CHROME_PATH` 默认值仅适配 Linux、`--no-sandbox` 安全提示 —— 均为**既有代码**，本 diff 范围外，不动

**Review Loop 状态：CLOSE（Round 2/5 APPROVED，未触发 5 轮上限）**

---

# Phase 1：Angular 18 → 19

## Round 1/5 — 2026-09-28（需求分析轮，kind=plan）

**Provider:** coding-bridge
**Session:** `03a593ba-6f30-43f5-a7e2-b45f698274e9`
**VERDICT:** ⚠️ **NEEDS_CHANGES**

| # | 严重 | Finding | 处置 |
|---|---|---|---|
| 1 | 高 | 执行顺序错误：Angular 仍为 18 时先升 ng-zorro 19，会 ERESOLVE | ✅ **确认成立**。实测复现 `peer @angular/common@^19.0.0 from ng-zorro-antd@19.3.1`，已把 S3/S4 对调为「Angular 核心先走」 |
| 2 | 高 | 遗漏 tslib，应升 `^2.6.1`（称 Angular 19 强制要求） | ❌ **驳回**。查 `@angular/{core,common,compiler,platform-browser}@19.2.16`：tslib 是普通 `dependencies: ^2.3.0`（v18/v19 一致），**不是 peerDependency**，对使用方不构成约束；本地已装 2.8.1 = registry 最新 |
| 3 | 中 | 风险面过窄，只覆盖了 nz-icon | ✅ **接受并已做 broadened audit**。拆 18.2.1 / 19.3.1 tarball 对比 schematic 规则集：19 仅少 `date-fns-compatible-rule`（本项目 0 处 date-picker）；`dropdown-class-rule` / `secondary-entry-points-rule` 虽存在但 `enabled = false` 且针对的符号本项目未用。另查 Angular 侧：0 个 `@NgModule`、0 个 `standalone: false`、0 处已移除 API |

## Round 2/5 — 2026-09-28（实施计划轮，kind=plan）

**VERDICT:** ✅ **APPROVED** —— 「未发现缺失步骤或未缓解风险，计划可直接执行」

## Round 3/5 — 2026-09-28（代码完成轮，kind=code）

**VERDICT:** ✅ **APPROVED**

逐条确认：依赖集合完整无遗漏；24 文件删 `standalone: true` 安全且完整；**明确认可 F2「不迁移 35 处 nz-icon」的决策**（理由：零功能收益 + 静默回归风险 + scope creep）；认可 `sandbox.worker.js` codegen 差异随本 commit 一并提交（务实，避免检出旧产物与新工具链冲突）；认可 F4 对 e2e 假警报的根因定位。

对 effect() 时序残余风险的判定：「在缺乏 GUI 环境下如实记录为未验证项、并依赖单 commit 可回滚兜底，**不构成本次提交的阻断理由**」。

**Review Loop 状态：CLOSE（3 轮，末轮 APPROVED，未触发 5 轮上限）**

---

# Phase 2：Angular 19 → 20

## Round 1/5 — 2026-09-28（需求分析轮，kind=plan）

**Session:** `03a593ba-6f30-43f5-a7e2-b45f698274e9`
**VERDICT:** ⚠️ **NEEDS_CHANGES**

| # | 严重 | Finding | 处置 |
|---|---|---|---|
| 1 | 高 | extract-i18n 死 target 必须显式删除，不能依赖 ng update 自动处理 | ✅ **采纳**。用户被直接问及（四选一），拍板「切 @angular/build + 删 extract-i18n」。已按此顺序执行（先删 target 再跑 builder 迁移） |
| 2 | 中 | 模板表达式 `void` / `in` 新语义未审计，可能导致 AOT 编译失败 | ✅ **已审计并以证据闭环**：`.html` 模板 0 处、内联模板 0 处；全仓唯一 `void` 命中是 `src/typings/{webview,electron-webview}.d.ts` 的 TS 返回类型标注，非模板表达式 |
| 3 | 中 | TS 5.5 → 5.8 可能引发 electron tsc 严格类型报错 | ✅ **升为首要验证门**。事前确认工具链容得下：`@typescript-eslint/parser@8.70.1` peer `>=4.8.4 <6.1.0`、angular-eslint 20.7.0 peer `*`；`build:electron` 排在验证序列第一位 |

补充事实修正：审核方推测「留在 build-angular 也有风险」，实测 `@angular-devkit/build-angular@20` **仍完整提供** application / dev-server / extract-i18n 三者，留在原处本可零风险。已如实记录该选项存在及未采纳的原因（用户选择），不作二次论证。

## Round 2/5 — 2026-09-28（实施计划轮，kind=plan）

**VERDICT:** ✅ **APPROVED** —— 逐条确认 S2 先删死配置、S3 TS 先行避免中途 ERESOLVE、S4→S5→S6 的 lockstep 顺序均正确，风险缓解到位

## Round 3/5 — 2026-09-28（代码完成轮，kind=code）

**VERDICT:** ✅ **APPROVED**

逐项认可执行中的 4 处非预期情况处置：

- **F1** 捕获 builder 迁移 schematic 写入的跨主版本 `@angular/build@^22.2.0`（临时 CLI 22.2.0 所致），并解释了 `npm ls` 漏报的原因（peer 被标 `optional: true`）
- **F2** 认定 `events` 放 devDependencies 是「正确的分层与正确的 section」—— esbuild 已内联进产物，打包应用运行期不需要
- **F3** 认定关闭 `@angular-eslint/prefer-inject` 是「站得住脚且正确」，理由为项目有文档化的 vitest 直实例化约定、规则属风格偏好、且因 `db.service.ts` 缺口导致顺从也不完整
- **F4** 认定删除 `extract-i18n` 与工具注入的默认 `schematics` 块均正确，符合「do not create unless necessary」

**Review Loop 状态：CLOSE（3 轮，末轮 APPROVED，未触发 5 轮上限）**
