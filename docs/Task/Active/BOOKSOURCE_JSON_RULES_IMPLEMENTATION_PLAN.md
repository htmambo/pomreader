# 书源 JSON 规则化 — 实施任务计划（P0–P4）

> **Status**: 🔄 In progress (start time: 2026-09-29)
> **分支**: `feat/booksource-json-rules-2026-09`
> **上游设计**（已评审 APPROVED，3/5 轮）: [2026-09-29-BOOKSOURCE-JSON-RULES-PLAN.md v2.1](../../Architecture/2026-09-29-BOOKSOURCE-JSON-RULES-PLAN.md)
> **二期跟进清单**: [BOOKSOURCE_JSON_RULES_FOLLOWUPS.md](BOOKSOURCE_JSON_RULES_FOLLOWUPS.md)（T-1..T-17，本文档不重复）
> **创建**: 2026-09-29 · **总估**: 12.5-16.5 人日（1 人日 = 8h，含测试）

## 0. 目标

把书源载体从「JS 文件 + Worker 沙箱执行」换成「JSON 规则文档 + 主线程规则引擎」，
**行为与今天逐字段等价**（差分测试为合入门禁），并保留原始 JS 备份以支持回滚。

## 1. 实施顺序与依赖

```
P0 盘点 ──┐
          ├──> P1 引擎 ──> P2 存储 ──> P3 迁移+页面 ──> P4 下线
P1 不依赖 P2（引擎直接吃内存 SourceRules），P0/P1 可并行
```

## 2. 子任务拆解

### P0 盘点（0.5d）— ✅ 完成（2026-09-29）

| # | 子任务 | 产出 | 状态 |
|---|---|---|---|
| 0.1 | `scripts/audit-booksources.cjs` 只读扫描器 | 源总数/启用数/字段完整度/手改检测/特殊模式/uuid 清单 | ✅ |
| 0.2 | 在本机真实书库跑一遍，产出报告 | 决定 D1 细部（手改比例 <5% vs ≥5%） | ⚠️ 见下方「本机数据不足」 |
| 0.3 | 据 0.2 结论细调 D1（needs-manual UI 力度） | 方案 §9 待确认 1 的答案 | ⏳ 待真实书库重跑 |

- [x] **验收**：脚本跑通；15 条正反样本 + 6 条边界用例全部符合预期
- [x] **回滚**：无（纯只读）

**本机数据不足（阻塞 0.3，不阻塞后续阶段）**

本机 `~/.config/pomreader/booksources` 只有 **1 个源**，且是 `@version 1.1.0` 老模板（方案记录的漂移是 1.0.0/1.2.0，
实际还存在 1.1.0）。样本量过小，**手改率不可外推** → 0.3 需在用户真实书库重跑后才能定 D1 细部。
但结构性结论已可用：

| 观察 | 含义 |
|---|---|
| 该源缺 `SEARCH_AUTHOR_RULE` / `SEARCH_CATEGORY_RULE` 两个常量 | 老模板产物**天然缺常量**，迁移必须按空串处理，不得据此判 needs-manual（已记为 I2） |
| `@version 1.1.0` | 方案 F15 只记了 1.0.0/1.2.0 两个版本值，实际漂移面更大 → 再次印证 R11「字节比对会全量误判」 |
| uuid 走回退值 `biquge345_com.js`（**带 `.js` 扩展名**） | 现场验证了 N5 订正：uuid 不剥扩展名、name 剥，两者相反 —— 迁移实现必须复刻这条 |

#### P0 外部审核记录（provider=coding-bridge，5/5 轮）

`review_code` 两次 MCP 超时不可达 → 按协议降级到同 provider 的 `chat` 入口完成审核（session `17c347ab`）。

| 轮 | 结论 | 要点 |
|---|---|---|
| R1 | NEEDS_CHANGES | 6 条：双 marker 重复计数 / 模板字面量截断 / 手改率分母含骨架源 / 断链符号链接崩溃 / 顶层非声明语句漏报 / BOM（后者经实测降级） |
| R2 | NEEDS_CHANGES | 5 条：孤儿 marker（**误报，评审只看了我贴的片段**）、手改过滤漏 topLevelStmts（**误报，已修**）、NaN%（**误报，守卫已用 templateSourceCount**）、块注释正文误报、`^\*` 吞掉乘法续行 |
| R3 | NEEDS_CHANGES | 4 条：重叠交替 `(a\|ab)+` 漏报 / byteSize 用归一化后内容 / 反引号转义计数 / `export const` 归类 |
| R4 | NEEDS_CHANGES | 3 条：**class 声明组号写错（`m[6]` 恒 undefined，该缺陷自第一版即存在**）/ 生成器函数漏报 / 行内块注释后的代码漏报 |
| R5 | **PASS** | 「在粗筛工具的既定契约内可以合入」；4 条 P2 非阻塞 |

**自查发现（外部评审未覆盖）**：① 修 P0 修复时引入的 `pct < '5.0'` **字符串比较** bug（100% 手改率反而打印「<5%」）；
② `findTopLevelStatements` 首版拿未 trim 的行判 `^const`，把模板函数体每一行都当顶层语句（回归用例当场抓住）；
③ 字符类写成 `[}\])];,\s]` 时 `\]` 使 `]` 提前闭合、整个正则永不匹配（实测 `test('}') === false`）；
④ 批量编辑时误删 `jsFiles` 定义行造成 ReferenceError（`node --check` 查不出，靠读回代码发现）。

#### P0 已知局限（评审 R5 遗留 P2，登记不修）

- 同行多声明符 `const A = 1, B = 2` → **已修**（补扫逗号后声明名）
- 名为 `*.enabled` / `*.disabled` 的**目录**被当孤儿 marker → **已修**（`!d.isDirectory()`）
- 解构 `const { a } = b` 归类为「顶层非声明语句」：判定正确（needs-manual），仅措辞不够精确
- `/* 注释 */ const MY_HACK = 1` 形态会同时绕过两个检测器：判定为漏报，未修（模板生成器从不产出块注释，
  且迁移期 `isPureTemplate` 实跑会再次覆盖）

### P1 引擎（4-6d）— ✅ 代码完成（2026-09-29），外部审核 APPROVED（3/5 轮）

| # | 子任务 | 关键约束 | 状态 |
|---|---|---|---|
| 1.1 | `core/models/book-source-doc.model.ts` + `BookSourceDocSchema`（valibot） | 放 `core/models/` 不放 `electron/`（渲染端从不 import electron） | ✅ |
| 1.2 | `core/logic/rule-parse.ts`（旧 JS 常量 → `SourceRules`） | 含 HEADERS 提取 / 对象数组常量 / 旧元组形态升级 / `searchContentType` 按方法推导 | ✅ |
| 1.3 | `json-rule/engine.ts` | 四入口语义对齐**现状生产行为**（非照搬模板文本） | ✅ |
| 1.4 | `json-rule/guard.ts` | 规则长度 ≤512、嵌套量词拦截、条数/正文上限、预算超时 | ✅ |
| 1.5 | `json-rule/json-rule.adapter.ts` | 实现 `BookSourceAdapter` + duck-typed `search()`；HTTP 直连 `booksourceHttpProxy` | ✅ |
| 1.6 | `json-rule/rule-engine.service.ts` | 读 JSON → valibot parse → 四入口 + RuleTrace；CF Tier 2 直调 `CfPromptService` | ✅ |
| 1.7 | 运行时开关 + registry 并存注册 | `feature-flag.ts` 编译期→运行时；`registerRuleAdapters` | ✅（分段控件 UI 归 P3.2） |
| 1.8 | **差分测试**（离线打桩，P1 合入门禁） | FakeWorker 出站 `http`→本地 HTML；矩阵含 `pom.cssRules` 0/1 两列 | ✅（形态覆盖待补，见 I4） |

- [x] **验收**：差分测试全绿（真实书源 × 真实 HTML，两引擎四入口逐条一致）—— 21 条差分用例 + 5 文件 108 条 json-rule 用例
- [x] **全量**：`tsc -p tsconfig.app.json` 干净；全量回归 **72 文件 / 1158 用例全绿**；Prettier 合规
- [x] **回滚**：开关切 `'js'`

#### P1 各子任务落点

