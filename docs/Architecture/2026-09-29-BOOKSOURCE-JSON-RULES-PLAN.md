# 书源 JSON 规则化改造方案 v2.1（评审修订稿）

> 状态：**v2.1 已过两轮评审** · 日期：2026-09-29
> 本稿为两方案合并结果：原稿（Mavis，2026-09-29）+ 对照分析稿。相对原稿的变更：
> 采纳原稿的 P0 盘点、差分测试、legacy 归档、guard 防线、valibot、过渡期运行时开关；
> 修正/补强：headers 字段保留、legado 骨架源迁移处理、cf-prompt/source-health 改挂、
> 迁移改主进程触发（消竞态）、schema 字段命名对齐现状、minDelayMs/encoding 移出 v1。
>
> **v2.1 评审修订**（两轮独立复核，逐条回代码验证后落地）：
> 1. §4.2 迁移判据「重新生成 + 逐字节比对」对 **legado 导入源 100% 失效**（模板头部重建不出
>    `@uuid`/`@type`/`legado-import` 标签），改为**结构白名单判定 + 显式归一化规则**
> 2. §3.2 修正 F6「已有等价实现」——存在两处**语义不等价**（`pickText` 正则分支不剥标签、
>    `cssRulesEnabled` 门的实际范围），必须逐函数对齐并进差分矩阵
>    ⚠️ **本条原写作「`cssRulesEnabled` 门只存在于 TS 侧」，该判断已被下方第 13 条推翻（实测证伪），以第 13 条为准**
> 3. §3.2/§6 多镜像 failover 降级为**v1 不做**（`tryMirrors` 零生产调用方且默认 500ms sleep）
> 4. P4 删除清单补 `tsconfig.app.json` / `eslint.config.js`（漏改直接 build 失败），
>    并明确 `source-meta.types.ts` / `cf-prompt` / `source-health` / `header-parser` 的迁出归属
> 5. `booksource-meta.ts` 明确保留（`electron/window-state.ts` 依赖 `atomicWrite`）
> 6. 迁移报告移出 `booksources/`（否则被 `scanJsonDir` 扫成幽灵书源）；新增 legacy 常驻扫描 channel
> 7. `BookSourceDocSchema` 移至 `core/models/`（渲染端从不 import `electron/`）
> 8. §7.1 补差分测试的**离线打桩**方案与 fixtures 脱敏口径
> 9. uuid 一致性提为 P3 硬验收；订正全部行数与字段数；R1 风险样例纠正
> 10. §11 跟进项编号 `F-n` → `T-n`（与 §2 事实基线 `Fn` 撞车）
> 11. **2026-09-28 导入导出设计文档的修订尚未完成**，本稿不再声称已同步（见 §10 待办）
> 12. 附录 A 明确「**无需改动**」清单（`rules-panel` / `SourceRules` 接口 / `electron/tsconfig.electron.json`
>     —— 后者 `exclude` 已含 `../src`，与 `sandbox.worker` 无关），避免实施时做无用 diff
> 13. **⚠️ 订正一处事实错误（本轮唯一 P0 自查）**：v2.0 稿「`cssRulesEnabled` 门只在 TS 侧、模板无此门 → 删门」
>     **不成立** —— `sandbox.service.ts:676-677` 在 `proxyQuery` 里对每个 CSS 选择器 `fail`，即**用户当前能观察到的
>     行为就是有门**（flag 定义自述为"运行时止血开关"）。删门会把存量 `pom.cssRules=0` 用户从"响亮失败"变成
>     "静默按 CSS 解析"，恰是 D9 明言要避免的。故 D9 / §1 非目标 / §3.2 对齐表 / §7.1 矩阵 / R1 五处口径
>     统一改为「**保留门 + 沿用同一报错文案**」，并把原 F6 拆为 F6（`pickText` 不剥标签）与 F6c（门的真实范围）
> 14. **§4.2 幂等口径去重**：删除末尾与前文冲突的第二段（`.js` mtime > `.json` mtime），全文收敛为
>     「`.json` 已存在且 `uuid` 相同则跳过」，并补上真正的幂等来源：**已处理文件已被移出扫描集（自然幂等）**
> 15. **`searchMethod` 必填矛盾 + `rules` 15/16 字段矛盾**：对照表把可选的 `searchMethod` 标成 ✅，与 F3
>     （7 必填 + 9 可选）冲突 → 改为「—（可选，缺省 `GET`，valibot 必须 `optional()` + default，不可设 required）」；
>     `rules` 注释由「15 字段」订正为「16 字段」，D2 同步写明「16 字段 = 15 常量 + `// @name`」
> 16. **needs-manual 的 marker 处置补齐**：marker 名带扩展名（`foo.js.enabled`；实测 `booksource-meta.ts:184-185`、
>     `booksource-handler.ts:137-138`），三条 needs-manual 分支补「**连带搬 marker 到 legacy**」——否则留无主 marker，
>     且回滚 JS 链路后该源恒为"未启用"
> 17. **uuid 回退命名空间**（自查新增）：现状回退是**带扩展名的文件名**，新建 JSON 源必须同构（`foo.json`）、
>     不得剥扩展名 —— 否则同一逻辑源迁移前后拿到两个 uuid，`Book.bookSourceUuid` 匹配不上且**不报错**（D6 硬验收的前提）
> 18. **`urls` 注释去歧义**（自查新增）：「顺序即轮询优先级」与 D7「v1 不做 failover」矛盾，改为明示
>     「v1 仅取 `[0]`，顺序原样保留仅为二期留位」
> 19. **R12 降级 + 行号订正**（自查新增）：`tsconfig.app.json:12-16` → `:12-15`；经 tsc 探针实测
>     **`include` 未命中不报错（exit=0，只有 `files` 缺文件才报错）**，R12 概率由「高」降「中」，
>     真正的 P4 build 阻断源是**残留 import**
> 20. **主进程迁移的开关作用域**（审查方提出）：§4.2 显式声明迁移**不受** `pom.bookSource.engine` 约束，
>     切回 `'js'` 后 legacy 标灰行依然可见（回滚不会让书源"消失"）
> 21. **⚠️ 方向订正（Round 3，P0）**：§3.2「引擎统一走 `PageFetcherService.fetchHtml`、不直接调
>     `booksourceHttpProxy`」**被证伪并推翻**。原理由"cf-prompt 钩子挂在 `FetchError('cf-challenge')` 上"与现状不符：
>     钩子是 `SandboxService.cfChallengeHook` **静态属性**（`sandbox.service.ts:129`，由 `:623` 依据响应
>     `cfChallenge` 标志触发），`FetchError` 只是错误码契约、**全仓无监听器**。改道引入两处实质回归：
>     ① **GET 丢自定义 headers**（`fetchHtml(url, encoding?)` 签名无 headers，`page-fetcher.service.ts:9-12,87`
>     ——与 F7/R10「headers 必须保留」正面冲突）；② **POST 丢 CF Tier 2 弹窗**（`fetchPost:159` 只 throw，
>     其 JSDoc `:145` 是失效承诺；现状 `proxyHttp` 对所有 method 统一弹窗）。**改回直连 `booksourceHttpProxy`**，
>     引擎判 `res.cfChallenge` 后直调 `CfPromptService.prompt`（等价于把 `sandbox.service.ts:623` 搬到引擎层），
>     附三处配套（`prompt` public 化 / `app.config.ts:37` 实例化理由改写 / cf-prompt spec 用例改造）
> 22. 架构图补「**两条通道共存**」说明（引擎走 http-proxy，内置适配器走 `PageFetcherService` 且零改动）；
>     §3.2 对齐表 `legado.http.*` 行、§5 cf-prompt 改挂条目、R9 三处同步改写
> 23. 附录 A 算术订正：迁出 **5** 文件（`source-meta.types` ×1 无 spec + `cf-prompt` ×2 + `source-health` ×2）
>     + 删 **2** 文件（`header-parser` + spec）→ 20 − 5 − 2 = **13**（原文写 12）
> 24. 行号小疵：F6 `:644`→`:645`（`:644` 实为其上一行 `RegExp.exec`）；F14 `:495-501`→`:494-500`
>     （`:494` 是 `// @name`）；F15 拆分引用 —— 版本漂移在 `BOOKSOURCE_GUIDE.md:13,34`、元组形态在 `:137`，
>     原写法把两个事实并挂 `:34,137` 易被误读成「`:137` 讲版本」（该行实际不含 `@version`）
> 25. §7.1 登记「**已知差异**」：`fetchHtml` 的 Tier 2 是**成功返回**语义（`:90-93` → `:122` 直接 `resolve(html)`），
>     沙箱链路是 **fire-and-forget**（`cf-prompt.service.ts:9-13`）—— 现状既有差异，v1 引擎不继承；
>     若未来要合并两条通道，必须先评估此条，不得默认"统一即更好"
>
> 目标：把「JS 文件作为书源」改为「JSON 规则作为书源」，消除代码生成 + 沙箱执行两层复杂度。

---

## 0. 决策摘要

| # | 决策点 | 结论 | 依据 |
|---|---|---|---|
| D1 | 手改 JS 逃生舱 | **保留文件（`booksources_legacy/`）、停止执行、可导出**，列表行内常驻降级提示 | 编辑器当前明确支持手改；静默删是功能回退；停止执行保证安全边界 |
| D2 | 规则表达能力 | **v1 严格等价**：`rules` = 现有 `SourceRules` 16 字段（对应 15 个规则常量 + `// @name`），不新增 DSL | 先等价替换并用差分测试证明；扩表达力是独立议题 |
| D3 | explore / 发现页 | **不做** | 现状两条路径都没有，不是本方案造成的回退 |
| D4 | 存量迁移 | **渲染端启动时迁移（`provideAppInitializer`，顺序由框架保证）+ convert channel 手动重触发**，`.js` 备份到 `booksources_legacy/` 永不删 | ⚠️ **Round 4 修订**（原选"主进程启动"）。主进程**无法** import `src/`：`build:electron` 是 `tsc -p electron/tsconfig.electron.json`，`rootDir` 锁死 `electron/`、`exclude: ["../src"]`（tsc 探针实证 `TS6059`），而迁移需要 `rule-migrate.ts` / `rule-parse.ts` 这两个**渲染端纯函数**。改用 `provideAppInitializer` 后顺序不再是"靠时序碰巧"，而是**框架级保证**：appInitializer 未 resolve 前 Angular 不 bootstrap，任何组件都无法先读列表 → 原竞态从根上消失，且纯函数保持单一来源、零构建改动 |
| D5 | 代码位置 | 新增 `src/app/core/book-source/json-rule/`；纯函数下沉 `core/logic/rule-parse.ts` | 与既有 `js-source/`、`legado/` 子域同构，registry/import 路径变动最小 |
| D6 | uuid 语义 | `Book.bookSourceUuid` 语义不变，迁移**必须保持 uuid 一致** | 该字段已落库（`import-via-source.service.ts`），uuid 变了所有已添加的书要重抓 |
| D7 | 等价边界 | `encoding` 新字段、`minDelayMs` 主链路强制限流、**多镜像 failover** **均移出 v1** | 现状 minDelayMs 仅镜像间限流、代理层固定 auto 编码；`tryMirrors` 零生产调用方（现状 `js-source.adapter.ts` 只取 `urls[0]`），接上即新增行为，违反等价原则 |
| D8 | 迁移判据 | **结构白名单判定**（非字节比对） | 模板头部写死 6 键、legado 导入走 `buildHeader` 整体重写（多出 `@uuid`/`@type`/`legado-import`），字节比对对主导入路径 100% 误判 |
| D9 | 规则引擎对齐 | TS 侧纯函数**按现状生产行为逐入口对齐后复用**（不是照搬模板文本，也不是照搬现状代码） | ① `pickText` 正则分支不剥标签，照搬会静默返回带标签文本；② `cssRulesEnabled` 门**现状两条链路都在**（F6c），照搬模板文本会丢掉止血开关 —— 两处都会把"响亮失败"变成"静默错结果" |

