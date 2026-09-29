# 书源开发指南

pomreader 的书源是 **JSON 规则文档**（BookSourceDoc），由内置 JSON 规则引擎直接执行 —— 不需要写 JS。

> 过渡期说明：旧 `.js` 沙箱链路在 P4 之前仍保留（仅作回滚），运行时开关 localStorage
> `pom.bookSource.engine` = `rule` / `js` / `both`（默认 `rule`）可切回，见 §9。
> 新写书源请一律使用 JSON。

## 1. 文件结构

书源文件是 `<userData>/booksources/<name>.json`，由 meta 字段 + `rules` 规则字段组成
（模型与 valibot schema 见 `src/app/core/models/book-source-doc.model.ts`）：

```json
{
  "format": "pomreader.booksource",
  "schemaVersion": 1,
  "uuid": "my-source",
  "name": "笔趣阁",
  "author": "张三",
  "homepage": "https://www.xbiquge.cc",
  "urls": ["https://www.xbiquge.cc"],
  "enabled": true,
  "sourceType": "novel",
  "sourceVersion": "1.0.0",
  "tags": ["小说", "玄幻"],
  "minDelayMs": 0,
  "requireUrls": [],
  "headers": {},
  "rules": {
    "siteName": "笔趣阁",
    "searchPath": "/modules/article/search.php?searchkey={keyword}&page={page}",
    "searchMethod": "GET",
    "searchItemPattern": "css:.result-list .result-item",
    "bookTitlePattern": "css:.book-info h1",
    "bookAuthorPattern": "css:.book-info .author",
    "chapterItemPattern": "css:.chapter-list a",
    "contentPattern": "css:#content"
  }
}
```

`format` / `schemaVersion` 是文件识别与将来结构迁移用的固定标记（v1 恒为
`'pomreader.booksource'` / `1`），手写时照抄即可。

## 2. meta 字段

| 字段 | 必填 | 说明 | 示例 |
|---|---|---|---|
| `uuid` | ✅ | 书源唯一标识；缺省回退为**带扩展名**的文件名（`foo.json`）。已添加的书籍按它关联书源，迁移前后必须一致 | `"my-source"` |
| `name` | ✅ | 书源显示名；缺省回退为剥掉 `.json` 的文件名 | `"笔趣阁"` |
| `homepage` | ✅ | 主站 origin（原 `BASE_URL` / `@url` 第一条），相对 URL 的解析基址 | `"https://www.xbiquge.cc"` |
| `urls` | ✅ | 多镜像 URL 数组；v1 仅取 `[0]`，**不做 failover**（顺序保留仅为二期留位） | `["https://a.cc", "https://b.cc"]` |
| `enabled` | ✅ | 是否启用（替代旧 `.enabled` / `.disabled` marker 文件） | `true` |
| `sourceType` | ✅ | 类型：`novel` / `comic` / `video` / `music` / `webpage` | `"novel"` |
| `author` | - | 作者 | `"张三"` |
| `logo` | - | 站点 logo URL | `"https://..."` |
| `description` | - | 描述 | `"免费小说阅读"` |
| `sourceVersion` | - | 书源自身版本（原 `@version`；命名避开与 `schemaVersion` 撞车） | `"1.0.0"` |
| `updateUrl` | - | 远程更新地址（书源市场使用） | `"https://..."` |
| `tags` | - | 标签数组 | `["小说", "玄幻"]` |
| `minDelayMs` | - | 最小请求间隔（毫秒）；v1 主抓取链路不强制限流 | `500` |
| `requireUrls` | - | 前置依赖源 URL（原 `@require`，多镜像同源识别） | `["https://cdn.example.com"]` |
| `headers` | - | 自定义请求头（原 `HEADERS` 常量，legado 导入产物） | `{"Referer": "https://..."}` |
| `legadoRaw` | - | legado 骨架源内嵌的原始 JSON（导入失败占位，勿手写） | - |

