# 差分测试 fixtures 清单（方案 §7.1）

> 用途：`src/app/core/book-source/json-rule/diff-test.spec.ts` —— 同一逻辑书源的 `.js`（JS 沙箱引擎）
> 与 `.json`（JSON 规则引擎）两种载体，吃同一份 HTML 字节，四入口输出逐字段等价。
> **脱敏口径（AGENTS.md/方案硬要求）**：全部为手工构造的典型形态样本；站名/域名/URL 均为中性占位
> （`sample-*` / `https://sample-*.invalid`），本清单只记形态类型，不记真实站点身份。
> `.js` 样本由 `generateSourceCode`（smart-add/smart-rules.ts）真实生成后落盘；`.json` 由同一规则集
> 序列化（uuid = 带扩展名文件名，与迁移口径一致）。HTML 为手写小片段（UTF-8，含中文内容）。

## 样本清单与覆盖矩阵

| 样本 | 形态类型 | 规则模式 | 搜索方式 | HEADERS | 特殊覆盖 |
|---|---|---|---|---|---|
| `sample-css` | CSS 单模 | 全 CSS（css: 前缀） | GET | 空 | 重复 URL 收敛去重（/book/1 出现两次）；空名条目（img-only 锚点）丢弃 |
| `sample-regex` | 正则单模 + 版本漂移旧源 | 全正则 | GET | 空 | `.js` 删掉了 SEARCH_AUTHOR_RULE / SEARCH_CATEGORY_RULE 两个常量（模拟旧版生成源），`.json` 对应字段缺省；正则条目**不**去重（/book/1 重复保留） |
| `sample-post` | POST 表单搜索 + 正则增强规则 | 全正则（含条目内 author/category 正则增强） | POST（searchBodyParams） | 非空（X-Requested-With / Referer） | 请求 method/body/headers 两侧逐字节一致 |
| `sample-post-raw` | POST_RAW 搜索 | 全 CSS | POST_RAW（searchRawBody JSON 模板，Content-Type 缺省回填 application/json） | 非空（X-Client） | 原始 body 模板替换 {keyword} 不 encode |
| `sample-clean` | 内容净化多规则 | 全 CSS + 3 条 contentReplaceRules | GET | 空 | 正文含广告行（【广告】/ 最新章节地址 / （本章完）），净化后两侧逐字节一致 |
| `sample-gbk` | GBK 声明的 HTML | 裸 CSS 选择器（无 css: 前缀，走 isCssRule 启发式兜底） | GET | 空 | HTML 头部 `<meta charset="gbk">` + http-equiv 声明；bookCategoryPattern / coverUrlPattern 缺省 → 两侧 DEFAULT_PATTERNS 回填路径一致 |
| `sample-extra` | author+kind 增强规则 | 全 CSS（含条目内 span.author / span.cat 增强提取） | GET | 空 | 搜索结果 author/kind 字段等价 |
| `sample-badhref` | 已知差异 #1 触发样本 | 全 CSS | GET | 空 | 仅 search.html：含非法 href（`http://[bad`，`new URL` 解析抛错）条目。**不进等价断言**，见「已知差异」#1 |
| `sample-manual` | needs-manual 反例 | CSS + 手改自定义语句 | GET | 空 | 仅 search.html / 无 `.json`：含模板外自定义常量与过滤逻辑（CUSTOM_BLACKLIST）。**不进等价断言**，只跑 JS 侧确认可识别并标记，见 diff-test.spec.ts `needs-manual` 块 |

每个等价样本覆盖四个入口：`search`（关键词「剑来」，page=1）、`bookInfo`（经 adapter.fetchCatalog，
目标 URL `${origin}/book/1`）、`chapterList`（service/engine 层直调，目标 `${origin}/book/1/toc`，
由 toc.html 承接）、`chapterContent`（经 adapter.fetchChapter，目标 `${origin}/book/1/chapter/1`）。
同时断言两侧的 HTTP 请求序列（method / url / body / headers）逐项一致。

矩阵含 `pom.cssRules` 两列（F6c）：

- **默认（flag 未设置）**：上表 7 个等价样本 × 4 入口全部逐字段一致。
- **flag=0**：CSS 规则源（sample-css / sample-post-raw / sample-clean / sample-gbk / sample-extra）
  两侧抛**同一文案** `CSS 规则已禁用（localStorage pom.cssRules=0）`
  （JS 侧经 worker error 通道回传 err.stack 全文，断言 toContain；JSON 侧引擎直接抛，断言 toBe）；
  正则规则源（sample-regex / sample-post）在 flag=0 下四入口输出仍逐字段一致（不受开关影响）。

## 已知差异（现状既有，登记而非拉平；差分断言不视为失败）

1. **CSS 分支非法 href 的条目处置不同**（引擎开发期已发现，样本 `sample-badhref` 实机触发并锁定）：
   - JS 侧：沙箱 `proxyQuery` 的 `abs()`（sandbox.service.ts:706-712）在 `new URL(href, base)` 失败时返回 `''`，
     该锚点在 `links` 过滤阶段被丢弃 → 条目整体消失；
   - TS 侧：`absUrl`（smart-rules.ts:143-149）失败时**原样返回 href** → 条目保留，url 为原始非法串。
   - 仅 URL 构造失败的极端边缘触发；v1 登记不修（修复 = 行为变更，需独立评审）。
     差分测试以显式断言锁定两侧各自的行为（见 spec `known-diff#1` 块）。
2. **引擎 fail-fast vs 模板先发请求**：规则/门禁失败时，引擎在发 HTTP 请求前抛错（0 请求），
   模板先发请求再在提取/门禁阶段失败（≥1 请求）。结果字段无差异（两侧同一报错文案）。
   flag=0 列显式锁定该差异：CSS 样本每个入口断言 JS 侧恰好 1 次请求、JSON 侧 0 次请求。
3. **空白增强规则（whitespace-only searchAuthorPattern/searchCategoryPattern）处置不同**
   （diff 测试编写期代码评审发现，样本未触发，仅登记）：模板 `search()` 对增强规则不做 trim
   （smart-rules.ts 模板 :721-722），空白规则会进入 `legado.query` 并被「选择器为空」响亮拒绝；
   TS 侧 `matchSearchItems`（smart-rules.ts:256-257）对增强规则 trim 后判空 → 静默跳过、正常出结果。
   仅当用户把增强规则填成纯空白时触发（误填场景）；v1 登记不修。
4. **CF Tier 2 语义差异（方案 §7.1 登记，与本差分无关，仅备忘）**：`PageFetcherService.fetchHtml`
   的 Tier 2 是成功返回语义，沙箱链路是 fire-and-forget；v1 引擎走 `booksourceHttpProxy` 不继承此差异。
   两条链路（内置适配器 vs 书源引擎）若未来合并，须先评估此条。

## 维护

- 新增典型形态时：补 `booksources/<id>.js`（generateSourceCode 生成）+ `<id>.json` + `html/<id>/*.html`，
  并在上表登记形态类型；URL 约定 `${origin}/search…` / `/book/1` / `/book/1/toc` / `/book/1/chapter/N`
  （diff-test.spec.ts 的 `htmlForUrl` 按此映射）。
- 新发现的不一致：要么修实现，要么登记到「已知差异」并在 spec 显式标注（方案 §7.1 末尾要求）。