| 文件 | 行数 | 职责要点 |
|---|---|---|
| `json-rule/engine.ts` | 386 | 四入口；所有 CSS 查询走提取自 `sandbox.service.ts` 的真实 `runQuery`；2xx 门；`resolveRuleDefaults` 收口 |
| `json-rule/guard.ts` | 112 | ReDoS 保守判据（两种歧义形态）/ 规则长度 / 执行预算 / 上限常量 |
| `json-rule/json-rule.adapter.ts` | 139 | `BookSourceAdapter` + duck-typed `search()`；100 条裁剪与幽灵条目过滤 |
| `json-rule/rule-engine.service.ts` | 296 | valibot 校验 + 四入口 + RuleTrace；`booksourceHttpProxy` 直连 + CF Tier 2 直调 |
| `feature-flag.ts` | 97 | 编译期总闸 + 运行时开关 `pom.bookSource.engine`（`resolveEngineMode` 过渡期兜底） |
| `book-source.registry.ts` | +85 | `registerRuleAdapters` / `clearRuleAdapters` / `hasRuleAdapters` |

**1.1–1.7 实施中自查发现并修掉的问题**（11 条见下）之外，本轮（1.3–1.7）新增自查 6 条：

| # | 问题 | 说明 |
|---|---|---|
| ⑪ | **`guard.ts` 定义了上限却没人用** | `CHAPTER_MAX_ITEMS` / `CONTENT_MAX_BYTES` 只声明未落地。已在引擎层接上；并查明 `CHAPTER_MAX_ITEMS` **今天不可达**（模板常量 `MAX_EXTRACT_LINKS=500` 先截断，500 < 20000），登记为冗余兜底而非生效门，测试断言的是真实行为 500 |
| ⑫ | **HTTP 无 2xx 门：404 错误页会被当正文解析**（真 bug，会静默出错结果） | 旧链路的门在 `sandbox.worker.ts:405-409`（`legado.http` shim 非 2xx 即 reject）。引擎的 `http` 是注入点，原实现完全不看 `status`。已在 `engine.ts` 的统一出口 `request()` 补门，并**同步把差分基座的 shim 改成同样的 2xx 判定** —— 否则基座对 5xx 仍"成功返回"，差分会把这处真实漂移掩盖掉 |
| ⑬ | **`isRiskyRegex` 漏报 `(\d{1,3})*`** | 内层是有界重复时同样歧义。不修：放宽判据就要连带判 `(?:\s+|,)*` 危险，而 P0 实测存量源普遍在用后者 → 收紧即批量误杀。已在 `guard.ts` 与 spec 中登记为**已知漏报**（附取舍理由），判据重估留到 P3 真实书库重跑 P0 之后 |
| ⑭ | **`rule-parse.ts` 有 8 处 `noPropertyAccessFromIndexSignature` 编译错误** | 本仓 tsconfig 开了该选项，点访问索引签名属性直接编译失败（`ng build` 会挂）。已全部改方括号访问 |
| ⑮ | **`resolveRuleDefaults` 住在 `core/logic/rule-parse.ts` 导致引擎反向依赖遗留解析器** | 该函数镜像的是 `generateSourceCode` 的缺省链，且引擎 `createRuleEngine` 也要过它。已迁到 `smart-rules.ts`（与被镜像的生成侧同文件），配套把 `ResolvedSourceRules` 类型也搬过去 —— 收口后"可选字段必有值"由**类型**保证，不只是运行时约定 |
| ⑯ | **方案附录 A 要求的 `json-rule/*.spec.ts` 缺 engine/guard 两份** | 差分基座只覆盖"两边一致"，证不了"两边都对"（两侧都返空数组时差分是绿的）。已补 `engine.spec.ts`（22 条）+ `guard.spec.ts`（29 条） |

#### P1 外部审核记录（provider=coding-bridge，3/5 轮 APPROVED）

session `daabda7a`。`review_code` 入口本轮**可用**（前几轮超时），走标准入口完成。

| 轮 | 结论 | 要点 |
|---|---|---|
| R1 | NEEDS_CHANGES | 19 条，逐条回代码核验后 **5 条成立**（contentReplaceRules 绕过 ReDoS 守卫 / ruleAdapters 累积重复项 / 切 `js` 不清理适配器 / CONTENT_MAX_BYTES 口径 + 代理对 / HTTP 静默降级），13 条驳回，1 条部分采纳 |
| R2 | NEEDS_CHANGES | 仅 1 条：`truncateText` 代理对处理算"新引擎独有的改善"。**前提被证伪** —— 旧模板 `chapterContent`（`smart-rules.ts:823-831`）根本没有任何长度截断，全文 `slice\|substring\|substr` 零命中 |
| R3 | **APPROVED** | 接受 R2 的驳回证据；确认无过渡期破坏性回归，"代码已达到 Stage P1 的发布标准" |

**驳回记录（评审给了证据要求，逐条附代码位置）**

| 评审意见 | 驳回理由 |
|---|---|
| `$` 特殊模式破坏 POST_RAW body / `.replace` 只替首个 | 旧模板**逐字同样**（`smart-rules.ts:698`、`:702-706`）。P1 契约是行为等价，单边"修好"才是制造漂移 → 转二期，两侧一起改 |
| 缺类型注解、无法编译 | 事实错误：我压缩 payload 时手抄漏了注解，真实文件是全的；`tsc -p tsconfig.app.json` 干净 |
| `bookInfo` 双 fetch | 旧模板同样双 fetch（`:730` 取一次，`:737` 调 `chapterList`，后者 `:743` 再取一次）。引擎刻意复刻，差分用例已钉死 `seen.length === 2` |
| 捕获组缺失产出 undefined | 同为旧模板行为（`stripTags(m[2])` / `absUrl(m[1], ...)`），是存量怪癖不是 P1 回归 → 转二期 |
| `hostPattern` 只取 `urls[0]` | `booksource-meta.ts:151` 的 `url` 本身就是 `urls[0]`，旧适配器同理；且"v1 只取 [0] 不做 failover"是方案明写决策 |
| 每次调用重建引擎 | 刻意的："改完 JSON 立即生效"是继承自 `JsSourceAdapter.ensureLoaded` 的契约；构造是纯对象字面量 + 9 次短串检查，无 IO，缓存会重新引入陈旧源 bug |
| `checkRule` 也跑 CSS 选择器 | 两种危险形态都要求 `(...)` 紧跟量词，CSS 选择器不产生该形状（评审自己也确认 `:nth-child(2n+1)` 不匹配）；512 长度上限是方案 guard 表明列项 |
| `extractAttr` 原型链访问 | 唯一调用点传字面量 `'src'`，`attr` 非用户可控；`attrs` 由元素自身属性名构建（`sandbox.service.ts:736-738`） |
| `toRawSearchItem` 放过空名条目 | 与旧适配器 `js-source.adapter.ts:191-192` 判定完全一致 |
| `NESTED_ATOM_RE` 字符类过宽 | 评审给的例子 `(\x41+)+` 等价 `(A+)+`，是真危险不是误报；判据由 P0 实测数据与方案三形态共同约束 |
| console.warn 泄露内部结构 | 旧适配器同样打；这是用户自己的书源、自己的 DevTools |

**评审给的修法本身有错的一处**：`contentReplaceRules` 守卫那条，建议代码取字段 `replaces[i]['pattern']`，而真实字段名是 `rule`（`ContentReplaceRule {rule, replace}`）——照抄会得到一个永不命中的空补丁。已按正确字段名修。


**1.1 / 1.2 实施中发现并修掉的问题**