## 3. rules 字段（16 字段 = 7 必填 + 9 可选）

`rules` 就是旧 JS 书源里那组 `const` 规则常量原样平移（字段名一字不改），
智能添加页与编辑源页的表单直接读写它们。除 `searchBodyParams` / `contentReplaceRules`
为对象数组外，其余均为字符串。

| JSON 字段 | 必填 | 旧 JS 常量 | 说明 |
|---|---|---|---|
| `siteName` | ✅ | `// @name` | 站点名 |
| `searchPath` | ✅ | `SEARCH_PATH` | 搜索路径模板，支持 `{keyword}` / `{page}` 占位符 |
| `searchMethod` | - | `SEARCH_METHOD` | `GET`（缺省）/ `POST` / `POST_RAW`，见 §4 |
| `searchBodyParams` | - | `SEARCH_BODY_PARAMS` | 对象数组 `[{"key":"q","value":"{keyword}"},...]`，仅 `POST` 表单模式使用 |
| `searchContentType` | - | `SEARCH_CONTENT_TYPE` | `POST` 模式的 Content-Type，缺省 `application/x-www-form-urlencoded`（`POST_RAW` 缺省 `application/json`） |
| `searchRawBody` | - | `SEARCH_RAW_BODY` | 仅 `POST_RAW` 使用，模板原文替换后不 encode |
| `searchItemPattern` | ✅ | `SEARCH_ITEM_RULE` | 搜索结果条目提取规则 |
| `searchAuthorPattern` | - | `SEARCH_AUTHOR_RULE` | **可选增强**：搜索结果条目内的作者规则，留空 = 不提取 |
| `searchCategoryPattern` | - | `SEARCH_CATEGORY_RULE` | **可选增强**：搜索结果条目内的分类规则，留空 = 不提取 |
| `bookTitlePattern` | ✅ | `BOOK_TITLE_RULE` | 书名提取规则 |
| `bookAuthorPattern` | ✅ | `BOOK_AUTHOR_RULE` | 作者提取规则 |
| `chapterItemPattern` | ✅ | `CHAPTER_ITEM_RULE` | 章节链接提取规则 |
| `contentPattern` | ✅ | `CONTENT_RULE` | 正文提取规则 |
| `contentReplaceRules` | - | `CONTENT_REPLACE_RULES` | 对象数组 `[{"rule":"正则","replace":"替换为"},...]`，正文净化，见 §7 |
| `bookCategoryPattern` | - | `BOOK_CATEGORY_RULE` | 分类提取规则 |
| `coverUrlPattern` | - | `COVER_RULE` | 封面提取规则，缺省 `css:img` |

另有两个原常量不进 `rules`，而是平移到 meta 层：`BASE_URL` → `homepage`，
`HEADERS` → `headers`。

> ⚠️ **格式变更（破坏性）**：`searchBodyParams` 与 `contentReplaceRules` 早期版本使用
> 元组形态（`[["k","v"],...]` / `[["正则","替换"],...]`），现已统一为对象数组，
> **只支持对象一种形态**。旧 `.js` 源在启动迁移时自动升级；手写 JSON 请直接写对象数组。

## 4. 搜索请求方式（GET / POST / POST_RAW）

智能添加页与编辑源页的「搜索」面板支持三种请求方式，引擎按 `searchMethod` 走对应分支：

| 方式 | `searchMethod` | 说明 |
|---|---|---|
| **GET**（默认） | `"GET"` | `searchPath` 作为 URL 模板（`{keyword}` 自动 `encodeURIComponent`），GET 抓取 |
| **POST — 表单** | `"POST"` | `searchPath` 为 POST URL；body 由 `searchBodyParams`（`[{"key":"q","value":"{keyword}"},...]`）按 form-urlencoded 拼接，value 支持 `{keyword}` / `{page}` 占位符 |
| **POST — 原始 body** | `"POST_RAW"` | `searchPath` 为 POST URL；body 用 `searchRawBody` 模板原文替换 `{keyword}` / `{page}`（不自动 encode，由用户自管） |