---

## 1. 目标与非目标

### 目标
1. 书源的唯一载体是 JSON 规则文档，新增/编辑/导入全链路不再产生 JS。
2. 移除「规则 → JS 代码生成」与「JS 沙箱执行」两层。
3. 规则可校验（valibot schema）、可 diff、可版本化。
4. 行为与今天**逐字段等价**（差分测试证明）。

### 非目标（明确不做）
- 不做书源市场 / 在线仓库。
- 不做 explore / 发现页。
- 不做规则之间的版本冲突合并。
- 不改 `Book` 模型（`bookSourceUuid` 语义不变）。
- 不把规则塞进 PouchDB —— 书源继续走文件（用户资产，可 Git 同步）。
- v1 不新增表达力：分页 / follow 跳转 / jsonpath / `responseType:'json'` / `encoding`（schema 留位，二期）。
- v1 不新增 `minDelayMs` 主链路强制限流（保持现状语义）。
- **v1 不做多镜像 failover**：保持现状语义（`urls[]` 仅取 `[0]` 构造 hostPattern，失败即失败）。`tryMirrors` 零生产调用方，且 `DEFAULT_MIN_DELAY_MS = 500` 会给每次抓取凭空插入 sleep —— 接上它属于新增行为，见 T-9。
- **v1 不删** `cssRulesEnabled` 止血开关：现状 JS 沙箱与 TS 侧**都**受它约束（F6c），删掉是用户可见行为变更。新引擎**沿用同一门 + 同一报错文案**（见 §3.2 对齐表），存量 `pom.cssRules=0` 用户升级后行为不变。

---

## 2. 现状事实基线

| # | 事实 | 证据 |
|---|---|---|
| F1 | JS 书源是**固定模板 + 数据常量**。用户能影响的只有 15 个**规则常量**（模板内 `const` 实为 19 个：15 规则常量 + `BASE_URL`/`HEADERS`/`REGEX_HINT_CHARS`/`MAX_EXTRACT_LINKS`） | `smart-rules.ts:502-520,523,539`；四个入口函数为写死代码 |
| F2 | 宿主 API 只有两个：`legado.http.{get,post,request}` + `legado.query` | `sandbox.worker.ts:266-295` 注入的 shim |
| F3 | 规则已经是结构化数据（`SourceRules` = **16 字段 = 7 必填 + 9 可选**，零 JS 表达式） | `smart-rules.ts:60-105` |
| F4 | 规则与代码之间现在是**双向文本正则转换** | `book-source-editor.component.ts:119-181`（反解析）、`:240-251`（回写） |
| F5 | legado 翻译器**已拒绝**所有不可数据化的特性（`jsLib`/`login*`/`cookieJar`/`<js>`/`{{}}`/`$.jsonpath`） | `legado-translator.ts` |
| F6 | ⚠️ TS 侧有**近似**实现，`pickText` 正则分支**不剥标签**（模板 `extractText` 剥标签）—— 照搬会静默返回带标签文本 | `smart-rules.ts:167` vs `:645`（`:645` = 模板 `stripTags(m[1])`；`:644` 是其上一行的 `RegExp.exec`） |
| F6c | ⚠️ **\`cssRulesEnabled\` 止血开关不只在 TS 侧，现状两条链路都受它约束**：① JS 沙箱 \`proxyQuery\` 对每个 \`legado.query\` 选择器做门禁（flag=0 直接 \`fail\`）；② TS 侧 \`pickText/pickHtml\` 内部也判门（\`rules-panel\` 预览直连该函数） | \`sandbox.service.ts:676-677\`；\`smart-rules.ts:162,173,184,275\`；flag 定义 \`smart-rules.ts:22-28\`（注释自述"运行时止血开关"） |
| F6b | TS 侧现成可复用的纯函数清单：`stripTags`/`absUrl`/`buildFormBody`/`applyContentReplaceRules`/`matchLinkItems`/`extractItemContexts`（前四者与模板语义等价） | `smart-rules.ts:120-454` |
| F7 | legado 自定义请求头以 `HEADERS` 常量**烘焙进生成代码**（editor 的反解析**不含** HEADERS，需新写） | `smart-rules.ts:503`（`:700-749` 全部请求携带）；`book-source-editor.component.ts:119-181` 只抽 `BASE_URL` + 15 规则常量 |
| F8 | legado 导入失败产出**骨架源**（stub 函数抛错 + 注释内嵌原始 JSON，`@enabled false`） | `legado-translator.ts` makeSkeleton |
| F9 | `minDelayMs` 仅被解析进 meta + 用于 multi-mirror 限流，**主抓取链路未强制执行** | 全仓 grep：仅 header-parser / multi-mirror / spec 引用 |
| F10 | `enableJsSource` 是编译期常量、仅 registry 一个消费点，调试/测试/健康页直连 SandboxService 绕过 —— **实际关不掉 JS 链路** | `feature-flag.ts`、`book-source.registry.ts:67` |
| F11 | 调试页订阅 `sandbox.progress` 做进度日志 | `book-source-debug.component.ts` |
| F12 | 已有 `electron/ipc/schema.ts`（valibot + safeHandleWithMeta）与 `core/logic/`（纯函数目录） | 仓库实查 |
| F13 | 待实施的导入导出设计（2026-09-28）假设书源是 `.js`，`content` 内嵌 JS 全文、`enabled` 单独携带 —— **该文档尚未按本方案修订**（仍写 `.js` 全文契约 + 依赖 `parseHeaderMeta`），修订工作量未计入 P0-P4 任何一档 | `docs/Architecture/2026-09-28-BOOKSOURCE_IMPORT_EXPORT_DESIGN.md` |
| F14 | 模板头部写死 6 键（`@version 1.2.0`/`@author 智能添加`/`@url`/`@enabled`/`@tags 智能识别`/`@description`），**不输出** `@uuid`/`@type`/`@logo`/`@require`；而 legado 导入走 `buildHeader` 整体重写头部 → **字节比对对 legado 导入源 100% 失败** | 头部块 `smart-rules.ts:494-500`（`:494` 是 `// @name`，`:495-500` 即上述 6 键）；对比 `legado-translator.ts:285-320` |
| F15 | 模板版本存在历史漂移：模板硬编码 `@version 1.2.0`（`smart-rules.ts:495`），而 `BOOKSOURCE_GUIDE.md` 文档写 `@version 1.0.0`（`:34` 字段表 + `:13` 示例）；且 `SEARCH_BODY_PARAMS`/`CONTENT_REPLACE_RULES` 早期为元组形态（破坏性变更记录在 `BOOKSOURCE_GUIDE.md:137`，该行**不含** `@version`，勿混引） | `smart-rules.ts:495`；`BOOKSOURCE_GUIDE.md:13,34`（版本漂移）/ `:137`（元组形态） |
| F16 | `parseHeaderMeta` 存在**两份语义不同的实现**：主进程（`electron/ipc/booksource-meta.ts:51`）扫全部行、返回 `Record<string, unknown>`、`name` 回退 `fileName.replace(/\.js$/i,'')`；渲染端（`js-source/header-parser.ts:59`）只扫前 100 行、返回强类型、`enabled` 判定函数不同 | 两处同名函数 |
| F17 | 差分测试**可离线**：worker 协议支持 `http-result`/`query-result` 入站打桩，spec 已有 FakeWorker 现成模式 | `sandbox.worker.ts:210,216`；`sandbox.spec.ts:760` |

**推论**：把模板里的约 200 行 JS 搬成 TS（F6 已有参照），即可得到与今天行为等价的规则引擎。这不是"重新实现书源系统"，而是"把已有逻辑换个宿主"。

---

## 3. 目标架构

```
                      ┌──────────────────────────────────────┐
  智能添加 / 编辑器   │  BookSourceDoc (JSON, valibot 校验)   │
  legado 导入          │  ─ meta（原 // @key 头）             │
        │             │  ─ headers（原 HEADERS 常量, F7）     │
        │             │  ─ rules（15 常量,字段名沿用）        │
        └────────────▶└───────────────┬──────────────────────┘
                                       │  文件：booksources/*.json
                          ┌────────────▼────────────┐
                          │  JsonRuleAdapter        │  实现 BookSourceAdapter
                          │  （match/fetchCatalog/  │  + duck-typed search()
                          │    fetchChapter/search）│  + meta.uuid
                          └────────────┬────────────┘
                                       │
                    ┌──────────────────┴───────────────────┐
                    │  RuleEngine (book-source/json-rule/)  │
                    │  engine.ts · guard.ts                 │
                    │  + 复用 smart-rules.ts 提取纯函数      │
                    └──────────────────┬───────────────────┘
                                       │
        ┌──────────────────────────────┴──────────────────────────────┐
        │ booksourceHttpProxy IPC（SSRF + 15s + CF）  /  PageFetcher  │
        │ DOMParser（主线程，不执行脚本）                            │
        └─────────────────────────────────────────────────────────────┘
```

> **两条 HTTP 通道共存**（Round 3 订正）：**引擎 → `booksourceHttpProxy`**（与现状沙箱同源，支持自定义
> method/headers/body + Tier 1/Tier 2）；**内置规则适配器 → `PageFetcherService`**（零改动）。详见 §3.2。

### 3.1 数据模型

新文件 `src/app/core/models/book-source-doc.model.ts`，valibot schema 同文件导出（`BookSourceDocSchema`）。
⚠️ **不放 `electron/ipc/schema.ts`**：渲染端 `rule-engine.service.ts` 要做 valibot parse，而渲染端从不 import `electron/`（`tsconfig.app.json` 的 `types` 为空）——跨边界不可达。`electron/ipc/schema.ts` 只保留 IPC 入参 schema。

```ts
export interface BookSourceDoc {
  /** 固定标记 'pomreader.booksource'（导入导出/文件识别用） */
  format: 'pomreader.booksource';
  /** schema 版本；将来改结构时靠它做迁移分支（v1 恒为 1） */
  schemaVersion: 1;
  /** 书源唯一 id —— 迁移时必须沿用历史 .js 的 @uuid（缺省回退 fileName，与现状一致），
   *  Book.bookSourceUuid 指向它；字段名保持 uuid 不改（extractMetaUuid 链路零改）。
   *  ⚠️ 回退值的命名空间必须与现状同构（D6 硬验收的前提）：现状 `parseHeaderMeta` 的实现是
   *  `const finalUuid = uuid || fileName`（`booksource-meta.ts:142`）—— 回退成**带扩展名的文件名**（`foo.js`），
   *  且同一值同时写入 `sourceKey` 与 `uuid`（`:147-148`），新文档这两个概念也须同源。
   *  ⚠️ **别引错行**：紧邻的 `name` 回退（`:150`）语义**恰好相反** —— 它**剥掉** `.js`
   *  （`fileName.replace(/\.js$/i, '')`）。**uuid 不剥、name 剥，两者不可互相佐证**。
   *  新建 JSON 源的 uuid 同样回退为**带扩展名的文件名**（`foo.json`），不得剥扩展名，
   *  否则同一逻辑源迁移前后拿到两个 uuid，`Book.bookSourceUuid` 匹配不上（且不会报错，只会静默换源失败）。
   *  `parseJsonMeta` 须同时复刻这两条相反规则：uuid 带扩展名 / name 剥扩展名（§4.2） */
  uuid: string;
  name: string;
  author?: string;
  logo?: string;
  description?: string;
  /** 主站 origin（原 BASE_URL / @url 第一条） */
  homepage: string;
  /** 多镜像（原多条 @url）；v1 仅取 [0] 构造 hostPattern，**不做 failover**（D7），
   *  顺序原样保留仅为二期留位 —— 不要按"轮询优先级"实现，那等于偷偷引入 v1 未做的行为 */
  urls: string[];
  enabled: boolean;              // 原 .enabled/.disabled marker 文件内联进文档
  sourceType: SourceType;        // novel/comic/video/music/webpage
  /** 原 @version；命名避开与 schemaVersion 撞车 */
  sourceVersion?: string;
  updateUrl?: string;
  tags: string[];
  minDelayMs: number;            // 默认 0；v1 仅镜像间限流（F9）
  requireUrls: string[];         // 前置依赖源（原 @require）
  /** 自定义请求头（legado header 导入产物，原 HEADERS 常量, F7） */
  headers: Record<string, string>;
  rules: SourceRules;            // 16 字段原样平移（7 必填 + 9 可选，F3），字段名一字不改
  /** 可选：legado 骨架源内嵌原始 JSON（F8） */
  legadoRaw?: string;
}
```