| # | 问题 | 说明 |
|---|---|---|
| ① | valibot 缺省值写法错误 | `v.array(schema, [])` 的第二参是**校验函数（pipe）**不是缺省值，会让该键变必填 → `Invalid key: Expected "tags"`。正确写法是 `v.optional(schema, default)`。已修 `tags` / `requireUrls` / `headers` 三处 |
| ② | **`extractJsConsts` 续行吞注释**（真 bug） | 续行终止条件没算列 0 的注释行，于是 `HEADERS` 与 `COVER_RULE` 各自把下一行 `// ── 小节标题 ──` 吞进值里 → `HEADERS` 的 JSON 解析失败回退 `{}`，**legado 自定义请求头整个丢失**。由「生成 → 解析」往返测试当场抓到 |
| ③ | `headers` 非字符串值的处理定位 | valibot `v.record(string,string)` 是**严格拒绝**而非丢弃；清洗应在构造 doc 之前的 `extractHeaders` 做，到 schema 这层还带非字符串 = 文档损坏 → 判非法。测试期望已按此改正 |
| ④ | 夹具保真度 | 1.1.0 夹具漏了 `REGEX_HINT_CHARS` / `MAX_EXTRACT_LINKS`，导致 `missingConsts` 断言不符；已按真实源补全（17 个常量，恰好只缺两个作者/分类规则常量） |
| ⑤ | **`literalOf` 单引号字面量带引号返回**（外部评审 P1，真 bug） | `JSON.parse` 只认双引号，单引号字面量走 catch 后早期版本只解包反引号 → `SEARCH_PATH = '/s.php'` 解析成 `"'/s.php'"`，**手写源静默拿到坏搜索路径**。旧代码靠对 `SEARCH_METHOD` 单独加一条剥引号 `.replace` 兜住，等于只给一个字段打补丁。已改成三种引号统一处理，补丁删除 |
| ⑥ | **`parseObjectArray` 无形状校验**（外部评审 P1） | `{"k":1}` 会被 `item as T` 直接放行成 `SearchBodyParam`（`key`/`value` 全 undefined）。已加 `isValid` 逐项校验 |
| ⑦ | **`minDelayMs` 必填与注释矛盾**（外部评审 P1） | 注释写"默认 0"但 schema 是 `v.number()`（必填），不带该字段的文档会解析失败。已改 `v.optional(v.number(), 0)` |
| ⑧ | **条件缺省缺少强制收口**（外部评审 P1） | `searchContentType` 的缺省依赖 `searchMethod`，schema 表达不了；任何不走 `parseJsSource` 的构造路径（legado 导入 / 智能添加 / 未来入口）都会拿到 `undefined`。已把缺省收敛成 `resolveRuleDefaults()` 并要求所有构造路径必过 |
| ⑨ | **`bookCategoryPattern`/`coverUrlPattern` schema 缺省值错**（外部评审 P2） | schema 给 `''`，但模板缺省是 `DEFAULT_PATTERNS.*`。已改为与模板一致 |
| ⑩ | **我自己引入又抓回的保真度 bug** | 修 ⑧ 时先用了 `||`，测试立刻发现它把「显式留空 = 不提取」覆盖成默认值 —— 模板 `smart-rules.ts:481-499` 全程用 **`??`**。已把 `resolveRuleDefaults` 改成 `??` 链，并让 `parseJsSource` 用 `constOrUndefined` 区分「常量缺席」与「声明了空串」。`resolveRuleDefaults` 现在是生成侧缺省链的唯一镜像 |

**P1 前两件的外部审核（provider=coding-bridge）**

`review_code` 再次超时不可达 → 走同 provider 的 `chat` 入口。verdict 行被模型截断，按 fail-closed 判 NOT_APPROVED。
返回 4×P1 + 1×P2，**全部成立**并已修复（⑤⑥⑦⑧⑨，⑩自查）。
评审确认为干净的项：`extractJsConsts` 续行规则、`countBackticks` 的连续反斜杠判据、`v.literal(1)` 的版本分支策略、`v.record` 严格性、`headers` 清洗位置。

### P2 存储（3-4d）— ✅ 代码完成（2026-09-29），外部审核 APPROVED（3/5 轮）

2.1 `booksource-handler.ts` 换 `.json` 读写 + `scanJsonDir` + valibot 失败置 `rulesInvalid` — ✅
2.2 3 个新增 channel（convert / migration-report / legacy-list）+ preload 绑定，删 `booksourceEval`/`sourceHealthCheck` — ✅
2.3 智能添加 + legado 导入直出 `BookSourceDoc`（`generateSourceCode` 标 deprecated） — ✅
2.4 IPC 入参 schema 补进 `electron/ipc/schema.ts`，先 passthrough 观测再收紧（R5） — ✅

- [x] **新旧源并存**：`.js` 仍可读可列（`scanAllSources` 合并），启停按后缀分派
- [x] **坏文件不丢**：坏 JSON / 信封不过的 `.json` 仍进列表，带 `rulesInvalid` 原因
- [x] **不毁用户数据**：convert 拒绝覆盖、拒绝在坏 JSON 上 toggle、归档失败只 warn（`.json` 已落盘）
- [x] **全量**：`tsc -p tsconfig.app.json` 与 `tsc -p electron/tsconfig.electron.json` 均干净；electron/ipc 10 文件 189 用例全绿；Prettier 合规
- [x] **回滚**：开关切 `'js'` + 保留读路径（`.js` 未被移走前一切照旧）
- [x] **P2 剩余验收**：2.3 完成后"新建源全程不产生 `.js`" —— **已达成**（智能添加 + legado 导入两条新建路径的产物均为 `.json`；`generateSourceCode` 仅剩差分基座与存量 `.js` 编辑器逃生口两处调用方，已标 `@deprecated` 并在注释里写明各自何时删）

#### 2.3 新建源产出的关键取舍

| 事项 | 决策 | 理由 |
|---|---|---|
| **缺省不物化进文件** | `buildSourceDoc` **不**调 `resolveRuleDefaults`；`searchContentType` 若**恰好等于**按 method 推导的缺省值就**不写** | 物化后用户把 `searchMethod` 从 GET 改成 POST_RAW、忘了同步 contentType，引擎的 `??` 链会拿**陈旧值**当答案（该发 JSON 却发成 form），且全程无报错。`buildRules()` 探测器**本来就会显式写** form-urlencoded —— 所以"与缺省相等就不写"这条规则是必需的，不是洁癖 |
| **`BookSourceDocDraft` 与 `BookSourceDoc` 分成两个类型** | 前者 = 磁盘形态（valibot 默认字段允许缺席），后者 = 内存形态（缺省已补） | `v.InferOutput` 把 `v.optional(x, default)` 视作**必填**，用它描述磁盘形态会反过来强迫构造器物化全部缺省 —— 恰好制造上面那个后门 |
| **落盘前过 schema，但原样保存用户文本** | 智能添加的 `<textarea>` 允许手改 JSON，保存时 `v.safeParse` 拦一道，然后**写用户看到的那份文本**（不用 parse 结果重写） | 重写会把 schema 缺省补进文件（多出一堆键、diff 全红），而校验的目的只是"拦"；原样保存也符合"所见即所存" |
| **legado 骨架源改为文档而非 JS 骨架** | `enabled: false` + `legadoRaw` 内嵌原始 JSON + `tags` 含 `needs-manual` + 占位规则 | 旧版靠空 stub 函数在被调用时抛错避免静默失败；JSON 侧靠 `enabled: false` 让它**根本不被注册**，更彻底也少一次运行时抛错。`legadoRaw` 字段本就是 P1 为此预留的 |
| **legado uuid 派生规则保持不变** | `deriveUuid` 一行未改 | 书架里 `Book.bookSourceUuid` 已指向旧 uuid，改派生规则会让所有已导入源集体失联且不报错。测试里用同一套 FNV-1a 重算一遍做交叉验证 |
| **书源编辑器页（`book-source-editor`）本轮不动** | 仍面向存量 `.js` | 它是**查看/编辑**存量源的逃生口，不是新建入口；P3.2 页面改造时随 JSON 编辑器一起重做 |

**2.3 顺带清掉的死代码**：`legado-translator.ts` 的 `rewriteHeader()` / `buildHeader()`（写 `// @xxx` 文件头的两个函数）在改为产出文档后**零调用方**，已删除（P1.1 的 P0 审计脚本侧另有登记）。`generateSourceCode` 保留但标 `@deprecated`，注释写明剩余两处调用方各自的删除时机。

#### 2.3 外部审核记录（provider=coding-bridge，session `c8197619`）

R1 给 11 条：**采纳 6**（含 2 条真缺陷）、**部分采纳 2**（只补文档不改行为）、**驳回 3**。