POST 模式可视化编辑（智能添加 / 编辑源页 UI 同步）：

- **请求方式**：GET / POST / POST_RAW 单选
- **POST 表单模式**：Content-Type 输入框 + 键值对列表（key / value 两列）+ 「添加参数 / 删除」按钮
- **POST 原始 body 模式**：Content-Type 输入框 + Body 文本框

三种方式互不影响，切换 `searchMethod` 即切换引擎的搜索分支。

## 5. 规则值：CSS 选择器或正则

`*Pattern` 字段的值按以下顺序判定（引擎内置，与旧 JS 模板 `isCssRule()` 同一套逻辑）：

1. 以 `css:` 前缀开头 → 强制按 **CSS 选择器**（前缀被去掉）
2. 含 ``\ ( ) { } ? | ^ $ * +`` 中任一字符 → 按 **正则**
3. 兜底 → 按 **CSS 选择器**

引擎在主线程用 DOMParser 执行 CSS 选择器（不执行脚本、不加载资源，单页 HTML ≤ 5MB），
正则直接走 `RegExp`（嵌套量词等灾难性回溯形态会被护栏事前拒绝）。

### 搜索结果的作者 / 分类（可选增强规则）

有些站点在搜索结果列表里就带作者、分类。`searchAuthorPattern` /
`searchCategoryPattern` 就是为此准备的：**它们是补充，不是必需** —— 留空时
搜索照常返回 `{ name, author: '', kind: '', bookUrl }`，搜索结果不受影响。

作用域是**搜索结果条目内部**，不是整页：

| `searchItemPattern` 模式 | 增强规则的提取范围 |
|---|---|
| CSS 选择器 | 条目元素的 `innerHTML` |
| 正则（组 1=URL，2=书名） | 本条匹配起点 → 下一条匹配起点之间的 HTML 片段 |

因此条目规则要选到**含作者/分类的整块容器**（`dl.list dd`），只选书名链接
（`dl.list dd a`）的作用域里没有作者/分类，增强规则就取不到值：

```html
<!-- dl.list dd 作为条目：作用域含 .author / .kind -->
<dd><h4><a href="/book/5/index.html">庆余年</a></h4>
    <span class="author">猫腻</span><span class="kind">历史穿越</span></dd>
```

```json
{
  "searchItemPattern": "dl.list dd",
  "searchAuthorPattern": "css:.author",
  "searchCategoryPattern": "css:.kind"
}
```

命中后搜索返回 `{ name, author: '猫腻', kind: '历史穿越', bookUrl }`；
聚合搜索、去重、导入书籍（`Book.author` / `Book.kind`）沿用既有链路。

> 智能添加页 / 编辑源页的「结果-作者 / 结果-分类」两个输入框 + 「测试搜索」
> 会把命中条数显示在摘要里；规则填了却一条没命中时，摘要会提示作用域问题。
> 老书源没有这两个字段也能正常加载运行（按「未配置」处理）。

## 6. 正文净化（`contentReplaceRules`）

`contentReplaceRules` 是对象数组 `[{"rule":"正则","replace":"替换为"},...]`，
按数组顺序对正文做 g 模式全局替换；`replace` 留空即删除命中；非法正则跳过不中断后续。
典型用途：去广告文案、去站名水印、清理乱码段。

```json
{
  "contentReplaceRules": [
    { "rule": "笔趣阁.*?最快更新", "replace": "" },
    { "rule": "\\(本章完\\)", "replace": "" }
  ]
}
```

## 7. 从旧 `.js` 迁移

存量 `.js` 书源**无需手工转换**，启动时主进程自动迁移：

1. 应用启动时（首次扫描书源目录前），主进程把 `<userData>/booksources/*.js`
   逐个转换为同名 `.json`（原子写），原始 `.js` 移动到
   `<userData>/booksources_legacy/`。