**`rules` 直接复用 `SourceRules`（F3，16 字段），字段名一字不改** —— 刻意的：转换层越薄越好，`rules-panel`（443 ts + 322 html）与 `buildRules`/`detect*` 全部原样复用。

字段 ↔ 常量对照（迁移转换表）：

| JSON `rules.*` | 旧 JS 常量 | 必填 |
|---|---|---|
| `siteName` | `// @name` | ✅ |
| `searchPath` | `SEARCH_PATH` | ✅ |
| `searchMethod` | `SEARCH_METHOD` | —（可选，缺省 `GET`；valibot 必须 `optional()` + default，**不可设 required**） |
| `searchBodyParams` | `SEARCH_BODY_PARAMS` | — |
| `searchContentType` | `SEARCH_CONTENT_TYPE` | — |
| `searchRawBody` | `SEARCH_RAW_BODY` | — |
| `searchItemPattern` | `SEARCH_ITEM_RULE` | ✅ |
| `searchAuthorPattern` | `SEARCH_AUTHOR_RULE` | — |
| `searchCategoryPattern` | `SEARCH_CATEGORY_RULE` | — |
| `bookTitlePattern` | `BOOK_TITLE_RULE` | ✅ |
| `bookAuthorPattern` | `BOOK_AUTHOR_RULE` | ✅ |
| `chapterItemPattern` | `CHAPTER_ITEM_RULE` | ✅ |
| `contentPattern` | `CONTENT_RULE` | ✅ |
| `contentReplaceRules` | `CONTENT_REPLACE_RULES` | — |
| `bookCategoryPattern` | `BOOK_CATEGORY_RULE` | — |
| `coverUrlPattern` | `COVER_RULE` | — |
| （`homepage`） | `BASE_URL` | ✅ |
| （`headers`） | `HEADERS` | — |

meta 头 → JSON 字段：`@name/@author/@logo/@description/@url(多条)/@enabled/@type/@version(→sourceVersion)/@updateUrl/@tags/@minDelayMs/@require(多条)/@uuid` 全部一对一（解析规则见 `booksource-meta.ts`）。

**文件布局**
```
<userData>/booksources/<name>.json          # 新的唯一载体（规则 + meta 合一）
<userData>/booksources_legacy/*.js          # 迁移后的原始 JS 备份（只读，永不执行，永不删）
<userData>/booksources_drafts/*.json        # 草稿（原 .js 草稿同步换格式）
```

### 3.2 规则引擎

新目录 `src/app/core/book-source/json-rule/`：

| 文件 | 职责 | 复用来源 |
|---|---|---|
| `engine.ts` | 四个入口 `search/bookInfo/chapterList/chapterContent`，语义与 JS 模板逐字对齐 | `smart-rules.ts` 生成代码段 |
| `guard.ts` | 执行预算、正则安全、结果裁剪（新增，无沙箱兜底） | 新增（见下） |
| `json-rule.adapter.ts` | 实现 `BookSourceAdapter` + duck-typed `search()`，含 `pickString` 兼容链与 `meta.uuid` | `js-source.adapter.ts` 整体 |
| `rule-engine.service.ts` | 读 JSON（booksourceRead IPC）→ valibot parse → 执行四入口；收集 RuleTrace；供调试/测试/健康检测共用 | 替代 SandboxService 的三个消费点 |
| `core/logic/rule-parse.ts` | 旧 JS 常量 → SourceRules（从 editor 抽出共用） | `book-source-editor.component.ts:119-181` |

提取/后处理复用 `smart-rules.ts` 的纯函数（F6b），但**必须按下表逐个对齐到模板语义**（D9/F6）：

| 模板函数 | TS 落点 | 对齐要求 |
|---|---|---|
| `isCssRule` | `pattern.isCssRule` | 直接复用（同一套 `REGEX_HINT_CHARS`） |
| `stripTags` / `absUrl` / `buildFormBody` / `applyContentReplaceRules` / `matchLinkItems` / `extractItemContexts` | 同名 TS 函数 | **逐字等价，可直接复用**（已核对） |
| `extractText`（单值文本） | **不能直接用 `pickText`** | 模板正则分支 `stripTags(m[1])`，`pickText` 正则分支**不剥标签** → 新引擎需新增 `pickTextStripped`，或给 `pickText` 加开关并在 bookInfo/搜索条目路径统一走它 |
| `extractHtml` | `pickHtml` | 直接复用 |
| `extractAttr` | `pickAttr` | ⚠️ JSDoc 说"返回绝对化后的 URL"但两个分支都没调 `absUrl`——**以实现为准**，并与模板 `bookInfo` 里的 `absUrl(cover, bookUrl)` 显式对齐 |
| CSS 模式开关 | **沿用 `cssRulesEnabled()`，flag=0 时显式 `fail`（文案照搬现状）** | ⚠️ v2.0 稿误判"该门只存在于 TS 侧、模板无此门 → 删门"，Round 1 订正：现状 `sandbox.service.ts:676-677` 在 `proxyQuery` 里对每个 CSS 选择器 `fail('CSS 规则已禁用…')`，**用户当前能观察到的行为就是有门**。删门 = 存量 `pom.cssRules=0` 用户从"响亮失败"变"静默按 CSS 解析"，正是 D9 要避免的。`rules-panel` 预览直连 `pickText`（§5 标零改动），门天然仍在 → 引擎与预览同源，无分叉 |
| `legado.query` | `dom.queryFirst/queryAll` | 搬 `sandbox.service.ts:670-731` 的 DOMParser 逻辑 + 5MB 上限（`QUERY_HTML_LIMIT`） |
| `legado.http.*` | `http.*`（走 `booksourceHttpProxy`） | 见下方「HTTP 链路」节 —— 直连 preload 代理，**不经过 `PageFetcherService`**（Round 3 订正） |

DOM 走主线程 DOMParser（不执行脚本/不加载资源，5MB 上限沿用 `QUERY_HTML_LIMIT`）。

**HTTP 链路：与现状完全同源（Round 3 方向订正 —— v2.1 的「改走 PageFetcherService」已被证伪并推翻）**

引擎**直连 preload 的 `booksourceHttpProxy`**（声明见 `page-fetcher.service.ts:24-34`：
`{url, method?, headers?, body?}` → `{status, headers, body, cfChallenge?}`），与 `SandboxService.proxyHttp`
（`sandbox.service.ts:615-636`）**同一条通道**；**不走** `PageFetcherService.fetchHtml`。

⚠️ **v2.1 原方案的理由是错的（Round 3 逐条证伪）**。原文称"cf-prompt 的钩子挂在 `FetchError('cf-challenge')` 上，
只有 `PageFetcherService` 才会把主进程的 `cfChallenge` 翻译成这个错误"。实测：
- 钩子**不在 `FetchError` 上**，而是 `SandboxService` 的**静态属性** `cfChallengeHook`（`sandbox.service.ts:129`），
  由 `proxyHttp` 依据响应里的 `cfChallenge` 标志位触发（`sandbox.service.ts:623`）；全仓**唯一**注册方是
  `cf-prompt.service.ts:25` 的构造函数（`app.config.ts:37` 为此在启动时实例化）。`FetchError` 只是一个错误码契约，
  **没有任何监听器挂在它上面**。
- 改走 `PageFetcherService` 会引入**两处实质回归**：
  1. **GET 丢自定义请求头** —— `fetchHtml(url, encoding?)` 签名里**没有 headers 参数**
     （`page-fetcher.service.ts:9-12` 声明、`:87` 实现），而 F7/R10 要求保留 legado 的 `headers`。
     带自定义头的源升级后请求头静默丢失 —— **与方案自身「headers 必须保留」正面冲突**。
  2. **POST 丢 CF Tier 2 人工过盾** —— `fetchPost` 遇 `res.cfChallenge` 只
     `throw new FetchError('cf-challenge')`（`page-fetcher.service.ts:159`），**不弹窗**；其 JSDoc（`:145`）
     自称"失败时同样弹 Tier 2 CF 引导"，但既然无 FetchError 监听器，**该注释是失效承诺**（可顺手订正）。
     现状 `proxyHttp` 对**所有 method 统一处理**，POST 搜索遇交互式 Turnstile 一样会弹窗 → 改道后该场景行为回退。

**CF Tier 2 的正确接法**：引擎在 `booksourceHttpProxy` 返回后判 `res.cfChallenge` → 直接调用迁出后的
`CfPromptService` 弹窗引导。**语义与现状逐字等价**（fire-and-forget、不阻塞本次抓取回执、每 host 每次会话最多一次），
实现上等价于把 `sandbox.service.ts:623` 那一行原样搬到引擎层。
配套改动（三处，均已核对现状）：

| # | 改动 | 依据 |
|---|---|---|
| a | `CfPromptService.prompt(url)` 现为 `private`（`cf-prompt.service.ts:28`）→ 提升为 `public`（或新增 public `notifyCfChallenge(url)`）供引擎调用 | 现状只经静态钩点间接调用，无外部调用方 |
| b | `app.config.ts:37` 启动实例化 `CfPromptService` 的注释理由（"构造函数向 SandboxService 注册 cfChallengeHook"）改写为"引擎在 CF 命中时直接调用" | 钩点随沙箱消亡 |
| c | **不保留** `SandboxService.cfChallengeHook` 静态属性，随 P4 沙箱删除；`cf-prompt.service.spec.ts` 的注册用例（`:75-79`）改为验证 public 方法 | 避免留下无人消费的钩子 |

SSRF / 15s 超时 / cookie 共享由主进程 `safeNetRequest` 统一提供，与现状同，无需额外设计。

> **不需要复制 `PageFetcherService` 的 `inZone` 包装**（`page-fetcher.service.ts:78-85`）：本项目已是 zoneless
> （`app.config.ts:51` `provideZonelessChangeDetection()`），`NgZone.run()` 在该模式下不调度变更检测，
> 这段包装是 zone.js 时代的遗留（`zone.js` 虽仍在 `package.json:81`，但不参与 CD）。
> **现状佐证**：`SandboxService.proxyHttp` 全程不含 `NgZone`/`inZone`（该文件零命中），在同一个 zoneless 应用里
> 正常工作 —— 引擎走同一条通道，不复制它也不会丢变更检测。
> **前提**：`RuleEngineService` 与 `SandboxService` 同模式，用 signal / Observable 暴露结果。

> **两条通道共存是预期结果**：**引擎 → `booksourceHttpProxy`**（书源自定义 method/headers/body + 与沙箱同款 CF 语义）；
> **内置规则适配器 → `PageFetcherService`**（`registry` / `import-via-source` / `rules-panel` / smart-add，**零改动**）——
> 内置适配器要的是"取 HTML"语义，引擎要的是"任意 method + 自定义头 + 沙箱同款失败语义"，两者本就不该合并。

每次调用重新读文件 + parse（保留「改完立即生效」的 dev 体验，与 `JsSourceAdapter.ensureLoaded` 语义一致）。

**`guard.ts` 硬性上限（新增，因为没有沙箱兜底）**