| 评审意见 | 处置 | 说明 |
|---|---|---|
| **P0** legado 导入落盘前**无 schema 校验**（智能添加有、legado 没有） | ✅ 采纳 | 路径不对称是真缺口。已在 `persistSelected` 加上与智能添加同一道的 `v.safeParse` 门；不通过则**不落盘**、进 `failed` 并带可读原因。连带把 4 个旧测试里的 `'js1'` 占位串换成真实合法文档 —— 那些用例原本测的是占位符，现在才真的在测"逐项写入" |
| **P1** `deriveUuid(src)` 与 `deriveUuidFromName(...)` 两套 uuid 派生可能不一致 | ✅ 采纳 | 真缺陷（既有，非本次引入）：种子分别是 `bookSourceName \|\| bookSourceUrl` 与 `bookSourceName \|\| fileName`，**书源名缺失时算出不同 uuid**。已改为 `uuid: doc.uuid`（单一来源 = 文档），并删掉 service 里重复的 FNV-1a 实现 |
| **P1** smart-add 的 `effect` **不追踪 `fileName`** → 改名后文件里的 uuid 陈旧 | ✅ 采纳 | **本次引入的真缺陷**。`fileName` 是普通属性，`[(ngModel)]` 改它不触发 effect（effect 只认 signal），于是"存 `B.json`、里面写 `uuid: "A.json"`"，命名空间连续性静默断裂。已把 `fileName` 改成 `signal`，模板改 `[ngModel]="fileName()"` + `(ngModelChange)` |
| **P2** `impliedContentType` 是对 `resolveRuleDefaults` 的人工镜像，无机械耦合保护 | ✅ 采纳 | 采纳"提取共享函数"这一半（比加测试更强）：已从 `smart-rules.ts` 导出 `impliedSearchContentType(method)`，**`resolveRuleDefaults` 与 builder 共用同一个实现**，镜像消失；另加一条直接比对两者的测试兜底 |
| **P2** `new URL(url).origin` 在 effect 内可能抛异常且被静默吞掉 | ✅ 采纳 | 已换成本文件内 `originOf()`（try/catch 返回空串），不再在 signal 写入路径上抛 |
| **P4** IPv6 / IDN 主机会生成**过不了自家校验**的文件名 | ✅ 采纳 | `sourceDocFileName` 现在把非白名单字符一并替换，保证"输出恒合法" |
| **P3** `compact` 与 `stripUndefined` 是同一个函数 | ✅ 采纳 | 已合并为 `omitUndefined` |
| **P4** `enabled` / `sourceType` 始终物化，与 draft 语义有张力 | ◑ 仅补注释 | 它们在 schema 里是**必填**（非"有缺省的可选"），省略即校验失败。已在代码里写明为何不走 `omitUndefined` |
| **P3** `legadoRaw` 可能含 Cookie / token 等敏感信息 | ◑ 仅补文档 | 与旧"骨架 JS 注释里嵌原始 JSON"是同一份数据、同一份暴露面，**不是新增风险**。已在 schema 字段上写明"将来做导出/分享前必须先脱敏"，避免那一步被漏掉 |
| **P3** 建议给骨架文档加 `skeleton: true` 标记，引擎即使 `enabled: true` 也拒注册 | ❌ 驳回 | 要给 P1 已评审的数据模型加字段 + 引擎加判定逻辑，而触发条件是"用户主动把一个明确标了 `needs-manual` 的源启用"——那是显式行为，不是误操作。占位规则取的是最小合法值（`css:a[href]` / `css:body`），真跑也只是"抓不到"，不会崩。列表页的角标展示归 P3.2 |
| **P4** `isValidSourceDocFileName` 的 CJK 范围 `一-龥` 不含扩展区 | ❌ 驳回 | 该正则**沿用自旧代码**（`.js` 时代一字未改），本次只是换后缀，不是新增限制。放宽它属于独立决策 |
| **P4** `targetUrl` 未纳入 signal 追踪 | ❌ **R2 被推翻**（见下） | R1 我判断"刻意不追踪"是对的，R2 证明是错的 |
| **P4** `targetUrl` 未纳入 signal 追踪（R2 重提） | ✅ 采纳 | **我的判断错了**：不追踪只是**推迟**问题 —— `fileName` 改成 signal 后，改名必然触发 effect 重跑，而重跑时 `buildDocText` 读的是**当前**输入框值，于是"新 URL + 旧页面规则"的文档照样产出。已改为 `analyzedHomepage` **快照**：URL 校验通过后立刻落定（在 `analyzed.set(true)` 之前，避免代码区先闪一份非法文档），`buildDocText` 与规则面板的 `[baseUrl]` 一律读快照。改 URL 后的正确动作仍是重新点「分析」 |

#### 2.3 R2 补记（评审推翻了我的一个判断）

R1 里我以"追踪 `targetUrl` 会用旧规则配新 URL"为由驳回了评审。R2 指出这个理由站不住：不追踪**并不阻止**该组合，只是不让它由"改 URL"直接触发 —— `fileName` 改名同样会触发 effect 重跑，照样读到脏的输入框值。**两条驳回意见（2 条被 R2 接受，1 条 CJK 与 skeleton 被 R2 认可）。**

修法比"追踪"更进一步：把 homepage 变成**分析时刻的快照**，而不是任何可编辑输入的读数。这样 `homepage` 与 `rules` 在构造上就同源，不依赖"用户别乱改"。

顺带修掉同一个不一致的第二处：规则面板的 `[baseUrl]` 原本也绑 `targetUrl` —— 面板的逐阶段测试要把相对 URL 解析成绝对，用当前输入框值会让测试结果配着别的站点，测出来的"命中"是假的。现在同样走快照。

**这个 bug `tsc` 查不出来**：模板里的 `fileName.trim()`（signal 化后应是 `fileName()`）是**内联模板**里的表达式，`tsc -p tsconfig.app.json` 不检查模板（那是 `ng build` + `strictTemplates` 的职责），而本轮我只跑了 `tsc` + `vitest`。两处漏改是在写组件 spec 跑起来之后才暴露的。**教训记在这里：改了 signal 字段就必须跑 `ng build`（或至少有一个真的把组件渲染起来的测试）**，否则模板里的调用点会静默过时。

#### 2.3 R3 收口

| 轮 | verdict | 结论 |
|---|---|---|
| R3 | **APPROVED** | 无新增待修项，未再触发代码改动。2.3 至此收口（3/5 轮） |

#### 2.2 死链删除（按 AGENTS.md「死代码处置」核实）



`preload.sourceHealthCheck` → `preload.booksourceEval` → `pom:booksource-eval` 三段**互相引用成一条自闭环**，全仓零外部消费者：

- `rg "HealthCheck|healthCheck"`（排除 node_modules/dist/docs）只命中 `preload.ts` 定义处；
- `booksourceEval` 的**唯一**调用方是 `preload.ts:116` —— 位于 `sourceHealthCheck` 函数体内部；
- 无 `pomAPI[...]` 动态属性访问，无字符串键间接调用。

故整条删除。`source-health.service.ts` 的文件头注释原写"IPC `booksourceEval` 留作调试入口"是**过时描述**（该服务一直走 `SandboxService`，从未调它），已改为说明本服务不受影响、P4 随沙箱一起删。

#### 2.1 / 2.4 的实现取舍（3 条，均记为偏离）

| # | 事项 | 决策与理由 |
|---|---|---|
| **D8** | **主进程不做 valibot 校验** | 计划 §3.4 写的是"valibot parse 失败置 `rulesInvalid`"，但 `BookSourceDocSchema` 在 `src/app/core/models/`，而 D4 已证明主进程**不能** import `src/`（`rootDir` 锁死 + `TS6059` + 产物污染）。改为：`jsonEnvelopeError()` 只做**信封粗筛**（`format` / `schemaVersion` / `uuid` / `homepage` / `rules` 对象 / 7 个必需规则键是字符串），权威校验与精确字段路径留在渲染端 `RuleEngineService.readDoc`（P1.6 已实现，valibot 单一来源）。**拒绝**把 schema 复制到 `electron/`：两份 schema 必然各自漂移，然后"列表页说合法、引擎说非法"这种最难查的现象就出现了 |
| **D9** | **`.json` 启停走文档内 `enabled` 字段（读改写），不另立 marker** | 与计划 §3.4 一致。理由写进代码：迁移后 `.js` 会被移走，marker 与源文件分家正是"改了一个另一个没跟着变"的来源。坏 JSON 上 toggle **抛错而不是覆盖**（否则 `{}` 会抹掉用户整份文档） |
| **D10** | **`safeFileName` 只加"禁控制字符"，不加 `.json` 白名单** | 计划 §3.4 写的是"收紧为必须 `.json` 后缀 + 禁控制字符"。但迁移期两种后缀共用同一个 `safeFileName`，此时加白名单会**直接打死 `.js` 全部读写**。故：控制字符禁令现在生效（对两种后缀都安全，且 `[\u0000-\u001F\u007F]` 能把日志从中间截断，是真实的可读性/安全收益），`.json` 白名单推到 **P4**（`.js` 通道删除后）—— 已在代码注释里标注该前提 |

