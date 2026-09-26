# 智能添加支持 CSS 选择器规则 — 任务计划

**Status**: ✅ Completed (completion time: 2026-09-26)
**Created**: 2026-09-26

## 任务目标与背景

legado 原应用的规则支持 `dl.list dd a` 这样的 CSS 选择器配置。真实搜索页 HTML(用户提供样例）中每本书在 `dl.list > dd` 下有 **3 个相同 href 的锚点**(img 链接 / h4 书名链接 / 「免费阅读」按钮），正则既无法稳健表达「dl.list 内 dd 下的 a」，又会产生重复/空书名结果。

目标：智能添加的全部规则字段（搜索列表项 / 标题 / 作者 / 章节链接 / 正文）同时接受 **CSS 选择器** 与 **正则** 两种写法，测试、代码生成、沙箱运行全链路支持。

## 问题分析与现状

- `smart-rules.ts`：`matchLinkItems` / `pickText` 仅支持正则；生成代码在沙箱 Worker 内用 `RegExp` 执行。
- 沙箱 Worker(`sandbox.worker.ts`)：无 DOM、无网络（仅 `legado.http` 代理）,classic worker 设计不用 ES import。
- 渲染进程（智能添加测试）与 vitest(jsdom）有原生 `DOMParser`;Worker 没有。
- 已有 `legado.http` 的「Worker → 主线程 postMessage 代理」模式可复用。

## External Review Opinion (Phase 0 — requirement)

provider=coding-bridge, Round 1/1(plan-kind 默认单轮）。采纳的修正：

1. **去重仅限 CSS 模式**；正则路径结果保持字节级向后兼容。
2. **废弃纯启发式自动检测**(`a[href^="/book"]` 含 `^` 会误判）→ 采用 `css:` 显式前缀为主，「无正则元字符 + 语法合法」的安全推断为辅。
3. **URL 绝对化在主线程完成**,`baseUrl` 作为 `legado.query` 参数传入。
4. **主线程 DOMParser 加 5MB 输入上限**防 OOM。
5. 评审建议的 `engineVersion` 标记 → 不采纳：shim 为纯新增能力，V1 正则书源不调用 `legado.query`，天然不受影响，无需版本分叉。
6. 评审建议的批量查询/DOM 缓存 → 列为后续优化（单页 1~3 次查询，开销可接受）。

## 规则模式判定约定（双端一致）

```
css:dl.list dd a        → CSS（显式前缀，最高优先级）
dl.list dd a            → CSS（无正则元字符）
dl.list dd a[href]      → CSS（[] 属合法属性选择器）
<a[^>]+href="..."       → 正则（含 \ [^ " 等）
作者[：:]\s*(...)        → 正则（含 \ ( ))
a[href^="/book"]        → 含 ^ 误判为正则 → 用户加 css: 前缀强制
```

判定逻辑（纯字符串，Worker 内可用，无需 DOM），按优先级：

1. `css:` 前缀 → CSS；
2. 含正则特征（`\` `(` `)` `{` `}` `[^` `^` `$` `?` `|` `*` `+`）→ 正则（实施时补充 `*` `+`：否则 `第.*章` 这类无量化符特征的正则会误判为 CSS；属性选择器含 `*`/`+` 的情形同样走 `css:` 前缀兜底）；
3. **兜底 → CSS**（现代书源倾向 CSS；非法 selector 主线程抛错可容错回显）。

存量兼容性：既有已保存书源是旧生成代码（纯正则、无分支），不受新判定影响；
默认模板正则均含元字符，仍判为正则。新判定只作用于新生成代码与智能添加测试。

## External Review Opinion (Phase 1 — plan)

provider=coding-bridge。Round 1/2：NEEDS_CHANGES，采纳修正：

1. **启发式兜底改为 CSS**（原兜底为正则），属性选择器含 `?`/`^` 的误判由 `css:` 前缀兜底；
2. **异步一致性**：生成的 `search()`/`bookInfo()`/`chapterContent()` 本就是 `async`（已 `await legado.http.get`），CSS 分支 `await legado.query` 时序天然一致，验收标准中显式确认；
3. **协议增加 error 通道**：主线程解析失败（选择器非法 / HTML 超 5MB）返回 `{error}` → Worker `legado.query` reject → 测试 UI 行内显示真实原因（不再静默空结果）；
4. **T5 拆分为各子任务即时验收**（T1→spec、T2→service mock 测试、T3→codegen 断言），不做末端一次性集成；
5. **Feature Flag**：`localStorage['pom.cssRules']==='0'` 时禁用 CSS 识别——智能添加测试判定与 `SandboxService.proxyQuery` 双端检查（后者为唯一运行时收口，直接 reject），线上可不发版止血。

Round 2/2：APPROVED（见文末归档记录）。


## 子任务分解

### T1 `smart-rules.ts` 双模式改造 ✅

- 新增 `isCssRule(pattern): boolean`（上述纯字符串启发式 + `css:` 前缀剥离 `stripCssPrefix`)。
- `matchLinkItems(pattern, html, baseUrl, limit)`:
  - CSS 模式：`DOMParser` 解析 → `querySelectorAll` → 元素为 `a` 则取之，否则取后代锚点；href 绝对化、name=textContent;**按绝对 URL 去重（同名优先保留非空 name)**。
  - 正则模式：维持现有逻辑一字不动（不去重）。
- `pickText(pattern, html)`:CSS 模式 → 首个命中元素 `textContent`。
- 新增 `pickHtml(pattern, html)`:CSS 模式 → 首个命中元素 `innerHTML`（正文用）;正则模式退化为 `pickText`。
- 验收：用户样例 HTML + `dl.list dd a` → 恰好 1 条 `{name:'庆余年', url:'.../book/5/index.html'}`。

### T2 沙箱 `legado.query` 代理 ✅

- `sandbox.worker.ts`:shim 增加 `query(html, selector, baseUrl)` → postMessage `{type:'query', reqId, html, selector, baseUrl}`；复用 `pendingHttp` 同款 pending Map（抽象或并列）。
- `sandbox.service.ts`：处理 `query` 消息 → 主线程 `DOMParser` → `querySelectorAll` → 返回 `[{tag, text, html, href}]`(href 用 `new URL(href, baseUrl)` 预绝对化，非法则为 '')。
- **error 通道**：选择器非法 / HTML 超 5MB / Feature Flag 关闭 → 回传 `{error}`，Worker 侧 `legado.query` reject，测试 UI 行内显示真实原因。
- 安全：解析文档不挂载、不执行脚本；只回传文本/属性纯数据。
- 协议类型：`{tag: string; text: string; html: string; href: string}` 即前后端契约。

### T3 `generateSourceCode` 适配 ✅

- 生成代码内置与 T1 相同的 `isCssRule` 判定（纯 JS 字符串启发式，无 DOM 依赖）。
- `search()` / `bookInfo()` / `chapterContent()` 中每个规则按运行时模式分支：
  - 正则路径：现有代码原样。
  - CSS 路径：`await legado.query(html, selector, BASE_URL)` → 映射为现有返回结构（搜索/章节按 href 去重、非空 name 优先）。
- 验收：CSS 规则生成的代码在沙箱内 `search()` 返回与 T1 测试一致的结构。

### T4 智能添加页 UI ✅

- 字段标签「xx 正则」→「xx 规则」;`rules-hint` 增补：「支持 CSS 选择器（如 `dl.list dd a`）或正则；含特殊符号的选择器加 `css:` 前缀」。
- 测试函数传 `baseUrl`（搜索=搜索页 URL，详情/目录=bookUrl，正文=chapterUrl)。
- 组件注释头「规则为正则模式」表述更新为双模式。

### T5 测试 ✅

- 各子任务完成后即时验收（不后置）：T1→`smart-rules.spec.ts` 增补（用户样例 CSS 用例、`isCssRule` 判定表、正则回归）;T2→`sandbox.service` mock 测试（`query` 消息结构、5MB 上限、error 通道）;T3→codegen 断言（CSS 规则含 `legado.query` 分支，正则规则不含）。
- 全部完成后全量 `npx vitest run` + `tsc --noEmit` 通过。

## 预期效果与验收标准

1. 智能添加页输入 `dl.list dd a` 测试搜索 → 命中 1 条「庆余年」无重复；
2. 同一站点生成的书源保存后，调试页 `search()` 沙箱运行结果一致；
3. 既有正则书源（含默认模板生成的）行为完全不变；
4. 含 `css:` 前缀的复杂选择器（如 `css:a[href^="/book"]`）测试与沙箱均可命中。

## 风险评估与缓解

| 风险 | 缓解 |
|---|---|
| 选择器被误判为正则（含 `^ $ * +` 等） | `css:` 显式前缀 + UI hint 说明 |
| 代理往返延迟 | 单页 1~3 次查询可接受；批量接口列后续优化 |
| 超大 HTML 解析 OOM | 主线程 5MB 硬上限 |
| 正则路径回归 | 正则分支代码原样保留 + 回归测试 |

## 实施顺序与依赖

T1 → T2 → T3 → T4 → T5(T3 依赖 T2 的协议契约；T4 依赖 T1)

## 验收结果

- **双端 tsc**: `tsconfig.app.json` / `tsconfig.electron.json` 均 `0`
- **测试**: `npx vitest run` 17 文件 / 175 用例全绿
- **验收用例**: 用户 HTML 样例 + `dl.list dd a` → 渲染器与沙箱 codegen 两条路径均收敛为单条 `{name:'庆余年', url:'https://www.example.com/book/5/index.html'}`
- **回归**: 正则路径 byte-identical（计划契约），`smart-rules.spec` 含正则回归测试

## External Review Opinion (Phase 4 — code)

| Round | Verdict | 关键修复/说明 |
|---|---|---|
| 1 | NEEDS_CHANGES | 2×P0（生成代码空结果守卫、proxyQuery 顶层 try/catch 兜底）+ 3×P1（ruleSelector 大小写/trim、容器选择器多容器去重测试、REGEX_HINT 简化）+ 2×P2（rules-hint 文案、生成代码 500 截断）|
| 2 | NEEDS_CHANGES | 1×P1（注释误述、el.links 空值守卫、500 提常量）+ 2×P1 拒绝项（正则路径去重按契约不改；ReDoS 防护非本期范围）|
| 3 | **APPROVED** | 5 项修复全部落地，2 项拒绝理由充分，无 P1/P2 残余 |

**评审总结**: 5 轮 cap 内收口（实际 3 轮）。无 P1/P2 级残余问题。