| 约束 | 值 | 理由 |
|---|---|---|
| 规则串长度 | ≤ 512 字符 | 现有规则都是几十字符级；超长多为误填 |
| 正则静态风险检查 | 拒绝嵌套量词（`(a+)+` / `(a*)*` / `(a|a)+` 形态） | 灾难性回溯在主线程**无法中断**，只能事前拦 |
| 单次源执行预算 | 15s（与现有 `call` 超时一致） | 对齐现状 |
| 单页 HTML | ≤ 5MB | 沿用沙箱现状 |
| 搜索结果条数 | ≤ 100 | 沿用 `JsSourceAdapter.MAX_SEARCH_RESULTS` |
| 章节数 | ≤ 20000 | 防畸形源 |
| 单章正文 | ≤ 2MB | 防内存爆炸 |
| 提取结果对象 | 字段白名单 + `Object.create(null)` | **替代**沙箱里的原型冻结 |

**RuleTrace**（调试页数据源，替代 `sandbox.progress`，F11）：阶段 / 请求 URL+method / HTTP 状态 / 命中规则 / 提取条数 / 耗时。

> **已知取舍（v1 明确接受）**：引擎跑在主线程，`DOMParser` 不执行脚本本身安全；唯一不可中断的环节是正则回溯，靠静态检查 + 长度上限兜。判据：若上线后出现 UI 卡顿报告或书源库出现 ReDoS 源，再上 P1.5（正则部分移进 Web Worker，可 terminate 强杀）。

### 3.3 运行时开关与装配（过渡期，P4 删除）

**必须先修 F10**：`feature-flag.ts` 现在是编译期常量、只在一个地方判定，6 个书源页面完全绕过它 —— 现状下根本关不掉 JS 链路。改造：

```
src/app/core/book-source/feature-flag.ts
  编译期常量 enableJsSource  →  运行时开关
  localStorage 'pom.bookSource.engine' = 'rule' | 'js' | 'both'   默认 'rule'
  + BookSourceEngineSwitch（书源页顶栏一个分段控件，调试用）
```

`registry` 增加 `registerRuleAdapters(docList)`，与 `loadAllJsAdapters(sandbox)` 并列；优先级 `JSON > JS > 内置适配器`，同 uuid 时 JSON 胜出（迁移后天然如此）。**P4 删 JS 链路时开关一并删除。**

### 3.4 存储与 IPC

改造 `electron/ipc/booksource-handler.ts` + `booksource-meta.ts`：

| 现状 | 目标 |
|---|---|
| `scanDir` 只收 `.js` | 新增 `scanJsonDir` 收 `.json`（旧 `.js` 仅迁移期读）；valibot parse 失败置 `rulesInvalid` 原因字段 |
| `parseHeaderMeta`（`// @key`） | 迁移期保留（读旧文件用），P4 删 |
| marker 文件表示启停 | JSON 内 `enabled` 字段；toggle = 读改写（atomicWrite）；迁移时 marker 仍覆盖一次后删除 |
| `safeFileName` | 追加 `.json` 后缀约束 + 禁止控制字符 |
| IPC 无统一校验 | `BookSourceDocSchema`（**定义在 `core/models/`**，见 §3.1）+ IPC 入参 schema 补进 `electron/ipc/schema.ts`，channel 全部过校验，**先 passthrough 观测再收紧**（R5） |
| **本文件不能整体删除** | `electron/window-state.ts:12` 从本文件 import `atomicWrite`（窗口位置/尺寸持久化在用）→ P4 只删 `parseHeaderMeta` / `scanDir` / `.js` 分支，**保留 `safeFileName` + `atomicWrite`** |
| 迁移报告落盘位置 | 报告写 `<userData>/booksource-migration-report.json`（**在 `booksources/` 之外**）——放目录内会被 `scanJsonDir` 按 `.json` 扫成幽灵书源 |

新增 3 个 channel：`pom:booksource-convert`（渲染端 `provideAppInitializer` 与手动重触发共用；**逻辑在渲染端**，主进程只做原子写与文件移动）、`pom:booksource-migration-report`（读一次性迁移报告，读后删）、`pom:booksource-legacy-list`（**常驻**扫描 `booksources_legacy/`，支撑 §4.3 的 needs-manual 行内状态；报告读后删无法支撑常驻列表）。
删除：`pom:booksource-eval` 及 preload `booksourceEval`/`sourceHealthCheck`（沙箱时代遗物，健康检测改渲染端完成后不再需要）。

---

## 4. 存量迁移

### 4.1 P0 盘点（先做这个，再定 D1 细部形态）

只读扫描脚本 `scripts/audit-booksources.ts`，输出报告：
1. 源总数、启用数、字段完整度（15 常量各有多少源缺失）
2. **手改检测**：文件里 15 常量 + 模板函数之外是否还有自定义语句（白名单外标识符扫描）
3. 特殊模式命中：嵌套量词、`{{`、`$.jsonpath`、超长规则串、骨架源数量
4. `Book.bookSourceUuid` 引用统计（哪些 uuid 被已添加的书引用）

输出决定 D1 细部：手改比例 <5% → 停用归档即可；≥5% → 加强 needs-manual 行内 UI 打磨。

### 4.2 迁移算法

**触发时机**：**渲染端** `provideAppInitializer` 中 `await` 执行（app shell 启动、任何页面能读列表之前）。主进程只提供 IO channel（读 `.js` / 写 `.json` / 移动文件），**不含任何规则逻辑**。

> ⚠️ **Round 4 修订：宿主从主进程改为渲染端。** 原方案选主进程是为消除"列表先于迁移被读"的竞态，但那条路**在当前构建下走不通**：
> `build:electron` 用 `tsc -p electron/tsconfig.electron.json`（`rootDir: "."` = `electron/`、`exclude: ["../src"]`），
> 主进程 import `src/` 下的 `rule-migrate.ts` / `rule-parse.ts` 会直接报
> `TS6059: File ... is not under 'rootDir'`（已用探针文件实证并清理）。
> **且不止报错**：一旦 electron 工程拉入 `src/` 下的文件，tsc 会在报错的同时**无视 `--noEmit`、把该文件就地
> 输出到 `src/` 原位**（实测：单跑 `tsc -p electron/tsconfig.electron.json --noEmit` 即在
> `src/app/core/book-source/smart-add/` 生成 `smart-rules.js` + `.js.map`）。这两个产物**不在 `.gitignore`**，
> 会被误提交。→ 任何人**不要在 `electron/` 里写 import `src/` 的代码**；本条正是 D4 选渲染端的直接依据。
>
> 改用 `provideAppInitializer` 后，**竞态的消除方式从"靠时序碰巧"升级为"框架级保证"**：
> Angular 在 appInitializer 的 Promise resolve 前不 bootstrap，因此**任何组件都不可能先于迁移完成而读取列表** ——
> 原方案担心的问题并未被绕过，而是被架构消除。
> 代价：首次升级启动多等一个 IPC 往返（一次性），可接受。
> 连带修订：`electron/main.ts` 不再挂接迁移；`electron/ipc/booksource-migrate.ts` 退化为纯 IO（无规则逻辑）。

失败只告警不阻断启动（appInitializer 用 `catch` 兜住，不 reject）。
⚠️ **迁移不受 `pom.bookSource.engine` 开关约束（预期行为，不是 bug）**：该开关只作用于渲染端的 adapter 选择（§3.3），而 `booksources_legacy/` 的产出是**一次性文件级转换**。切回 `'js'` 后 legacy 目录依然存在，needs-manual 源仍会在列表里标灰可见（§4.3）—— 回滚 JS 链路的用户看到的是「多了一批标灰行」，不是「书源消失」。

**meta 解析用哪一份**：一律用**主进程**的 `parseHeaderMeta`（`electron/ipc/booksource-meta.ts:51`，扫全部行）。不用渲染端 `header-parser.ts` 那份（只扫前 100 行、`enabled` 判定不同，F16）。
⚠️ 其回退规则有**两条方向相反**的，`parseJsonMeta` 必须分别复刻（别照抄错行）：

| 字段 | 现状实现 | 位置 | 对新 `.json` 的要求 |
|---|---|---|---|
| `uuid` / `sourceKey` | `uuid \|\| fileName` —— **不剥**扩展名（`foo.js`） | `:142`（写入 `:147-148`） | 回退为**带扩展名**的文件名（`foo.json`） |
| `name` | `name \|\| fileName.replace(/\.js$/i, '')` —— **剥掉** `.js` | `:150` | 剥除后缀需换成 `.json`（`fileName.replace(/\.json$/i, '')`） |

迁移读的是 `.js` 故现有分支无碍；`uuid` 那条是 D6 硬验收的前提（错则静默换源失败，见 §3.1）。

**手改检测：结构白名单，禁用字节比对（D8/F14/F15）**

```ts
// 白名单：模板固定语句的形态（函数名取自 smart-rules.ts 生成代码段）
WHITELIST_FUNCTIONS = new Set([
  'isCssRule','ruleSelector','stripTags','absUrl','matchAll','extractLinks',
  'extractSearchItems','searchExtraRules','extractText','extractHtml','extractAttr',
  'buildFormBody','search','bookInfo','chapterList','chapterContent',
]);
WHITELIST_CONSTS = new Set([
  'BASE_URL','HEADERS','REGEX_HINT_CHARS','MAX_EXTRACT_LINKS',
  'SEARCH_PATH','SEARCH_METHOD','SEARCH_BODY_PARAMS','SEARCH_CONTENT_TYPE',
  'SEARCH_RAW_BODY','SEARCH_ITEM_RULE','SEARCH_AUTHOR_RULE','SEARCH_CATEGORY_RULE',
  'BOOK_TITLE_RULE','BOOK_AUTHOR_RULE','CHAPTER_ITEM_RULE','CONTENT_RULE',
  'CONTENT_REPLACE_RULES','BOOK_CATEGORY_RULE','COVER_RULE',
]);

isPureTemplate(source: string): boolean {
  // 1) 剥离头部注释块（连续 // 行）——头部元数据一律以 parseHeaderMeta 为准，不参与比对（F14）
  // 2) 逐语句扫描剩余代码：function 声明名 / const 声明名 必须命中白名单；
  //    出现任何其他标识符声明、赋值表达式、额外 await、注释掉的代码块 → 判手改
  // 3) 不做逐字节比对：模板版本漂移（F15）与 legit 的头部差异都会被误伤
}
```

**流程**

```
for each <userData>/booksources/*.js:
    meta ← parseHeaderMeta(content)                       // 主进程版（F16）
    if 头缺少 @uuid: meta.uuid ← fileName                 // 与现状一致
    if 是 legado 骨架源（stub 函数 + 内嵌原始 JSON, F8）:
        → 产出 enabled:false + legadoRaw 的 JSON          // 骨架源不是 needs-manual
    else if !isPureTemplate(content):
        → needs-manual：移动 .js 到 booksources_legacy/（不产出 JSON），记原因「含模板外语句」
          ⚠️ **三条 needs-manual 分支都必须连带搬 marker**：marker 命名是 `<fileName><.enabled|.disabled>`，
          而 fileName **带扩展名**（`booksource-meta.ts:184-185`、`booksource-handler.ts:137-138` 实测），
          所以 `foo.js` 的 marker 叫 `foo.js.enabled`：
          · 搬到 `booksources_legacy/` 同名，**不要留在 booksources/** —— 留原地会成为无主 marker，
            被 toggle/delete 的 `p + suffix` 清理路径牵连；
          · 不搬的后果：needs-manual 源在 legacy 目录里恒为「未启用」，回滚 JS 链路后行为与迁移前不一致；
          · §4.3 的行内状态按 legacy 目录扫描得出，不依赖 marker，但导出/回滚链路依赖它。
    else:
        rules  ← extractRulesFromJs(content)              // core/logic/rule-parse.ts
        headers ← extractConst(content, 'HEADERS')        // editor 的 extract 不含 HEADERS，需新写（F7）
        rules.searchContentType ← 按模板缺省回填：
            POST_RAW → 'application/json'；其余 → 'application/x-www-form-urlencoded'
            （editor 的回退恒为 x-www-form-urlencoded，直接沿用会让手写 POST_RAW 源行为漂移）
        rules.searchBodyParams / contentReplaceRules ← 兼容旧元组形态，命中则升级为对象数组（F15）
        if 任一必填规则为空 或 meta.urls 为空:
            → needs-manual（同上：移 .js + 连带移 marker，不产 JSON）
        doc ← { format, schemaVersion:1, uuid: meta.uuid, …, headers, rules }
        valibot parse ← 失败则 needs-manual（同上：移 .js + 连带移 marker）
        写 <userData>/booksources/<同名>.json（atomicWrite）
        移动 .js → booksources_legacy/（失败只记录不阻断）
        迁移 .enabled/.disabled → doc.enabled 后删除 marker
写 <userData>/booksource-migration-report.json（**目录外**）   // 放 booksources/ 内会被 scanJsonDir 扫成幽灵源
渲染端启动后读一次：有归档项时弹 Modal 汇总（含 legacy 目录路径），读后删报告文件
```