**另有一处**：`booksource-list` 改为返回 `.js` + `.json` **合并**列表而非分流。渲染端 `BookSourceListStateService` / `import-via-source` 消费的是同一个 `BookSourceMeta[]`，分流就得改消费方（P3.2 才动页面）。新增 `format: 'json'` + `rulesInvalid` 两个字段供消费方按后缀分派，`BookSourceMeta` 既有字段一个没改。

#### P2 外部审核记录（provider=coding-bridge，3/5 轮 APPROVED）

session `44093c22`，共 9 条意见：采纳 8 条（其中 1 条 P0、1 条 P2 为真实数据丢失/状态反转路径）、驳回 1 条（2 条并列的其中一条）。

| 轮 | 结论 | 要点 |
|---|---|---|
| R1 | NEEDS_CHANGES | 4 条 P0/P1 + 3 条 P2 建议。**采纳 6**（含 P0：`convert` 只查 `format` 就落盘 + 归档可搁浅用户书源）；驳回 1（缺类型注解，事实错误）；部分采纳 1 |
| R2 | NEEDS_CHANGES | 2 条均成立：① `.js` marker toggle **先删后写**，写失败会让用户明确禁用的源**静默变回启用**（`scanDir` 无 marker = 走缺省 true）；② 归档跨文件系统 `EXDEV` 只 warn，导致 `.js` 与 `.json` 在主目录并存且再次转换被"目标已存在"拒绝 |
| R3 | **APPROVED** | 逐条复核两条修复（含"copy-then-unlink 能否在无完整副本时删源"= 不能），并给出 11 条数据安全路径的完整核对表，无未解决问题 |

**R2 补充订正**：先删后写**不是** R1 的 `rmSync` 改动引入的 —— 原始代码就是 `if (existsSync(a)) unlinkSync(a); if (existsSync(b)) unlinkSync(b); atomicWrite(...)`。R1 修 TOCTOU 时**保留**了这个顺序，等于把既有缺陷带了过来。缺陷本身是真的（且违反"失败不得改变用户状态"的契约），已改为**先写、成功后再删对立的那一个**。`scanDir` 原本就有 `.disabled` 优先于 `.enabled` 的判定，R2 后这条规则**从"防御性"变成"承重"**（双 marker 并存时的兜底），已在代码注释里写明为什么。

**跨盘归档**：`sourceDir` 指向外部盘/网络盘是**支持场景**（外部目录导入的书源会带自己的 `sourceDir` 迁移），`EXDEV` 不是边角情况。已加 copy-then-unlink 回退，顺序保证「副本完整落盘前绝不 unlink 源文件」。

#### P2 死代码删除留痕（AGENTS.md 要求同 commit 记 `docs/CONVENTIONS.md §exceptions`）

session `44093c22`。R1 给出 4 条 P0/P1 + 3 条建议，**5 条采纳并修、1 条部分采纳、2 条驳回**（详见下方）。修复均已补回归测试。

| 评审意见 | 处置 | 说明 |
|---|---|---|
| **P0** `convert` 只查 `format` 就落盘+归档，可**搁浅用户书源** | ✅ 采纳 | 真缺陷：一份缺 `rules.searchPath` 的文档会写进 `booksources/` 并把可用的 `.js` 移走，用户看到"迁完了却不能用"且不知道去 `legacyDir` 捞。已在写入与归档**之前**插 `jsonEnvelopeError()`，不合格直接抛、源文件原位不动（+2 条回归测试） |
| **P1** schema 的 `safeName` 弱于运行时 `safeFileName`（漏 `..` 中缀与控制字符） | ✅ 采纳 | 不是当下的漏洞（handler 仍调 `safeFileName`，两层都在），但 P3.2 接线后有人看到"schema 已拦"就把运行时那层删掉 → 两层同时失效。schema 已与运行时**逐条对齐**（`^(?!.*\.\.)` + 控制字符全挡 + 裸 `.`），并在注释里写明"`safeFileName` 始终是最终裁决者" |
| **P1** `safeFileName` 未拒裸 `.`（`path.join(dir,'.') === dir`，delete 会去删目录本身） | ✅ 采纳 | 已加 `input === '.'` 判定（+ 测试） |
| **P1** `parseJsonMeta` 的 `base` 缺 `homepage`，坏文件与好文件**形状不一致** | ✅ 采纳 | 坏文件缺键 → 渲染端读 `meta.homepage` 得 `undefined` 而非 `''`。已抽出 `baseJsonMeta()` 工厂并补齐全部键；新增一条测试**直接比对正常/坏两条路径的键集必须完全相同**（这比逐字段断言更能防复发） |
| **P2** `scanJsonDir` 读失败路径用 `parseJsonMeta('')` 再覆盖 `rulesInvalid`，逻辑绕弯 | ✅ 采纳 | 正是上一条的根因；改为直接 `baseJsonMeta()` + 覆盖 |
| **P2** `.js` marker 清理 `existsSync`+`unlinkSync` 有 TOCTOU 竞态 | ✅ 采纳 | 文件在两步之间被外部动过会抛 ENOENT，用户看到"切换失败"。改 `fs.rmSync(p, {force:true})`（force 语义正是这里要的） |
| **P2** `resolvePath` / `resolveDir` 缺参数类型注解 | ❌ 驳回 | 事实错误：压缩 payload 时手抄漏了注解。`electron/tsconfig.electron.json` 开 `strict: true`，隐式 `any` 参数会直接编译失败；真实文件为 `resolvePath(userData: string, fileName: string, sourceDir: string \| null \| undefined): string \| null` 与 `resolveDir(userData: string, sourceDir: string \| null \| undefined): string \| null`，且 `tsc` 干净 |
| **P2** `sourceDir` 未拒含 `..`，建议加归一化检查 | ❌ 驳回 | 加了也不增加任何约束：`sourceDir` 本来就能是**任意**绝对目录（`/etc` 也放行），`/home/u/../../../etc` 与 `/etc` 归一后等价。若真要边界，该约束是"必须位于 userData 之下"，而现设计刻意不支持（多镜像 / 外部目录场景）——那是独立的设计决策，不该由一条 review 意见顺手塞进来 |

### P3 迁移 + 页面（4-5d）— ✅ 代码完成（2026-09-29），外部审核 APPROVED（3.1 2/5 轮 + 3.2-3.5 2/5 轮）

#### 3.1 存量迁移（规则判定 + 编排 + IO）— ✅ 代码完成（2026-09-29），外部审核 APPROVED（2/5 轮）

- `core/logic/rule-migrate.ts`（纯函数，28 用例）：`normalizeLegacyMeta` / `checkPureTemplate` / `detectSkeletonSource` / `migrateJsSource` + `MigrationReport` 词表
- `core/services/book-source-migrate.service.ts`（编排，14 用例）：读列表 → 逐个读全文判定 → 调 convert / archive → 写报告
- `electron/ipc/booksource-handler.ts`：新增 `pom:booksource-archive`（needs-manual 只归档不产 JSON，连带搬 marker）+ `convert` 补 marker 清理；两个 channel 改走 `safeHandle`
- `app.config.ts`：迁移串在 `initBookSources` **内部**

**自查发现并修掉的（4 处，都是本轮新引入）**

| # | 问题 | 处置 |
|---|---|---|
| ⑰ | **对象字面量的 `}` 被当成语句边界** | `const SEARCH_BODY_PARAMS = [{…},{…}]` 闭合后的 `,` 被判成"顶层非白名单语句" → 真实存量源全部误判 needs-manual。加栈记录每个 `{` 是块还是对象字面量（由前一个有效字符判定） |
| ⑱ | **只数花括号，跨行数组的续行被当新语句** | `(` `[` 一并计入深度（手写源常把 `SEARCH_BODY_PARAMS` 摊成多行） |
| ⑲ | **正则字面量里的 `{` 打乱层级** | `/\d{1,3}/` 里的 `{` 会被当代码块开头。`buildSkeleton` 把字符串 / 模板串 / 正则 / 注释**等长**挖成空格，配对只在代码上成立（长度守恒是 `original.slice(offset+i)` 仍能取到原文的前提） |
| ⑳ | **`looksLikeObjectLiteral` 含 `>`**（自查，非评审） | 箭头函数体 `=> {` 被当对象字面量 → 闭合后 `atStmtStart` 不复位 → **其后那条顶层语句整条漏检**。已移出字符集并加回归测试（`const SEARCH_RAW_BODY = x => {…}` 后跟 `function hidden()`，必须被判手改） |