2. **转换成功的源**：`enabled` 状态、uuid、自定义 headers、规则全部保留，
   `Book.bookSourceUuid` 关联不变（已添加的书无需重抓）。
3. **needs-manual 源**：含模板外自定义 JS 语句、必填规则缺失或校验失败的源不产 JSON，
   `.js`（连同启停 marker）移入 `booksources_legacy/`，在书源列表页以**标灰行**
   常驻显示（「无法自动转换（可能含自定义 JS）」），可「查看原始 JS」或「删除」。
4. 首次迁移完成后弹出一次性的迁移报告弹窗（含 legacy 目录路径）。
5. `booksources_legacy/` **永不自动删、永不执行**，随时可人工取回 `.js` 参照重写为 JSON，
   或配合运行时开关回滚（见 §9）。迁移本身不受引擎开关约束——切回 `'js'` 后
   legacy 标灰行依然可见。

## 8. 安装与调试

1. 把书源 `.json` 文件保存到 `<userData>/booksources/`
2. 启动应用 → 打开「书源管理」页（`/book-sources`）
3. 卡片显示启用开关 / 编辑 / 删除 / 检测按钮；JSON 校验失败的源带红标（`rulesInvalid`）
4. 点击「编辑」在表单里修改 meta 与规则字段（rules-panel 可视化编辑 + 测试搜索），
   「保存」即时生效（引擎每次调用重新读文件并校验）
5. 调试页可逐入口（搜索 / 书籍详情 / 目录 / 正文）执行并查看 RuleTrace
   （阶段 / 请求 URL / HTTP 状态 / 命中规则 / 提取条数 / 耗时）
6. 「删除」前有二次确认

## 9. 运行时开关与回滚（过渡期，P4 删除）

localStorage `pom.bookSource.engine`：

| 值 | 行为 |
|---|---|
| `rule`（默认） | 仅 JSON 规则引擎 |
| `js` | 仅旧 JS 沙箱链路（调试用回滚） |
| `both` | 两者并存，同 uuid 时 JSON 胜出 |

书源页顶栏有分段控件可直接切换（调试用）。P4 将删除 JS 沙箱链路与本开关，
届时 `booksources_legacy/` 是唯一回滚依据。

## 10. 故障排查

| 现象 | 可能原因 | 排查方式 |
|---|---|---|
| 启停失效 | JSON 内 `enabled` 字段异常 | 直接编辑 `.json` 里的 `enabled`；旧 marker 文件迁移时已并入该字段并删除 |
| 列表红标（`rulesInvalid`） | JSON 未通过 valibot 校验 | 按红标提示修字段（必填缺失 / 类型错误）；或在编辑器表单重填保存 |
| HTTP 失败 | URL 已被禁（内网/私网） | 检查主进程 `safeNetRequest` 日志；拒绝 `127.0.0.1` / `10/8` / `172.16/12` / `192.168/16` |
| 超时 | 网络慢 | 单次调用 15s 熔断；检查目标站点可达性，必要时调大 `minDelayMs` |
| CSS 规则报错「CSS 规则已禁用」 | 止血开关被关 | 检查 localStorage `pom.cssRules` 是否为 `0`，删掉该键恢复 |
| 正则规则不生效 / 被拒 | 命中护栏（超长 / 嵌套量词） | 规则串 ≤ 512 字符；`(a+)+` 形态会被静态拒绝，改写为等价安全正则 |
| 编辑后旧规则生效 | JSON 未保存成功 / 校验失败 | 引擎每次调用重读文件；看列表页是否有 `rulesInvalid` 红标 |
| 迁移后某源消失 | 判为 needs-manual | 看书源列表页底部标灰行；原始 `.js` 在 `booksources_legacy/`，可查看后重写为 JSON |
| 行为与旧 JS 链路不一致 | 引擎实现差异 | 开关切 `js` 对比验证；差分测试（`fixtures/`）应覆盖四入口，差异请提 issue |