**幂等（唯一口径，全文已无 mtime 逻辑）**：`.json` 已存在且 `uuid` 相同 → **跳过整个文件**（用户手改过的 JSON 不被覆盖）。
~~mtime 比对~~ —— **删除且不再以任何形式出现**：成功路径把 `.js` 移走、`booksources/` 里再无 `.js`；needs-manual 路径同样移走。因此每次启动都是「扫到什么处理什么，已处理的文件已不在扫描集内」的**自然幂等**，不依赖时间戳比较。需要重判时：手动从 `booksources_legacy/` 取回原始 `.js`，或用 `pom:booksource-convert` 显式指定文件。

**判定策略保守**：宁可误归 needs-manual 不可错迁；legacy 文件可人工改 JSON 救回。

### 4.3 失败源的用户可见行为

书源列表页对 `needs-manual` 源（状态由**常驻** `pom:booksource-legacy-list` 扫描 `booksources_legacy/` 得出，不依赖一次性 Modal 报告）：行内标灰 + tooltip「无法自动转换（可能含自定义 JS）」+ 两个按钮「查看原始 JS」「删除」。不静默丢弃。
needs-manual 源的 `.js` **一律已移入 `booksources_legacy/`**（§4.2 三条 needs-manual 分支都执行移动），故扫描 legacy 目录即可覆盖全部未转换源。

---

## 5. 页面改造清单

| 页面 | 现状（行数） | 改造 | 工作量 |
|---|---|---|---|
| `book-source-list` | 184 | meta 字段映射兼容；+`rulesInvalid` 红标；+needs-manual 行内状态（走新 legacy channel） | 1d |
| `book-source-editor` | 280+36 | 删源码 textarea 与反向解析（`parseRulesFromSource`/`applyRulesToSource`/`generateCodeFromRules`，净删约 180 行）；主体 = rules-panel + meta 表单；保留"高级：查看 JSON"只读视图 | 1.5d |
| `book-source-debug` | 389+113 | `SandboxService` → `RuleEngineService`，四入口按钮不变；explore 按钮删（D3）；进度日志区改渲染 RuleTrace（F11：原"UI 零改动"说法不成立，`sandbox.progress` 必须有替代） | 1d |
| `book-source-test` | 385+103 | `source-test.service.ts` 换调用层，四阶段语义不变；`explore` 步按 D3 移除 | 1d |
| `book-source-smart-add` | 302 | 保存不再 `generateSourceCode`，直接序列化 `rules` + meta 为 JSON；预览区改 JSON 预览；fileName 校验 `.js`→`.json` | 1d |
| `book-source-search` | 256 | 零改动（duck-typed `search()` 契约不变） | 0 |
| `import-legado` modal | 328 | 翻译产物从 JS 改为 `BookSourceDoc`（`generateSourceCode` 调用改为字段映射）；骨架源 → `enabled:false`+`legadoRaw`+description 写明拒绝原因（F8） | 1d |
| `rules-panel` | 443+322 | **零改动**；本次补规则往返单测（面板 ↔ JSON 字段，该组件目前 0 用例） | 0.5d |

**周边服务改挂（沙箱消亡的连带断点）**：
- `cf-prompt.service.ts`：`SandboxService.cfChallengeHook` 静态属性（`sandbox.service.ts:129`）随沙箱消亡 → 引擎在 `booksourceHttpProxy` 返回后判 `res.cfChallenge`，**直接调用** `CfPromptService.prompt(url)`（`private` → `public`）。语义与现状逐字等价：fire-and-forget、不阻塞本次抓取回执、每 host 每次会话最多一次弹窗。`app.config.ts:37` 的实例化注释理由同步改写。⚠️ **不改挂 `FetchError('cf-challenge')`**：那只是错误码契约、全仓无监听器（§3.2 已证伪），且 `fetchPost` 侧根本不弹窗 —— 改挂过去等于把 CF 引导改没了。
- `source-health.service.ts`：`detectCapabilities` 原依赖沙箱函数表 → 改为「JSON 合法性 + 必填规则非空」校验；`detectBatch` 接口保留；preload `sourceHealthCheck` 删除。**注意本文件属于 js-source 目录，P4 删目录前必须先迁出**（见 §10）。
- 聚合搜索/换源/导入（multi-source-search / import-via-source / change-book-source-dialog）：走 registry 接口，零改动。

---

## 6. 分阶段实施计划

| 阶段 | 目标 | 关键改动 | 验收标准 | 回滚 |
|---|---|---|---|---|
| **P0 盘点** | 拿到存量数据 | `scripts/audit-booksources.ts` | 产出报告，手改比例数字进决策 | 无风险（只读） |
| **P1 引擎** | 规则引擎与 JS 引擎行为等价 | `json-rule/*` + adapter + guard + `core/logic/rule-parse.ts`；`registry` 并存注册；运行时开关 | **差分测试全绿**：真实书源 × 真实 HTML 样本，两引擎四入口输出逐条一致 | 开关切 `'js'` |
| **P2 存储** | 读写 JSON | handler 换 `.json` + valibot；智能添加/legado 导入直出 JSON | 新建源全程不产生 `.js`；channel 全部过 schema；旧 `.js` 仍可读 | 开关切 `'js'` + 读路径保留 |
| **P3 迁移+页面** | 老用户平滑过渡 | 主进程启动迁移 + legacy 归档 + 编辑器/调试/测试/列表页改造 + 周边服务改挂 | ① 老书库启动后全部转为 JSON 源且功能正常 ② **`Book.bookSourceUuid` 引用计数迁移前后不变**（D6 硬验收：uuid 错了不报错，只会静默换源失败）③ `needs-manual` 清单常驻可见 | 备份还原 `booksources_legacy/` |
| **P4 下线（单独发布）** | 删死代码 | 删 `js-source/`(2208 实现/2911 spec) + `build:worker` + `generateSourceCode` + 运行时开关 + **构建配置里的显式路径** | `rg "sandbox\|generateSourceCode\|parseHeaderMeta\|booksourceEval"` 在 `src/` 零命中；`tsc`/`ng build` 全绿；全量测试绿；包体下降 | 需从 tag 回滚，故 P4 单独发布 |

**依赖**：P1 不依赖 P2（引擎直接吃内存里的 `SourceRules`）→ 可并行启动 P0/P1。

**commit 粒度**：P1 一 commit（schema+引擎+差分测试）、P2 一 commit、P3 按「迁移 / 页面 / 服务改挂」三 commit、P4 一 commit。commit message 走 Conventional Commits + OMC trailer（`docs/CONVENTIONS.md`）。

**工作量估算**（1 人日 = 8h，含测试）

| 阶段 | 估 | 不确定性来源 |
|---|---|---|
| P0 | 0.5d | 低 |
| P1 | 4-6d | 差分测试的不一致条数是主要变量（模板细微语义差异时可能 +2d） |
| P2 | 3-4d | 低（handler 结构清晰） |
| P3 | 4-5d | 手改源的 UI 打磨占 1d 左右 |
| P4 | 1d | 低 |
| **合计** | **12.5-16.5d** | 另加 P0 结论可能引发的 D1 调整（0-2d） |

---

## 7. 测试策略

### 7.1 差分测试（方案核心，没有它 P1 不能合）

```
fixtures/booksources/<sample-id>.js         # 真实书源样本（脱敏并中性化命名后）
fixtures/html/<sample-id>/{search,detail,toc,chapter}.html
→ 对每个样本：
   js   = JsSourceAdapter(sandbox)      // 现有实现
   rule = JsonRuleAdapter(engine)       // 新实现
   assert deepEqual(js.search(kw,1), rule.search(kw,1))
   ... 四个入口逐一对比，失败时打印字段级 diff
```

**离线执行（F17，必须这样实现，否则会被做成联网 e2e 而失去确定性断言）**
worker 协议原生支持本地打桩：`sandbox.worker.ts:210,216` 定义了入站 `http-result` / `query-result`，`sandbox.spec.ts:760` 已有 FakeWorker 现成模式（捕获出站 `type:'http'` → 回 `http-result`）。
做法：新写 `fixtures/worker-stub.ts`，把 `JsSourceAdapter` 背后的 `SandboxService` 换成 stub 出口 —— 出站 `http` 请求按 URL 匹配回本地 HTML、出站 `query` 走主线程 DOMParser 真实实现（该部分本就是纯函数，必须真实，否则等于拿自己测自己）。两个引擎吃**同一份** HTML 字节，全程零网络。

- fixture 落盘版本化（每条 HTML 快照 ≤ 200KB，压缩后入 git）
- 样本来源：P0 报告里的现有书源 + 手动补 3-5 个典型站（CSS 单模 / 正则单模 / POST 搜索 / GBK 编码 / 内容净化多规则）
- **脱敏与命名（AGENTS.md 硬要求）**：真实站名/域名/文件名前缀一律替换为中性占位（`sample-a.js` / `html/sample-a/`），fixture 内不得出现真实站点标识；样本出处只在 `fixtures/MANIFEST.md` 记「形态类型」不记站点身份
- 覆盖 `needs-manual` 反例：含自定义 JS 的源，断言差分框架能**识别并标记**，而不是静默产出错结果
- **矩阵必须含 `pom.cssRules=0` 与默认两列**（F6c 订正后，该门是**现状生产行为**而非模板差异）：断言两引擎在 flag=0 时**抛同一文案**、flag 未设置时**同样正常解析 CSS**
- **已知差异登记（现状既有，非本次改造引入）**：`PageFetcherService.fetchHtml` 的 Tier 2 是**成功返回**语义 ——
  `page-fetcher.service.ts:90-93` 触发 `cfChallengeFlow`，人工验证后直接 `resolve(html)`（`:122`），本次请求即成功；
  而 JS 沙箱链路是 **fire-and-forget** —— `cf-prompt.service.ts:9-13` 自述"本次请求仍以 403 失败，章节保持未加载待重试"。
  v1 引擎走 `booksourceHttpProxy`（Round 3 订正）**不继承**此差异，行为与沙箱逐字一致；但若未来任何时候要合并
  这两条通道，此条必须先进「已知差异」清单再评估，不得默认"统一即更好"。
- 每处不一致：要么修实现，要么写进"已知差异"清单并评审

### 7.2 引擎单测
- `rule-parse.spec.ts`：旧 JS 常量 → SourceRules（含 HEADERS 提取 / 对象数组常量 / 旧元组形态升级 / `searchContentType` 缺省回退）
- `guard.spec.ts`：超长规则拒绝、嵌套量词拒绝、结果裁剪、预算超时
- `json-rule.adapter.spec.ts`：照抄 `js-source.adapter.spec.ts`（26 例）的用例，断言行为一致
- `rule-migration.spec.ts`：迁移四态 —— 模板生成源 / 含模板外语句的手写源 / legado 骨架源 / 损坏源；含结构白名单判定的**假阳性回归**（模板版本漂移的旧生成源必须判为可迁移）
- `rules-panel` 往返测试（补白）