**真实存量书源对抗验证**（临时探针跑完即删）：本机 `~/.config/pomreader/booksources` 的 1 个真实源 + `~/htdocs/ireader/fixtures/booksources` 的 9 个夹具 → **9/10 判纯模板**；唯一被判 needs-manual 的是 `sample-manual.js`（夹具里刻意手改的），理由精确到 `模板外常量声明: const CUSTOM_BLACKLIST`。对照 `sample-extra.js`（只改白名单常量的**值**）判纯模板 —— 值正是要保留的东西，不该判手改。

**新增 IPC channel 的必要性**：`pom:booksource-convert` 只能做"转换"，needs-manual 分支需要"只搬 `.js` 不写 JSON"，没有对应 channel 只能绕。`archive` 的 `reason` 参数**只作留痕**，刻意不参与任何路径计算（原因文案可能含用户站点名）。

#### 3.1 外部审核记录（provider=coding-bridge，session `218e5937`，2/5 轮 APPROVED）

| 轮 | verdict | 结论 |
|---|---|---|
| R1 | **NOT_APPROVED**（无 verdict 行，fail-closed） | 7 条：3×P0（ASI 换行复位 / 归档同名覆盖 / moveToLegacy 吞异常）+ 2×P1 + 2×P2。**采纳 3 条、驳回 4 条**，见下 |
| R2 | **APPROVED** | 逐条接受 3 条驳回的理由（逐一复核，含"接口无索引签名不可赋给 `Record`"的 TS 实证），确认 `moveToLegacy` 按调用点分治是"极其稳健的设计" |

| 评审意见 | 处置 | 说明 |
|---|---|---|
| **P0** 换行复位 `atStmtStart` 会误判，建议删掉 | ❌ 驳回 | 模板生成的代码**通篇无分号**（`generateSourceCode` 产出 `const BASE_URL = "…"` 后面没有 `;`）。删掉复位 → 第一条 `const` 之后永不复位 → 后面每条顶层声明都被当成同一条语句的延续跳过 → **整个白名单检测彻底失效**（手改全部检不出）。比误判严重一个量级。评审举的 `const a =\n 'x';` 也不会误判：`buildSkeleton` 已把字符串挖空。残余风险（链式调用跨行误判 needs-manual）方向保守，已在 `findViolation` 注释里写明 |
| **P0** 归档静默覆盖同名文件，建议加 uuid 后缀 | ❌ 驳回 | 迁移只扫主目录（`pom:booksource-list` = `scanAllSources(primaryDir)`），"不同 sourceDir 的同名 .js 同时进迁移"不可能发生 —— 迁移阶段根本看不到外部目录的文件。重复归档需用户主动从 legacy 拷回，属用户自造歧义，"最新覆盖"符合直觉。加后缀反而让"拷回即回滚"不可预测 |
| **P0** `moveToLegacy` 吞异常 → 报告与实际不符 | ◑ **部分采纳** | 现象成立，但**两个调用点的正确处置相反**，不能一刀切抛。`archive`（什么都没落盘）**采纳**：失败必抛，否则渲染端记成"已归档"而 needs-manual 清单是扫 `booksources_legacy/` 得来的 —— 用户收到"需要手动处理"却找不到它（幽灵条目）。`convert`（`.json` 已落盘）**不采纳**：抛了会把一次**可用**的迁移报成 failed；且 `.js` 残留后下次启动会因"同 uuid 的 JSON 已存在"判 **skip**（不是再次报错），不抛才是自愈的。改法：`moveToLegacy` 返回 `{ok, error}` 由调用点各自决定，各加一条回归测试 |
| **P1** `looksLikeObjectLiteral` 判据含 `;` 自相矛盾 | ✅ 采纳 | `; {` 在 JS 里是块语句。已移除（`>` 已在自查阶段移除，见 ⑳） |
| **P1** `failed` 记录应提前用 `meta.fileName` | ✅ 采纳 | 读文件阶段就抛错时那条路径没走到过 `fileNameOf`，回退值 `'(未知文件)'` 让报告出现无法定位的记录。改用 `normalizeLegacyMeta(raw).fileName`，并删掉 `fileNameOf` |
| **P2** `missingRequiredRules` 应用 `Record<string, unknown>` 而非 `object` | ❌ 驳回 | 实测编译失败：`TS2345: Argument of type 'SourceRulesLike' is not assignable to parameter of type 'Record<string, unknown>'. Index signature for type 'string' is missing`。接口无隐式索引签名，与 `source-doc-build.omitUndefined` 用 `object` 是同一个原因 |
| **P2** `blank` 应同时保留 `\r` | ❌ 驳回 | 挖空的契约是**长度守恒**（等长替换），`\r` 换不换成长度都不变，`original.slice(offset + i)` 的偏移本就正确 |

**3.2–3.5 待办**

3.2 页面改造：list / editor / debug / test / smart-add（5 个）+ import-legado modal
3.3 周边服务改挂：`cf-prompt`（public 化 + 引擎直调）、`source-health`、debug 进度区改 RuleTrace
3.4 三个文件迁出 `js-source/`（`source-meta.types` / `cf-prompt` / `source-health`）—— P4 删除前的硬前置
3.5 `booksources_drafts/` 换 JSON 格式

- [x] **验收**：① 老书库启动后全部转 JSON 源且功能正常 —— 代码路径已就绪（迁移 → 装载串行），**但本机书库仅 1 个源，需真实书库重跑确认**；② `Book.bookSourceUuid` 引用计数迁移前后不变 —— uuid 口径已用测试钉住（无 `@uuid` 时回退带扩展名的文件名；legado 派生一字不改）；③ needs-manual 清单常驻可见 ✅（列表页归档区 + 「查看原始 JS」）
- [ ] **回滚**：从 `booksources_legacy/` 还原

#### 3.2–3.5 页面与周边改造（2026-09-29）

**3.2 引擎接线（P0 缺口，补在最前）**：`registerRuleAdapters` 在 3.1 落地时**全仓无人调用** —— 迁移产出的 `.json` 没有任何东西装载，症状是"迁移报告说成功了，但搜不到那个书源"。新增 `registry.loadAllRuleAdapters()`（与 `loadAllJsAdapters` 同构，分派靠 `format` 字段而非后缀），由 `initBookSources` 在 `migrate()` **之后**串行调用。顺序反了它就什么也装不上。

**3.2 五个页面**

| 页 | 改法 | 为什么不是"顺手改改" |
|---|---|---|
| list | 加引擎开关控件 + `rulesInvalid` 红标 + needs-manual 归档区（常驻）+ 首次进入的迁移汇总弹窗 | needs-manual 若只弹窗就等于没告知（用户几天后才想起来处理，弹窗早关了）；归档区只读、不可启停（那些源不在 `booksources/` 里，启停对它没意义），只给「查看原始 JS」 |
| editor | **删掉源码 textarea + 两条"生成/应用"按钮 + 整段反向解析**，改为「元信息表单 + 规则面板 + 只读 JSON 预览」 | 三条路各自对应一个已不存在的问题：源码规则要靠 `parseRulesFromSource`（一段与 `parseJsSource` 重复的正则）**反向**回填面板，而反向解析与正向生成不同源 → 用户改的面板值与真正生效的值可能不一致。文档本身是唯一真相，不需要"应用"。保留的 JSON 预览现在**说的是真话**（`serializeSourceDoc` 的直接输出，与写盘逐字节相同） |
| debug | `resolveTarget()` 分派：规则源走 `RuleEngineService`，JS 源走沙箱；过程区规则源显示 **RuleTrace 轨迹表**（URL/状态码/耗时/提取条数/CF 标记），JS 源仍显示沙箱 progress | 两者不是一回事：沙箱 `progress` 是用户代码 `log()` 的自由文本（模板不 log，规则源下恒空），RuleTrace 才是排障要看的"这次请求打到哪、返回了什么" |
| test | 抽 `TestExecutor` 抽象，`SandboxExecutor` / `RuleExecutor` 各 10 行 | 不抽的话每一步都要写一遍 `if (是 JSON 源) … else …`，四步八处分支，且**步骤顺序、校验口径、超时记账会被复制两份** → 改一处忘另一处就出现"规则源和 JS 源测试结论不一致" |
| smart-add / import-legado | **无需改动**（P2.3 已提前做完：保存/落盘走的都是 `serializeSourceDoc`） | — |

