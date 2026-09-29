# 书源目录 / 正文分页设计（T-1 / T-2）

**日期**：2026-09-30
**状态**：设计已确认（用户 2026-09-30 拍板「按建议实施」），实施中
**范围**：目录分页（T-1）+ 正文分页（T-2）统一模型 v1
**上游**：[BOOKSOURCE_JSON_RULES_FOLLOWUPS.md](../Task/Active/BOOKSOURCE_JSON_RULES_FOLLOWUPS.md) T-1/T-2；方案 §11 二期表达力扩展

## 1. 模型：分页区域链接图遍历

用户提出的统一抽象（2026-09-30 会话确认可行）：

> 只给出分页区域，每一页都去取这个区域的链接，去重，直到所有页码都已抓取完成
> （判定：当前页分页区域的所有链接均已在已读列表）。

常见分页形态在该模型下都是「从第 1 页出发可达的有限链接图」：

- 仅上一页/下一页 → 链式图，逐页推进，末页「下一页」灰化（指向自身 / `#`）后收敛
- 页码列表（部分列出）→ 星型图，首页即可发现大部分页，剩余页在后续页区域补全
- 当前页码渲染为 `<span>` 而非 `<a>` 是多数站点行为，天然利于去重判定

## 2. 规则字段（SourceRules 新增 2 个可选字段，16 → 18）

```ts
interface PaginationRule {
  /** 分页区域规则（CSS 或正则，与全仓规则语法同构）：取该区域内全部 <a href> */
  area: string;
  /** 可选：链接白名单正则（命中才跟随）。未填走 §3.2 URL 形状推断 */
  linkPattern?: string;
  /** 可选：最大页数。目录缺省 100，正文缺省 20；硬上限 200 */
  maxPages?: number;
}

interface SourceRules {
  // ……既有 16 字段
  /** 目录分页（T-1）。不填 = 单页目录（现状行为） */
  tocPagination?: PaginationRule;
  /** 正文分页（T-2）。不填 = 单页正文（现状行为） */
  contentPagination?: PaginationRule;
}
```

- valibot schema 同步加两个 `v.optional` 嵌套对象；`area` 必填（minLength 1）
- 纯新增可选字段 → 向后兼容，**不触发 schemaVersion 演进**（T-16 继续挂起，
  首个 v1→v2 迁移分支留给破坏性变更）

## 3. 抓取流程（`json-rule/pagination.ts`，引擎内复用）

```
crawl(startUrl, pagination, fetchPage):
  queue = [startUrl]; seen = {normalize(startUrl)}; pages = []
  while queue 非空 且 pages.length < maxPages(≤200):
    url = queue.shift()
    html = fetchPage(url)            // 走引擎 request（trace/assertHtmlSize/预算）
    pages.push({ url, html, ... })
    areaHtml = pickHtml(pagination.area, html)
    if areaHtml 为空: continue       // 无分页区域 = 单页
    links = matchLinkItems('a', areaHtml, url) 去重（按 normalize 后 URL，保 DOM 序）
    for link of links:
      if !passesWhitelist(link.url): continue          // §3.2
      if seen.has(normalize(link.url)): continue
      seen.add; queue.push(link)
  return orderPages(pages)           // §3.3
```

终止：队列空（所有已发现链接均已读）或撞 maxPages。**撞上限不静默**：
trace 里记 `truncated: true`，目录返回已抓部分，正文拼接已抓部分（§5 取舍）。

### 3.1 URL 归一化（去重键）

`absUrl` 解析相对路径 → 去 `#hash` → 不去 query（保守：query 可能携带页码）。
已知不足：带随机追踪参数的「下一页」会绕过去重导致图膨胀——由 §3.2 白名单
与 maxPages 双保险兜住，更激进的 query 参数清洗留作增强项（§7）。

### 3.2 链接白名单（防逃逸 / 防噪音，三件套之一）

优先级：

1. `linkPattern` 显式正则 → `new RegExp(linkPattern).test(url)` 命中才跟随
   （过 guard 的 assertRegexSafe / assertRuleLength）
2. 未填时**页码位推断**：
   - 在**起始页**区域链接上，对每个链接与起始页 URL 做形状对比：path 段数组 +
     query 键集合相同、且**恰好一个位置**（某个 path 段或某个 query 值）不同
   - 差异值必须为纯数字；统计哪个位置差异的链接最多 → 该位置即「页码位」
   - 后续所有页只跟随「与起始页同形状、仅页码位不同、值为数字」的链接
3. 推断失败（区域链接形状各异）→ 不跟随任何链接（等同单页），trace 记
   `inference-failed`，提示用户补 linkPattern

**正文分页守卫**：白名单恒以「起始页（本章 URL）形状」为基准——「下一章」
链接与起始页不同形状，被天然挡在门外，爬虫不会跨章逃逸。目录分页同理：
区域选择器圈进导航/广告链接也会因形状不符被滤掉。

### 3.3 页序恢复（三件套之二，正确性关键）

发现序不可靠（星型站点首页区域是 `1 2 3 … 10`，BFS 发现序 = 1,2,3,10,4,…），
而正文页序错误 = 文字颠倒事故。排序规则（确定性）：

1. 页码位推断成功 → 按页码位的数字值升序
2. 起始页不在区域链接中（常见：bookUrl 无页码段）→ 起始页恒排最前，
   其余按规则 1