### 7.3 e2e 与手动验收
- 现有 e2e 不触碰书源文件格式（已确认 `e2e/book-source.spec.ts`/`import-online.spec.ts` 仅做路由可达性巡检）→ 回归即可；补 1 条 Playwright：书源列表 → 编辑器表单保存 → 列表出现
- **手动端到端**（用测试沙箱目录，不动真实书库）：迁移前的一本样例 `.js` 启动后自动变 `.json`；搜索出结果；导入书籍；读一章正文；正文净化规则生效；调试页看 RuleTrace；needs-manual 源行内状态正确。

### 7.4 保留到 P4
- 现有 `js-source/` 2911 行 spec 在 P4 删除前**一个都不能删** —— 它们是差分测试的对照组。

---

## 8. 风险登记

| # | 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|---|
| R1 | TS 纯函数与现状行为存在**语义不等价**，照搬复用会产出错结果 | **已确认** | 高 | 两处写进 §3.2 对齐表：① `pickText` 正则分支漏 `stripTags`（`smart-rules.ts:167` vs `:645`）→ 新引擎走剥标签分支；② `cssRulesEnabled` 门**不只在 TS 侧** —— `sandbox.service.ts:676-677` 在 `proxyQuery` 里对每个 CSS 选择器 `fail` → 新引擎**保留门 + 同一文案**（Round 1 订正 v2.0 稿「该门只在 TS 侧 → 删门」的误判，那是把"响亮失败"改成了"静默错结果"）。差分矩阵设 flag=0 与默认两列。（注：`absUrl`/`stripTags`/`buildFormBody` 等已逐字核对为等价，原稿拿 `absUrl` 当样例是错的） |
| R2 | 存量手改 JS 源无法转换 | 中 | 中 | P0 先量化；`needs-manual` 可见 + 原始 JS 永不删 + 可导出；不静默删 |
| R3 | 正则回溯卡死主线程 | 低中 | 中 | 静态拦截嵌套量词 + 规则长度上限；P1.5 预留 worker 化 |
| R4 | 迁移期 uuid 不一致导致已添加的书需重抓 | 低 | 高 | 转换强制沿用 `@uuid`；转换后写一致性校验日志 |
| R5 | IPC channel 加 schema 时误伤旧调用方 | 中 | 中 | schema 先 `.passthrough()` 观测，再收紧 |
| R6 | 规则 JSON 无版本演进机制，`schemaVersion` 形同虚设 | 中 | 中 | P2 起强制：写入前校验、读取时按 version 分支迁移 |
| R7 | legado 骨架源被误判 needs-manual | 中 | 低 | 迁移算法显式识别骨架源转 `enabled:false`+`legadoRaw`（F8） |
| R8 | P4 一次性删 5000+ 行，回滚成本高 | 中 | 中 | P4 单独一个 commit/release，方便 `git revert` |
| R9 | 沙箱消亡的连带断点（cf-prompt 静态钩子 / source-health / debug progress / preload sourceHealthCheck） | 中 | 中 | §5 改挂清单逐项核销；**cf-prompt 走「引擎直接调 public 方法」，明确不改挂 `FetchError`**（Round 3 证伪：`FetchError` 全仓无监听器、`fetchPost` 侧不弹窗，改挂过去等于把 CF 引导改没了，见 §3.2） |
| R10 | legado 自定义请求头丢失 | 低 | 中 | schema 含 `headers` 字段（F7），迁移提取 HEADERS 常量 |
| R11 | **迁移判据假阳性**：模板头部不可重建（F14）+ 模板版本漂移（F15）+ 老元组格式源 → 字节比对会把大量正常源判成 needs-manual | **已确认（对 legado 导入源为 100%）** | 高 | 改为结构白名单（§4.2 D8）；`rule-migration.spec.ts` 专设假阳性回归用例 |
| R12 | **P4 构建中断** | 中 | 高 | 真正的失败源是**残留 import**（`rg` 零命中验收就是为此）＋ `build:worker` 产物缺失。`tsconfig.app.json:12-15` 的 4 条 include 与 `eslint.config.js:53` 的 ignore 指向已删文件**不会报错** —— 已实测：`include` 未命中任何文件时 `tsc` 正常退出（探针 exit=0，只有 `files` 缺文件才报错），flat config `ignores` 未命中同样无害；但会留陈旧条目，验收时顺手清掉即可，**不必为此打乱 P4 的删除批次** |
| R13 | **删目录连带删功能**：`source-meta.types.ts`（8 处外部引用）、`cf-prompt`（CF 人工过盾）、`source-health` 都在 js-source 目录内 | 高（若按原清单执行） | 高 | §10 明确迁出归属与迁出顺序；迁出完成前不删目录 |
| R14 | **报告文件被当书源**：迁移报告写在 `booksources/` 内会被 `scanJsonDir` 扫成幽灵源 | 中 | 低 | 报告改写到 `<userData>/booksource-migration-report.json`（§3.4） |

---

## 9. 待确认

1. **D1 细部**：手改比例由 P0 报告决定（<5% 停用归档即可；≥5% 加强 needs-manual 行内 UI 打磨）。P0 是只读脚本零风险，建议直接先跑。
2. **是否接受 v1 跑主线程**（P1.5 再上 worker）？还是要求 P1 就把正则隔离进 worker（+1.5d）？

---

## 10. 删除清单与文档同步

### P4 删除前必须先迁出（P3 完成、P4 之前）
| 文件 | 现属 | 迁出去向 | 迁出原因（证据） |
|---|---|---|---|
| `js-source/source-meta.types.ts` | js-source 目录内 | `core/book-source/source-meta.types.ts` | 被目录外 8 处 import：registry / list-state / list / debug / test 页面 / source-test / legado-import / legado-parser（内联 `import()`） |
| `js-source/cf-prompt.service.ts` | js-source 目录内 | `core/services/cf-prompt.service.ts` | CF Tier 2 人工过盾引导，删目录即功能回退（与 D1 判据冲突） |
| `js-source/source-health.service.ts` | js-source 目录内 | `core/services/source-health.service.ts` | 书源健康检查，§5 已改挂但仍在目录内 |
| `js-source/header-parser.ts` | js-source 目录内 | 删除（渲染端 `parseHeaderMeta` 与主进程实现语义不同，F16；JSON 路径不再需要头解析） | 编辑器改造后不再引用 |

### P4 删除
- `src/app/core/book-source/js-source/` 整目录（10 文件，**2208 实现 + 2911 spec**）、`generateSourceCode` 及仅其使用的 helper（`smart-rules.ts` 代码生成段）、`build:worker`、运行时开关、preload/main eval 残留
- **`tsconfig.app.json:12-15`** 的 4 条 js-source `include` 路径 —— 漏改**不 build 失败**（实测：`include` 未命中 → `tsc` exit=0；只有 `files` 缺文件才报错），但留陈旧条目（R12）。建议 P3 迁出 `source-health.service.ts` 的同一 commit 里顺手删该行做卫生清理
- **`eslint.config.js:53`** 的 sandbox.worker.ts ignore —— 同上，flat config `ignores` 未命中无害，顺手清掉
- ⚠️ **`electron/ipc/booksource-meta.ts` 不删**（`electron/window-state.ts:12` 依赖 `atomicWrite`），只删 `parseHeaderMeta` / `scanDir` / `.js` 分支

### 文档同步
- **README.md §项目结构** 同步（AGENTS.md 硬要求）
- **docs/CONVENTIONS.md §exceptions** 死代码留痕（sandbox/js 书源体系已删，理由：书源纯 JSON 化）
- **docs/Usage/BOOKSOURCE_GUIDE.md** + **CHANGELOG.md** 更新
- **修订 `docs/Architecture/2026-09-28-BOOKSOURCE_IMPORT_EXPORT_DESIGN.md`（F13，尚未完成）**：bundle `sources[].content` 语义改为 JSON 全文、`parseHeaderMeta` 依赖移除、`enabled` 不再单独携带（已在 content 内）、uuid 基线 hash 口径重写。
  **工作量未计入 P0-P4 任何一档**（估 0.5-1d，建议并入 P2 或独立成任务）—— 建议在 P2 开工前先做，否则 bundle 实施时会按旧契约开发。

---

## 附录 A：新增/改动文件清单

> 布局原则：`electron/` 只放 IPC 与文件系统 IO；可被渲染端复用的 schema / 纯函数一律落 `src/app/core/`。
> 因此 `BookSourceDocSchema` 在 `core/models/`，**不在** `electron/ipc/schema.ts`（后者只管 IPC 入参）。

**新增**
```
src/app/core/models/book-source-doc.model.ts        # 含 BookSourceDocSchema（valibot）
src/app/core/book-source/json-rule/{engine,guard,json-rule.adapter,rule-engine.service}.ts
src/app/core/book-source/json-rule/*.spec.ts
src/app/core/book-source/rule-migrate.ts            # 存量 JS → BookSourceDoc 纯函数（**仅渲染端**，见 D4 Round 4 修订）
src/app/core/book-source/rule-migrate.spec.ts
src/app/core/book-source/source-meta.types.ts       # ← 从 js-source/ 迁出（目录外 8 处 import）
src/app/core/services/cf-prompt.service.ts(+spec)   # ← 从 js-source/ 迁出（CF Tier 2 人工过盾）
src/app/core/services/source-health.service.ts(+spec) # ← 从 js-source/ 迁出
src/app/core/logic/rule-parse.ts                   # 旧 JS 常量 → SourceRules（从 editor 抽出共用）
src/app/core/logic/rule-parse.spec.ts
electron/ipc/booksource-migrate.ts                 # 迁移的**纯 IO**（读 .js / 原子写 .json / 移动 legacy）——**不含规则逻辑**，逻辑在渲染端 rule-migrate.ts（D4 Round 4 修订）
electron/ipc/booksource-handler.spec.ts             # handler 目前 0 用例，迁出时补
scripts/audit-booksources.ts                        # P0 盘点
fixtures/booksources/**  fixtures/html/**
```

> 三个迁出文件是 **移动而非复制**，连各自 spec 一起搬；`js-source/header-parser.ts` + spec 直接删（理由见 §10）。
> 迁出完成前不得删 `js-source/` 目录 —— 这是 §10 的硬前置。

**改动**
```
electron/ipc/booksource-handler.ts        # .json 读写 + 3 个新增 channel + valibot（§3.4）
electron/ipc/booksource-meta.ts           # scanJsonDir 增补；parseHeaderMeta/atomicWrite 保留
                                            #（atomicWrite 被 electron/window-state.ts:12 依赖，不可删）
electron/ipc/schema.ts                    # 仅 IPC 入参；书源文档 schema 在 core/models
electron/preload.ts                       # + booksourceConvert / booksourceMigrationReport
                                          # + booksourceLegacyList（§3.4 三个新增 channel 之一：
                                          #   legacy 常驻扫描用，支撑 §4.3 的 needs-manual 行内状态）
                                          # - booksourceEval / sourceHealthCheck
app.config.ts                                       # + provideAppInitializer 挂接迁移（D4 Round 4 修订：宿主在渲染端）
                                                 # ⚠️ 不再改 electron/main.ts（主进程无法 import src/，TS6059）
package.json                              # P4 - build:worker 脚本
src/app/core/book-source/book-source.registry.ts   # + registerRuleAdapters
src/app/core/book-source/feature-flag.ts  # 编译期 → 运行时（P4 删）
src/app/core/book-source/smart-add/smart-rules.ts  # generateSourceCode 标 deprecated（P4 删）
src/app/core/book-source/legado/legado-translator.ts  # 产物 JS → BookSourceDoc
src/app/core/book-source/legado/legado-import.service.ts  # deriveFileName .js→.json
src/app/pages/book-source/*（5 个页面）
src/app/modals/import-legado/import-legado.component.ts
tsconfig.app.json                        # 移除 4 条 js-source include：sandbox.worker /
                                          #   multi-mirror.service / source-health.service / worker-pool（P4；include 未命中不报错，见 R12）
eslint.config.js                          # P4 去掉 sandbox.worker.ts 的 ignore（:53，顺手清理，非阻断）
README.md / CHANGELOG.md / docs/Usage/BOOKSOURCE_GUIDE.md / docs/CONVENTIONS.md
docs/Architecture/2026-09-28-BOOKSOURCE_IMPORT_EXPORT_DESIGN.md  # 修订（尚未做，见 §10）
```