**3.3 `cf-prompt` 迁出 `js-source/` → `core/services/`**：它服务**两条**链路，留在 `js-source/` 会让新引擎反向依赖一个 P4 要整目录删的目录。构造函数里注册沙箱钩子那行随沙箱在 P4 消失。

**3.3 `source-health` 删除（不是迁出）**：`rg "SourceHealth|source-health|detectCapabilities|detectBatch|sampleTest"` → 零生产消费方（管理页从未接能力图标）。更关键的是它的能力语义**对 JSON 规则源无信息**：`detectCapabilities` 返回沙箱 `fns`，而规则引擎四入口恒在（恒等于"全有"）。方案 §5 原计划把它改挂成"JSON 合法性校验"后迁出 —— 那是 `rulesInvalid` 的**真子集**（`rulesInvalid` 已由主进程 `parseJsonMeta` 给出并驱动列表页红标）。迁一个零消费者的空壳是纯 churn，故按 AGENTS.md 死代码处置删除 + `docs/CONVENTIONS.md §exceptions` 留痕 #4。连带清掉 `tsconfig.app.json` 的 4 条 include 之一。

**3.5 草稿只收 `.json`**：`rg "saveDraft|drafts" src/` → 渲染端**零调用方**，"同步换格式"当下没有存量 `.js` 草稿要迁，所以改的是**新写入的口径**（`save-draft` 加后缀门）。通道保留不删：它是已实现的存储原语，删掉只会在下次要加草稿按钮时让人重写。

**暗色配色事故（自查）**：`nz-collapse`（editor 的两个折叠区）全站只有这一处在用，`ng-zorro-overrides.scss` 里**无任何规则** → 暗色模式下一块白底。改用原生 `<details>` + `--pom-*` token 自绘，不为一个页面新增全局覆盖。顺带发现 `:host-context(.dark)` 是**死选择器**（全仓无任何代码加过 `.dark` 类；真实暗色开关是 `<html data-pom-theme="6">`），已换成 `:host-context([data-pom-theme='6'])` 并在注释里写明原因避免再照抄。

**3.2–3.5 校验**：`ng build` 通过；全量 **79 文件 / 1358 用例全绿**；两端 `tsc` 干净；**eslint 全仓 0 error**；Prettier 合规。

**收口时又清掉 8 个 lint 错误**（全是本会话新建/改动文件里的残留）：4 个未用导入（`legado-translator` ×2 / `rule-parse` / `smart-rules.spec`）、1 个未用常量（迁移 spec）、1 个多余转义（`source-doc-build`）、1 处刻意的 rest-omit 解构（model spec，改 `_` 前缀）、1 处 `no-control-regex` 误报（`schema.ts` 的"禁控制字符"规则**就是**要显式写出控制符区间，加注释豁免并写明理由）。

**顺带把两个"查不到类型"的文件纳入 `tsconfig.app.json` include**（`header-parser.ts` 与差分基座 `legacy-runner.ts`）——它们不在 tsc program 里，导致 `@typescript-eslint/parser` 报 `parserOptions.project` 且**其类型错误从未被检查过**。纳入后立刻暴露 `legacy-runner.ts` 的 shim 类型不兼容：worker 侧用 `as unknown as (req: unknown) => …` 硬转是因为签名写成了 `Record<string, (...args: unknown[]) => …>`（逆变不接受 `(url: string) =>`）。差分基座改成**具体形状** `ShimHttp`，去掉了那层逃逸。

**一次被差分基座当场拦下的"改进"**（记录在案，因为它正是本项目反复拒绝的形态）：我给 `legacy-runner.respond` 的错误串加了 URL（`HTTP 503 (https://…)`），理由是"好定位"。差分基座的核心断言是**两侧错误文案逐字相同**，于是 2 条用例立刻红 —— 规则引擎那侧仍吐 `HTTP 503`。已回退，并在代码里写明：错误串是两条链路的**可观测等价契约**，单边加信息就是制造漂移，与 T-18 那 4 处怪癖同款；定位靠 fixture 名称，不靠错误串。

#### 3.2–3.5 外部审核记录（provider=coding-bridge，session `6e6f6a12`，2/5 轮 APPROVED）

| 轮 | verdict | 结论 |
|---|---|---|
| R1 | **NOT_APPROVED**（无 verdict 行，fail-closed） | 7 条：2×P0 + 2×P1 + 2×P2 + 3×P3。**采纳 5 条、驳回 2 条**（其中 1 条系我 review payload 截断所致） |
| R2 | **APPROVED** | 逐条接受 2 条驳回理由与 1 条驳回+修正；确认 `dropRuleAdapter` 倒序 `splice` 无 off-by-one、零断言 `Promise<unknown>` 的收窄安全、round-trip 测试"比加 spread 更准确地保护字段" |

| 评审意见 | 处置 | 说明 |
|---|---|---|
| **P0** `clearRuleAdapters` 只清 `ruleAdapters` 未清 `adapters` | ❌ 驳回 | **我 review payload 压缩失误**：贴了 `registerRuleAdapters` 却把 `clearRuleAdapters` 的函数体截掉了。真实实现是 `for (const a of this.ruleAdapters) { const i = this.adapters.indexOf(a); if (i >= 0) this.adapters.splice(i, 1); }` —— 两张表都清。且它给的修法（`this.adapters = this.adapters.filter(...)` / `this.ruleAdapters = []`）**无法编译**：两个字段是 `readonly` |
| **P0** `if (!doc.enabled) continue` 导致旧适配器残留 | ✅ 采纳（**潜在**非现存） | 结论对，但两处要修正：① 可达性 —— `registerRuleAdapters` 目前只被启动时跑一次的 `loadAllRuleAdapters` 调用，无人能触发，是"契约可重复调用"的潜在缺陷，评审自评降为 P1-latent；② **它给的修法会引入新 bug** —— 把同 uuid 清理提到 `enabled` 判断之前，会连带删掉同 uuid 的 **JS 适配器**（迁移期唯一的可用实现），把"禁用新源"变成"这个源彻底消失"。改用 `dropRuleAdapter(uuid)`：只遍历 `ruleAdapters`、按**对象同一性**从总表摘除；"JSON 胜出"的全局顶替只在**真的要装**时执行。刻意不用 `instanceof JsonRuleAdapter` —— registry 既有设计明确不反向依赖 `json-rule`/`js-source` 类型层级（`getByUuid` 同款注释）。配 4 条新测试（禁用后重装移除、重装幂等、不同 uuid 的 JS 适配器不被误删、内置站点适配器不受波及） |
| **P1** `Number(args[1] ?? 1)` 空串得 0 | ✅ 采纳 | JS 语义确实如此（`'' ?? 1` 是 `''`，`Number('')` 是 0 → `?page=0` → 空结果）。今天两处都传字面量 `1`，属防御性收口（代码里写明）。新增 `toPage()`：`''`/`undefined`/`Infinity` → 1，`1.5` → floor |
| **P1** `call<T>` + `as Promise<T>` 掩盖契约 | ✅ 采纳 | 改为 `call(fn, args): Promise<unknown>`，**两个实现零断言**。立刻暴露步骤链里两处隐藏形状假设（`v.length` / `pickBookUrl(items)`），改为真收窄 |
| **P2** `jsonPreview` 每次按键重跑 `safeParse` | ✅ 采纳 | 拆成 `buildDraft()`（拼装）与 `serializeValidatedDraft()`（拼装 + 权威校验）；预览只走前者。校验不改变写入字节，故预览文本与实际存盘仍一致 |
| **P2** `buildSourceDoc` 可能丢字段，建议 `{...current}` | ◑ **部分采纳** | 建议**无效**：`BuildSourceDocInput` 是闭合 18 字段接口，`buildSourceDoc` 显式返回字面量、不透传未列出的键，`...current` 要么 excess property 编译失败要么是空操作。逐字段核实当前**传全 18 个**（无现存丢失）。改用可落地的防线：新增 `book-source-editor-doc-roundtrip.spec.ts`（8 例）——字段齐全的文档过一遍真实拼装形状，断言 schema 每个键都在、uuid 不变、`legadoRaw`/`headers`/`minDelayMs`/`requireUrls` 原样保留、两次往返字节一致。**该测试当场教了我一件事**：`searchContentType` 是 P2.3 的**有意**丢弃（恰等于推导缺省时不落盘，否则用户改 `searchMethod` 会带陈旧值），已 pin 成显式期望 + "这是唯一被推导掉的字段"一条测试 |
| **P3** 构造器简写 / `as unknown as` / 超大归档预览 | ✅ 全部采纳 | `SandboxExecutor` 改参数属性；`booksourceList`/`booksourceLegacyList` 提到全局 `Window.pomAPI` 且类型为 `Promise<BookSourceMeta[]>`，顺带删掉 `page-fetcher.service.ts` 里一处**重复声明**；预览 200K 字符截断 + 明确提示（静默截断会让用户误判文件完整性） |