3. 推断失败但有 linkPattern → 按 linkPattern 首个数字捕获组升序；
   无数字组 → DOM 发现序（trace 记 `order: dom-discovery`，提示结果可能乱序）

### 3.4 资源上限与限流（三件套之三）

- `maxPages`：目录缺省 100 / 正文缺省 20，硬上限 200（schema 层 max 校验）
- 整次抓取在引擎入口预算内（`withBudget` 已包住 execute，超时响亮失败）
- 页间间隔遵守 `doc.minDelayMs`（现状仅镜像间限流，本设计在主链路分页循环
  内首次消费该字段——T-9 的最小落地）
- 串行抓取（v1 不做并发，§7 增强项）

## 4. 引擎接入点

- `doChapterList`：`tocPagination.area` 存在 → crawl(bookUrl)，每页跑
  `chapterItemPattern` 提取，按章 URL 去重拼接 → `capList(CHAPTER_MAX_ITEMS)`
- `doChapterContent`：`contentPagination.area` 存在 → crawl(chapterUrl)，
  每页 `stripTags(pickHtml(contentPattern, html))` 顺序拼接 → 拼接后整体过
  `contentReplaceRules` → `capContent`
- `bookInfo` 内部复用 `doChapterList`，自动获得目录分页能力
- trace：`stage: 'http'` 每页一条（既有）；新增 `stage: 'extract'` 的
  `ruleField: 'tocPagination' / 'contentPagination'` 记录页数/截断/排序方式，
  调试页 RuleTrace 原样可见，无需新 UI

## 5. 接受的取舍

1. **单页失败 = 停在已抓部分**：某页请求失败即终止循环，目录返回已抓章节、
   正文返回已抓拼接（trace 带 error），不做断点续抓。重试由用户重进触发，
   幂等无副作用。
2. **撞 maxPages 不报错只标记**：截断是配置问题不是运行时错误，trace 标记
   交给用户调大 maxPages 或修规则。
3. **串行抓取**：分页页数通常 ≤ 20，串行 + minDelayMs 对站点最友好；
   并发带来的复杂度（限流、顺序、取消）远超收益。
4. **legado 导入不映射**：legado `ruleToc.nextTocUrl` / `ruleContent.nextContentUrl`
   是「显式下一页 URL/规则」模型，与区域遍历模型不同构，v1 不做自动转换
   （§7 增强项）。

## 6. 测试策略

| 文件 | 覆盖 |
|---|---|
| `json-rule/pagination.spec.ts` | 链式分页遍历收敛；星型（部分页码列表）补全；页码位推断（path 段/query 两形态）；推断失败不跟随；linkPattern 优先级；URL 归一化去重（相对路径/hash/编码）；页序恢复三层规则；maxPages 截断标记；单页失败停在已抓部分；正文守卫挡「下一章」链接 |
| `json-rule/engine.spec.ts` 增量 | tocPagination 多页目录拼接去重；contentPagination 多页正文拼接 + contentReplaceRules 只在拼接后跑一次；无分页字段时行为与现状逐字节一致（回归） |
| 模型 spec | PaginationRule schema：area 必填 / maxPages 上限 200 / 缺字段可省略 |

## 7. 已知不足与增强项（留档，不在 v1）

1. **JS/AJAX 渲染分页**：区域静态抓取不到链接，等同单页。静态引擎能力边界，
   不计划支持。
2. **query 追踪参数绕过去重**：`?page=2&t=随机` 会让图膨胀。缓解：白名单 +
   maxPages。增强方向：归一化时对「非页码位 query 参数值」做置空。
3. **「区域判终 + 模板取页」混合模式**：URL 页码连续时可从区域读页码集合、
   按模板按序生成 URL——顺序与噪音问题彻底消失，但要求页码可模板化。
   可作为 v2 的 `pageUrlTemplate` 可选字段，与区域遍历互为回退。
4. **legado nextTocUrl/nextContentUrl 映射**：需「显式下一页链接」执行模式
   （取区域中特定锚点而非全量遍历），与 T-3（搜索二次跳转 follow）同属
   「链接跟随」族，可合并设计。
5. **并发抓取与进度事件**：页数大时串行慢；进度（已抓 N 页）目前只能经
   trace 间接可见，调试页有、阅读链路透不出。
6. **排序置信度展示**：规则 3 兜底（DOM 发现序）时正文可能乱序，目前仅
   trace 一行标记；增强方向是调试页醒目提示。
7. **`maxPages` 在 UI 的校验提示**：rules-panel 只做空/数字基本校验，
   超 200 靠 schema 保存时拦截。
8. **T-9 全面限流**：本设计只在分页循环内消费 minDelayMs，搜索/详情等
   主链路其余请求仍不限流（T-9 原定触发条件不变）。

## 8. 实施清单

1. `smart-rules.ts` SourceRules + `book-source-doc.model.ts` schema 加 2 字段
2. `json-rule/pagination.ts` + spec（纯抓取逻辑，fetch 注入）
3. `engine.ts` 两入口接入 + spec 增量
4. `rules-panel` 两个分页字段组（目录/正文各：区域规则 + 链接白名单 + 最大页数）
5. GUIDE 分页章节 + CHANGELOG + FOLLOWUPS T-1/T-2 状态