**确认无需改动**（§3.1 刻意复用，避免多余 diff）
```
src/app/core/book-source/smart-add/smart-rules.ts  # SourceRules 接口（:60）原样保留，P4 只删代码生成段
src/app/shared/components/rules-panel/*          # 443 ts + 322 html，直接吃 BookSourceDoc.rules
electron/tsconfig.electron.json                 # exclude 已含 ../src，不涉及 sandbox.worker
```

**P4 删除**
```
src/app/core/book-source/js-source/        # 20 文件（10 实现 + 10 spec）；迁出 5 文件（source-meta.types ×1 · 无 spec
                                          #   + cf-prompt ×2 + source-health ×2）+ 删 2 文件（header-parser + spec）后余 13
package.json  # - build:worker
tsconfig.app.json  # - js-source include
eslint.config.js  # - sandbox.worker.ts ignore
```

---

## 11. 二期及后续路线图（备忘，防遗忘）

> 以下事项**明确不属于 v1**，但已识别其价值与触发条件。逐项跟踪见
> `docs/Task/Active/BOOKSOURCE_JSON_RULES_FOLLOWUPS.md`。
> 本节编号用 `T-n`（track），与 §2 事实基线的 `Fn`（fact）刻意错开，避免同文档两套编号读混。
> schema 设计（§3.1）已为带 ⭐ 的项预留扩展位，落地时不需要破坏性格式变更。

### 11.1 表达力扩展（二期，按优先级）

| # | 事项 | 触发条件 / 价值 | 依赖 |
|---|---|---|---|
| T-1 ⭐ | 目录分页 `tocPagination`（目录分多页时循环抓取拼接） | 遇到目录分页站点即需要；是表达力损失的最大头 | schema 加字段 |
| T-2 ⭐ | 正文分页 `contentPagination`（一章拆多页合并） | 同上 | schema 加字段 |
| T-3 ⭐ | 搜索结果二次跳转 `follow`（搜索命中中转页 → 二次请求拿真实 bookUrl） | 中转页型站点 | schema 加字段 |
| T-4 ⭐ | 多候选规则（`contentPattern` 接受数组按序尝试，覆盖同站多版式） | 替代手改 JS 里的 try 多选择器 | schema 字段类型放宽为 `string \| string[]` |
| T-5 ⭐ | `responseType: 'json'` + jsonpath 选择器 | 兼容 legado 的 API 型书源（当前被拒翻译的一大类） | 需引入 jsonpath 求值器依赖（评估包体） |
| T-6 | XPath 选择器类型 | CSS/正则都搞不定的顽固站点 | 低优先级 |
| T-7 | 签名/加解密能力（时间戳签名、md5 参数等） | 带签名站点；需先设计「宿主注入工具」的安全边界（不再走用户 JS，只能是内置参数化算法） | 需单独安全评审 |

### 11.2 引擎与运行时

| # | 事项 | 触发条件 |
|---|---|---|
| T-8 ⭐ | `encoding` 字段（'auto'/'utf-8'/'gbk' 显式指定） | 代理层 auto 判错编码的站点出现时 |
| T-9 | `minDelayMs` 主抓取链路强制限流（现状仅镜像间限流，F9） | 被站点限流/封禁的反馈出现时 |
| T-10 | P1.5：正则执行移入 Web Worker（可 terminate 强杀） | **判据**：出现 UI 卡顿报告或书源库出现 ReDoS 源；v1 靠 guard 静态拦截兜底 |
| T-11 | explore / 发现页规则 | 有真实需求再做（现状与 v1 均无） |

### 11.3 生态与工具

| # | 事项 | 触发条件 |
|---|---|---|
| T-12 | 书源导入/导出 bundle 实施 | **前置**：先完成 `2026-09-28-BOOKSOURCE_IMPORT_EXPORT_DESIGN.md` 的修订（§10 已列出待修订项，修订本身尚未做），否则会按旧 `.js` 契约开发 |
| T-13 | needs-manual 源的人工重写指引 + `docs/Usage/BOOKSOURCE_GUIDE.md` 规则编写指南 | P3 迁移后如有 needs-manual 源残留 |
| T-14 | `booksources_legacy/` 清理策略 | 建议保留 ≥1 个版本周期；之后可在设置页提供「清理旧书源备份」按钮（永不自动删） |
| T-15 | 书源分享/订阅（legado 订阅 URL 的 JSON 化对应物） | T-12 bundle 落地后自然延伸 |

### 11.4 机制验证

| # | 事项 | 触发条件 |
|---|---|---|
| T-16 | `schemaVersion` 演进机制首次实战（v1 → v2 迁移分支） | 11.1 任一字段落地时顺势验证，避免 R6「形同虚设」 |
| T-17 | 差分测试 fixture 库的持续维护（新典型站点补样本） | 每次 11.1 扩展落地时同步补 fixture |

---

## External Review Opinion

> 协议：`~/.minimax/EXTERNAL_REVIEW.md` · provider 解析：session 未指定 → `REVIEW_PROVIDER` 未设置 → 硬编码兜底
> `coding-bridge`（codex / auggie 在当前运行时未配置，不可用）· 轮次上限 `REVIEW_MAX_ROUNDS=5`（env 未设置，取默认 5）
> 本节由主 assistant 独占写入轮次计数。

### Round 1/5 — 2026-09-29（kind=plan）

**Session:** `4d3346b3-cfff-4aca-9d8b-b13ad67a996a` · **VERDICT:** ⚠️ **NEEDS_CHANGES**（1×P0 / 3×P1 / 1×P2）

审查方对事实基线、差分测试设计、迁移判据 D8、跨边界 schema 位置、回滚机制均给出正面评价，
但判定"文档存在一处明显逻辑自相矛盾 + 若干边界/配置同步未明确"。

#### 审查方 risks 处置

| # | 风险 | 级别 | 处置 |
|---|---|---|---|
| E1 | §4.2 幂等自相矛盾：前文删 mtime、后文又要求"每次启动校验 `.js` mtime > `.json` mtime`" | P0 | ✅ **接受并修复**（复核确认原文确有重复段落，两段口径互斥）。删除末尾冲突段，全文收敛为「`.json` 已存在且 `uuid` 相同则跳过」，并补真正的幂等来源：**已处理文件被移出扫描集（自然幂等）** |
| E2 | `tsconfig.app.json` include 了 `source-health.service.ts`，P3 迁出而 P4 才改 tsconfig → P3 编译失败 | P1 | ❌ **驳回（机制不成立）** + 降级为 P2 卫生项。实测证据：`tsconfig` 用 `include` 时，未命中任何文件的条目**不报错**（探针 `tsc -p ... --noEmit` → `exit=0`）；只有 `files` 字段缺文件才报 `TS6053`。`eslint` flat config 的 `ignores` 未命中同样无害。故 P3 迁出时不改 tsconfig **不会**编译失败。已把 R12 概率由「高」降「中」、失败源改为**残留 import**，行号 `:12-16` 订正为 `:12-15`；同时保留"迁出同 commit 顺手删该行"的建议 |
| E3 | §3.1 对照表把 `searchMethod` 标为必填（✅），与 F3（7 必填 + 9 可选）冲突，valibot 若设 required 会误杀存量源 | P1 | ✅ **接受并修复**（复核 `smart-rules.ts` 确认 `searchMethod?: SearchMethod` 为可选、注释写明缺省 `'GET'`）。改为「—（可选，缺省 `GET`；valibot 必须 `optional()` + default，不可设 required）」；连带订正 `rules` 注释「15 字段」→「16 字段」与 D2 的 15/16 表述 |
| E4 | needs-manual 源移动 `.js` 到 legacy 时未说明其 `.enabled`/`.disabled` marker 如何处理，残留 marker 干扰扫描 | P1 | ✅ **接受并修复**，并补上具体机制：marker 命名是 `<fileName><.enabled|.disabled>` 且 **fileName 带扩展名**（`booksource-meta.ts:184-185`、`booksource-handler.ts:137-138` 实测）→ `foo.js` 的 marker 叫 `foo.js.enabled`。三条 needs-manual 分支（结构不合规 / 必填缺失 / valibot 失败）统一补「**连带搬 marker 到 legacy**」，并说明不搬的两条后果（无主 marker 被 `p + suffix` 清理路径牵连；回滚后该源恒为"未启用"） |
| E5 | 未声明主进程迁移不受 `pom.bookSource.engine` 运行时开关约束，联调易误解开关作用域 | P2 | ✅ **接受并修复**：§4.2 触发时机处显式声明迁移为一次性文件级转换、**不受开关约束**，切回 `'js'` 后 legacy 标灰行仍可见（回滚表现为"多一批标灰行"而非"书源消失"） |

#### 主 assistant 自查发现（外部审查未覆盖，已一并修复）

| # | 发现 | 级别 | 证据与处置 |
|---|---|---|---|
| S1 | **§2 F6 / D9 / §1 / §3.2 / §7.1 / R1 六处口径建立在一条错误事实上**：「`cssRulesEnabled` 门只在 TS 侧，模板无此门 → 删门对齐模板」 | **P0** | `sandbox.service.ts:676-677` 在 `proxyQuery` 开头 `if (!cssRulesEnabled()) fail('CSS 规则已禁用（localStorage pom.cssRules=0）')` —— **现状 JS 生产链路同样受该门约束**；`smart-rules.ts:162,173,184,275` 的 `pickText/pickHtml` 也判门，且 `rules-panel` 预览直连该函数。flag 定义 `smart-rules.ts:22-28` 自述"运行时止血开关"。删门 ≠ 对齐模板，而是让存量 `pom.cssRules=0` 用户从"响亮失败"退化为"静默按 CSS 解析"，恰是 D9 自身要避免的方向。**已订正**：F6 拆为 F6 + F6c，五处口径统一改为「保留门 + 沿用同一报错文案」；§7.1 矩阵由"一列 flag=0"改为"flag=0 与默认两列、断言两引擎同样抛错/同样解析" |
| S2 | **D6 的 uuid 硬验收只覆盖迁移，未定义新建 JSON 源的 uuid 派生** | P1 | 现状无 `@uuid` 时回退为**带扩展名的文件名**（`foo.js`）。若新建 JSON 源回退为剥扩展名或 `foo.json` 之外的形态，同一逻辑源会拿到两个 uuid，`Book.bookSourceUuid` 匹配不上且**不报错**（正是 D6 描述的"静默换源失败"）。§3.1 `uuid` 字段已补命名空间约束：**必须与现状同构** |
| S3 | §3.1 `urls` 注释"顺序即轮询优先级"与 D7「v1 不做 failover」互斥 | P2 | 注释可能被实施者读成"该按轮询实现"，等于偷偷引入 v1 明确排除的行为。已改为明示「仅取 `[0]`，顺序原样保留仅为二期留位」 |

#### Round 2 前的状态

- 本轮 5 条外部 risks：**4 条已修复入文档，1 条（E2）驳回并降级**（附实测证据）。
- 自查 3 条：**S1（P0）已修复，S2/P1 已修复，S3/P2 已修复**。
- 文档口径已收敛：15/16 字段、`searchMethod` 可选性、幂等唯一口径、marker 处置、uuid 命名空间、
  `cssRules` 门范围、R12 等级与行号，共 7 处互相印证的修订。
- 轮次状态：**Round 1/5 已 CLOSE（非 APPROVED，NOT_APPROVED）→ 进入 Round 2/5 复审**。

### Round 2/5 — 2026-09-29（kind=plan，同 session 续）