### P4 下线（1d，单独发布）— ⏳ Pending

4.1 删 `js-source/`（余 13 文件）+ `generateSourceCode` 代码生成段 + `build:worker` + 运行时开关
4.2 清 `tsconfig.app.json:12-15` 的 4 条 include + `eslint.config.js:53` ignore（顺手，非阻断）
4.3 文档同步：README 项目结构 / CONVENTIONS §exceptions / BOOKSOURCE_GUIDE / CHANGELOG

- [ ] **验收**：`rg "sandbox|generateSourceCode|parseHeaderMeta|booksourceEval"` 在 `src/` 零命中；`tsc`/`ng build`/全量测试绿
- [ ] **回滚**：从 tag 回滚（故单独发布）

## 3. 与上游设计的偏离记录

| # | 偏离 | 原因 |
|---|---|---|
| D1 | P0 脚本用 `.cjs` 而非方案写的 `.ts` | 本仓**无** `tsx`/`ts-node`，`scripts/` 下 5 个脚本全是 `.cjs` 由 node 直跑；`vitest` 的 `include` 只覆盖 `src/**` 与 `electron/**`，`scripts/` 不在测试范围。跟随既有约定 |
| D2 | P0 第 4 项「`Book.bookSourceUuid` 引用统计」降级为「uuid 清单输出」 | 书库是 `pouchdb-browser` + IndexedDB（`db.service.ts:157`），数据在 Chromium profile 内，**node 脚本不可达**。P0 改为输出每个源解析出的 uuid 供 P3 对拍；跨库引用核对放到 P3 验收（应用内查询） |
| D3 | `PageFetcherService` 位置修正 | 实际在 `core/book-source/page-fetcher.service.ts`，非 `core/services/`（方案 §3.2 已按实际引用） |
| **D4** | **存量迁移宿主：主进程 → 渲染端**（2026-09-29 用户决策） | 方案原选主进程，但 `build:electron` 是 `tsc -p electron/tsconfig.electron.json`（`rootDir` 锁死 `electron/`、`exclude: ["../src"]`），主进程 import `src/` 的 `rule-migrate.ts`/`rule-parse.ts` 会报 `TS6059`。**更糟的是 tsc 在报错的同时无视 `--noEmit`、把被拉入的文件就地输出到 `src/`**（实测在 `src/app/core/book-source/smart-add/` 生成 `.js` + `.js.map`），且这两个产物**不在 .gitignore**。改用 Angular `provideAppInitializer`：竞态由框架保证消除（未 resolve 前不 bootstrap），纯函数保持单一来源，零构建改动。方案 D4/§4.2/附录 A 已同步修订 |
| **D5** | **运行时开关加了 `hasRuleDocs` 兜底输入**（P1.7） | 方案 §3.3 的 `resolveEngineMode` 只按 `'rule'\|'js'\|'both'` 判定，缺省 `'rule'`。但 **P1/P2 阶段磁盘上一个 JSON 源都没有**（`.json` 读写在 P2 才落地），机械照搬的结果是"缺省 rule → 不装 JS" → 用户升级后**所有书源凭空消失**，开关自己关掉了自己唯一的实现。故规则改为：**选了 `rule` 且 `hasRuleDocs === false` 时仍装 JS**（fail-open）。P3 接上 `registerRuleAdapters` 后该输入恒为真，兜底自然失效，届时可删掉这个参数 |
| **D6** | **JSON 适配器 `unshift` 到最前，JS 链路保持 `push`**（P1.7） | 方案 §3.3 写的是 `JSON > JS > 内置` 三级优先级。P1 只落地前两级：把 JS 也提到内置之上属于**独立的行为变更**（会改变 5 个内置站点适配器与用户书源的命中关系），不在本任务范围，留在 P3 与 `spec §4 R-2` 一并决策 |
| **D7** | **`resolveRuleDefaults` 落点从 `core/logic/rule-parse.ts` 迁到 `smart-rules.ts`** | 1.2 原把它放在解析器里；但它镜像的是 `generateSourceCode` 的缺省链，且 `createRuleEngine` 也要过它 —— 引擎若反向依赖"遗留 JS 源码解析器"，就把长期存在的引擎绑在迁移期工具上。迁到被镜像的一侧后，配套新增 `ResolvedSourceRules` 类型，让"收口后可选字段必有值"由类型保证 |
| **D11** | **迁移不单独挂 `APP_INITIALIZER`，改为串进 `initBookSources` 内部**（3.1） | 方案 §4.2 写的是"渲染端 `provideAppInitializer` 中 await 执行"。但 Angular 的 `ApplicationInitStatus.runInitializers` 是 `Promise.all`（实测 `node_modules/@angular/core/fesm2022/_debug_node-chunk.mjs`：按注册顺序**同步调用**、**并发 await**）—— 单独挂一个 initializer 与 `loadAllJsAdapters` 之间**没有执行顺序保证**。那样 registry 可能装上**迁移前**的源，症状是"首启搜不到某些书源、重启一次又好了"。串进同一函数内 `await` 是**更强**的保证（迁移完成才注册内置适配器），且不多写一个 initializer |
| **D12** | **`resolveEngineMode` 的 `hasRuleDocs` fail-open 兜底**保留到 P4，**不**按原计划删除 | 方案 §4.2 / D5 写"P3 接上 `registerRuleAdapters` 后 `hasRuleDocs` 恒为真，这条兜底自然失效"。**该推断不成立**：`hasRuleDocs` 恒为真的前提是"每个用户都成功迁移了"，而迁移失败是常规场景（`booksources/` 不可写、盘满、外部目录无权限）—— 那时删掉兜底的结果正是它当初要防的事故：**所有书源凭空消失**。兜底的前提是用户磁盘上的**实际状态**，不是代码进度，故不随阶段失效。真正的删除时机是 P4（`useJs` 概念整体消失） |

## 4. 风险（承接方案 §8，此处只记实施期新增）

| # | 风险 | 缓解 |
|---|---|---|
| I1 | 本机书库仅 1 个源，P0 报告统计意义有限 | 报告如实标注样本量；结论只在「模板漂移 / 常量缺失」这类**结构性**问题上采纳，涉及比例的决策（D1 细部）需在用户真实书库重跑后再定 |
| I2 | 存量源模板版本比方案记录的更多（已见 1.1.0，方案只记 1.0.0/1.2.0） | 迁移必须容忍缺常量（按空串处理），不得因缺 `SEARCH_AUTHOR_RULE`/`SEARCH_CATEGORY_RULE` 判 needs-manual |
| I3 | 差分测试若被做成联网 e2e 则失去确定性断言 | 强制走离线打桩（`fixtures/worker-stub.ts`），P1 合入门禁 |
| I4 | 差分基座的形态覆盖仍窄：现有 1 个 CSS 形态（`SAMPLE_RULES_CSS`）+ 1 个 POST 形态，**未覆盖**方案 §7.1 点名的多形态（正则单模、GBK、多个净化规则、空 `searchPath` 等） | 引擎单测（`engine.spec.ts` 22 条）已逐条钉住这些分支，差分侧待 P2 拿到真实 JSON 夹具后补齐；补齐前不得宣称"差分覆盖了全部形态" |
| I5 | ReDoS 判据保守 → `(\d{1,3})*` 等"内层有界重复"形态**漏报**（见 P1 ⑬） | 已登记取舍理由；判据重估必须以真实书库 P0 重跑数据为依据，否则收紧即批量误杀存量源 |
| I6 | 引擎与旧沙箱共有 4 处存量怪癖（`$` 特殊模式、`.replace` 只替首个、正则无捕获组产出 `undefined`、`urls[0]` 不做 failover） | P1 逐字复刻（改一边就是制造漂移）；要修必须两侧同改，已登记为二期项 |

## 5. 验收与归档

- 每阶段完成后勾选对应验收项并在本文件更新状态
- 全部完成后移入 `docs/Task/Archive/2026-10/`，更新 `docs/Task/README.md` 索引