**Session:** `4d3346b3-cfff-4aca-9d8b-b13ad67a996a`（同 Round 1 续）· **VERDICT:** ✅ **APPROVED**（2×P2，非阻塞）

审查方逐项复核结论：

- **E1–E5 全部关闭**。E2（tsconfig include 时序）**接受了我方驳回并复核了理由**，原文确认
  "拒绝理由成立"：`include` 未命中不报错（只有 `files` 缺文件才 TS6053），P3 迁出后旧 include 变成无害死引用，
  文件在新位置被常规模式覆盖，编译正常；卫生建议与 R12 失败源（残留 import）的修正亦被认可。
- **cssRules 保留门不引入新问题**，并给出 4 条独立验证：① 新引擎在渲染端主线程，`localStorage` 可达；
  ② `cssRulesEnabled` 定义在 `smart-rules.ts:22-28`，该文件 P4 只删代码生成段，函数存活可 import；
  ③ `rules-panel` 预览走同一 `pickText/pickHtml`，门天然继承 → 引擎与预览单源；④ 差分测试的
  FakeWorker 走 `SandboxService.proxyQuery` 真实实现（含门检查），两侧测试路径一致。
- **未发现新引入的矛盾**，并逐对交叉验证通过：D2↔F3↔§3.1（16 字段）、D7↔§3.1 `urls`↔§1、
  D9↔§1↔§3.2↔§7.1↔R1（保留门）、S2↔D6↔P3 验收（uuid）、§4.2 marker↔§4.3、§4.2 幂等↔迁移流程。
- **可实施性**：无阻断缺口、无内部矛盾、差分测试策略足以证明等价、迁移幂等且可回滚、删除清单含构建配置同步。

#### Round 2 遗留 P2（不阻塞，登记跟踪）

| # | 建议 | 处置 |
|---|---|---|
| P2-a | F13（`2026-09-28-BOOKSOURCE_IMPORT_EXPORT_DESIGN.md` 修订）工作量未计入 P0-P4，建议 P2 开工前独立排期 | ✅ **已在跟踪** —— §10 文档同步节已列修订项与 0.5-1d 估算，`BOOKSOURCE_JSON_RULES_FOLLOWUPS.md` **T-12** 已挂 ⚠️ 前置未完成标记。无需新条目 |
| P2-b | §9 两个开放问题（D1 细部依赖 P0 报告；v1 主线程 vs +1.5d worker 隔离）需人工在 P0 后决策 | ✅ **有意保留为人工决策点** —— 两问都依赖 P0 实跑数据，提前定无依据；审查方确认"任一选择均有明确实施路径，不阻断开工" |

#### 收尾自查（Round 2 后本地复核）

对修订后的文档做了一次全文口径扫描（`rg` 校验 `只在 TS 侧` / `mtime` / `15 字段` / `轮询优先级` / `12-16`），
发现**头部变更清单第 2 条仍在复述已被推翻的旧事实**（「`cssRulesEnabled` 门只存在于 TS 侧」）——
该句是读者进入文档的第一印象，且与第 13 条正面冲突。已加显式失效标注指向第 13 条。
其余命中项均为有意保留的历史记录（审查记录节 S1/E1/E2 条目、幂等节的删除声明、`urls` 的反向约束文案）。

#### Review Loop 状态：CLOSE

- 轮次：**2/5**（未触发 5 轮上限；Round 1 NOT_APPROVED → 修订 → Round 2 APPROVED）
- 最终 VERDICT：**APPROVED**（provider=coding-bridge，session `4d3346b3-cfff-4aca-9d8b-b13ad67a996a`）
- 累计：外部 risks 5 条（4 修复 / 1 驳回并降级）+ 自查 3 条（含 1 条 P0 事实错误）全部闭环
- 方案状态：**可进入 P0 实施**。P0（`scripts/audit-booksources.ts`，只读零风险）不受 §9 两问阻塞。

### Round 3/5 — 2026-09-29（kind=plan，同 session 续；方向性修订触发的复审）

**Session:** `4d3346b3-cfff-4aca-9d8b-b13ad67a996a` · **VERDICT:** ✅ **APPROVED**（2×P2，均非阻塞）

**触发原因**：Round 2 收口后，项目 owner 指出 §3.2 的 HTTP 链路**方向错误**。该改动触及引擎的核心架构决策，
按协议重新入轮（未新开 session，轮次计数续为 3/5）。

#### P0：§3.2 HTTP 链路方向（已推翻并改回）

原方案要求引擎"统一走 `PageFetcherService.fetchHtml`、不直接调 `booksourceHttpProxy`"，理由是
"cf-prompt 钩子挂在 `FetchError('cf-challenge')` 上，只有 `PageFetcherService` 会翻译"。逐条回代码证伪：

| # | 证伪点 | 证据 |
|---|---|---|
| A | 钩子不在 `FetchError` 上 | `sandbox.service.ts:129` `static cfChallengeHook`，`:623` 依据响应 `cfChallenge` 标志触发；全仓唯一注册方 `cf-prompt.service.ts:25` 构造函数（`app.config.ts:37` 为此启动实例化）。`FetchError` 仅错误码契约（`fetch-error.ts:7,26`），**零监听器** |
| B | **GET 丢自定义 headers**（回归 1） | `fetchHtml(url, encoding?)` 签名无 headers（`page-fetcher.service.ts:9-12` 声明、`:87` 实现）↔ 方案自身 F7/R10 要求保留 headers，**自相矛盾** |
| C | **POST 丢 CF Tier 2 弹窗**（回归 2） | `page-fetcher.service.ts:159` 只 `throw new FetchError('cf-challenge')`，**不弹窗**；其 JSDoc `:145` 自称"同样弹 Tier 2"是**失效承诺**。现状 `proxyHttp` 对所有 method 统一弹窗 → POST 搜索遇 Turnstile 行为回退 |
| D | `booksourceHttpProxy` 已足够 | 签名 `{url, method?, headers?, body?}` → `{status, headers, body, cfChallenge?}`（`page-fetcher.service.ts:24-34`），且是沙箱现用通道，SSRF/15s/cookie 由主进程 `safeNetRequest` 提供 |

**改法**：引擎直连 `booksourceHttpProxy`（与现状沙箱同源）+ 判 `res.cfChallenge` 直调 `CfPromptService.prompt(url)`
（等价于把 `sandbox.service.ts:623` 那一行搬到引擎层，fire-and-forget / 每 host 每次会话一次 / 不阻塞回执三项语义逐字保留）。
三处配套已写入 §3.2：`prompt` `private`→`public`（`cf-prompt.service.ts:28`）、`app.config.ts:37` 实例化理由改写、
`SandboxService.cfChallengeHook` 不保留且 `cf-prompt.service.spec.ts:75-79` 用例改造。
同步改写：架构图「两条通道共存」说明、§3.2 对齐表 `legado.http.*` 行、§5 cf-prompt 条目、R9。

**验收方结论**：逆转决策"正确且完整"，四个验证点自洽；与 D2「v1 严格等价」一致 —— 引擎替换沙箱就必须走沙箱走的通道。

#### 小疵订正（均已回代码验证）

| # | 原文 | 订正 | 证据 |
|---|---|---|---|
| N1 | 附录 A「迁出 3 组 + 删 1 组后余 12」 | **余 13**：20 − 5（`source-meta.types` ×1 无 spec + `cf-prompt` ×2 + `source-health` ×2）− 2（`header-parser` + spec） | `ls` 计数：20 文件 / 10 spec；`source-meta.types.spec.ts` 不存在 |
| N2 | F6 模板 `extractText` = `smart-rules.ts:644` | `:645` | `:644` 是上一行 `RegExp.exec`，`:645` 才是 `stripTags(m[1])` |
| N3 | F14 头部 `smart-rules.ts:495-501` | `:494-500` | `:494` 是 `// @name`，6 个键为 `:495-500` |
| N4 | F15 引用 `BOOKSOURCE_GUIDE.md:34,137` | 拆开：版本漂移 `:13,34` / 元组形态 `:137` | `:137` 实为元组破坏性变更说明，**不含** `@version`，原写法易被误读 |

#### 已知差异登记（§7.1）

`PageFetcherService.fetchHtml` 的 Tier 2 是**成功返回**语义（`:90-93` → `cfChallengeFlow` → `:122` 直接 `resolve(html)`），
沙箱链路是 **fire-and-forget**（`cf-prompt.service.ts:9-13`）—— 现状既有差异。v1 引擎走 `booksourceHttpProxy` 不继承此差异；
若未来要合并两条通道，须先评估此条，不得默认"统一即更好"。

#### Round 3 遗留 P2

| # | 建议 | 处置 |
|---|---|---|
| P2-c | §3.2 未说明 zoneless 下引擎**不需要**复制 `PageFetcherService` 的 `inZone` 包装，实施者可能困惑 | ✅ **已采纳并写入 §3.2**（附现状佐证）。本地复核通过：`app.config.ts:51` 为 `provideZonelessChangeDetection()`，`NgZone.run()` 在该模式下不调度 CD；`sandbox.service.ts` 全文零 `NgZone`/`inZone` 命中却正常工作；`zone.js` 虽在 `package.json:81` 但不参与 CD |
| P2-d | §9 两个开放问题待人工在 P0 后决策 | ✅ 有意保留 —— 依赖 P0 实跑数据；验收方确认"任一选择均有明确实施路径，不阻断开工" |

#### 一致性附带项

`docs/Task/Active/BOOKSOURCE_JSON_RULES_FOLLOWUPS.md` 编号已由旧 `F-n` 对齐为 `T-n`（17 项，无 `F-` 残留），
T-12 保留 ⚠️ 前置未完成标记 —— 与本方案 §11 编号体系一致。

#### Review Loop 状态：CLOSE（累计 3/5 轮）

- Round 1 **NEEDS_CHANGES**（1×P0 / 3×P1 / 1×P2）→ 4 修复、1 驳回并降级
- Round 2 **APPROVED** → 循环 CLOSE
- Round 3（方向性修订触发）**APPROVED**（2×P2，均已落地或有意保留）→ 再次 CLOSE
- 最终 VERDICT：**APPROVED**（provider=coding-bridge，session `4d3346b3-cfff-4aca-9d8b-b13ad67a996a`，三轮同一 session）
- 未触发 5 轮上限。方案状态：**可进入 P0**（`scripts/audit-booksources.ts`，只读零风险），§9 两问不阻塞开工。

### 收尾订正（Round 3 之后，不触发新一轮）

**N5 `booksource-meta.ts` 回退规则引用错误 —— 已修，且比"差一行"更严重**

原文两处均把 `name` 回退当作 uuid 回退的佐证并引作 `:151`。实际读码（`booksource-meta.ts:140-152`）：

| 字段 | 实际实现 | 正确位置 | 扩展名语义 |
|---|---|---|---|
| `uuid` / `sourceKey` | `const finalUuid = uuid \|\| fileName` | **`:142`**（写入 `:147-148`） | **不剥**（`foo.js`） |
| `name` | `name \|\| fileName.replace(/\.js$/i, '')` | **`:150`**（`:151` 是 `url:` 行） | **剥掉**（`foo.js` → `foo`） |

问题不止行号：被引用的那行语义**恰好相反** —— 拿 `name` 的剥除行为去佐证 uuid 的保留行为，读者若照此实现
`parseJsonMeta`，会得出与 S2 结论相反的编码。已改为直引 `:142`，并在 §3.1 与 §4.4 两处加显式警示
「uuid 不剥、name 剥，两者不可互相佐证」；§4.2 改为一张两行对照表（uuid 带扩展名 / name 剥 `.json`）。
附带补记：`sourceKey` 与 `uuid` 同值（`source-meta.types.ts:20-21` 注明用于 registry 注册匹配，
渲染端 `header-parser.ts:141` 同款赋值），故新文档两者须同源，不能只保 uuid。

**处置性质**：引用订正 + 既有结论（S2）加强，**不改变任何决策**，故未触发 Round 4；轮次仍为 3/5。
