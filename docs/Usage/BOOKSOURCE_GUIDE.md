# 书源开发指南

pomreader 支持用户书源 JS 脚本，在 Web Worker 沙箱中执行。

## 1. 文件结构

书源文件是标准的 `.js` 文件，由头部元数据 + 函数定义组成：

```javascript
// @name          笔趣阁
// @author        张三
// @url           https://www.xbiquge.cc
// @version       1.0.0
// @description   示例书源
// @enabled       true
// @type          novel
// @tags          小说, 玄幻

function search(keyword, page) { ... }
function bookInfo(bookUrl) { ... }
function toc(bookUrl) { ... }
function chapterContent(chapterUrl) { ... }
```

## 2. 头部元数据（`// @key value`）

pomreader 解析前 100 行内的 `// @key value` 注释，多值字段按出现顺序累积，标量字段首次声明生效。

| Key | 必填 | 说明 | 示例 |
|---|---|---|---|
| `@name` | ✅ | 书源显示名 | `@name 笔趣阁` |
| `@url` | ✅ | 主 URL（多镜像可写多条） | `@url https://www.xbiquge.cc` |
| `@author` | - | 作者 | `@author 张三` |
| `@version` | - | 版本 | `@version 1.0.0` |
| `@description` | - | 描述（多行用多个 `@description` 累积为 `\n`） | `@description 免费小说阅读` |
| `@enabled` | - | 是否启用（`false`/`0`/`no` 视为禁用，其他非空视为启用） | `@enabled true` |
| `@type` | - | 类型：`novel` / `comic` / `video` / `music` / `webpage`，非法值降级为 `novel` | `@type novel` |
| `@tags` | - | 标签（中英逗号分隔，自动去重保序） | `@tags 小说, 玄幻` |
| `@uuid` | - | 书源唯一标识；缺省回退为 `fileName` | `@uuid my-source` |
| `@updateUrl` | - | 远程更新地址（书源市场使用） | `@updateUrl https://...` |
| `@minDelayMs` / `@minDelay` | - | 最小请求间隔（毫秒，限流） | `@minDelayMs 500` |
| `@require` | - | 依赖 URL（多镜像同源识别） | `@require https://cdn.example.com` |
| `@logo` | - | 站点 logo URL | `@logo https://...` |

未知 `@key` 被忽略（向后兼容 legado 扩展字段）。

## 3. 函数签名

| 函数 | 参数 | 返回值 |
|---|---|---|
| `search(keyword, page)` | 关键词（string）+ 页码（number） | `Array<{ name, author?, kind?, url, intro? }>`（`kind` = 分类/题材） |
| `bookInfo(bookUrl)` | 书页 URL | `{ title, author, intro?, chapters: [{title, url}] }` |
| `toc(bookUrl)` | 书页 URL | 同 `bookInfo().chapters`（仅返回章节数组） |
| `chapterContent(chapterUrl)` | 章节 URL | string（纯文本，HTML 自行 strip） |

调用约定：

- 所有书源调用都受 15 秒单次超时熔断（spec FR-1.3.2）
- Worker pool 最大并发 = 6，第 7 个调用排队等待
- `invalidate(fileName)` 编辑保存后由 IPC 触发，下次 `load()` 时清理 Worker 模块缓存

## 4. 宿主 API：`legado`

书源 JS **只能**通过 `legado` 对象访问受限功能：

```javascript
// HTTP 请求（自动走主进程 net.request，绕开 CORS + 带 SSRF 防护）
const html = legado.http.get(url, headers);          // GET → string
const html = legado.http.post(url, body, headers);   // POST → string
const resp = legado.http.request({                   // 完整请求
  url, method, headers, body
});                                                   // → {status, headers, body}
```

**禁止**使用 `fetch / XMLHttpRequest / WebSocket / import()` 等原生 API — 沙箱已显式屏蔽或删除。

沙箱硬化（Worker 启动时执行）：

- `delete self.window; delete self.document; delete self.localStorage; delete self.parent; delete self.top;`
- `Object.freeze(Object.prototype); Object.freeze(Array.prototype); Object.freeze(Function.prototype); Object.freeze(globalThis);`
- classic worker（非 module），阻止书源 `import('https://evil.com/...')` 绕网络出口

## 5. 搜索请求方式（智能添加 / 编辑源可视化）

智能添加页与编辑源页的「搜索」面板支持三种请求方式，生成的代码自带对应分支：

| 方式 | `SEARCH_METHOD` | 说明 |
|---|---|---|
| **GET**（默认） | `'GET'` | `searchPath` 作为 URL 模板（`{keyword}` 自动 `encodeURIComponent`），走 `legado.http.get` |
| **POST — 表单** | `'POST'` | `searchPath` 为 POST URL；body 由 `SEARCH_BODY_PARAMS`（`[{"key":"q","value":"{keyword}"},...]`）按 form-urlencoded 拼接，value 支持 `{keyword}` / `{page}` 占位符 |
| **POST — 原始 body** | `'POST_RAW'` | `searchPath` 为 POST URL；body 用 `SEARCH_RAW_BODY` 模板原文替换 `{keyword}` / `{page}`（不自动 encode，由用户自管） |

POST 模式可视化编辑示例（智能添加 / 编辑源页 UI 同步）：

- **请求方式**：GET / POST / POST_RAW 单选
- **POST 表单模式**：Content-Type 输入框 + 键值对列表（key / value 两列）+ 「添加参数 / 删除」按钮
- **POST 原始 body 模式**：Content-Type 输入框 + Body 文本框

生成的 `search()` 函数会根据 `SEARCH_METHOD` 分支走对应逻辑（GET / POST / POST_RAW 互不影响）。

## 6. 规则常量（智能添加 / 编辑源可视化）

生成的书源顶部有一组 `const` 规则常量，智能添加页与编辑源页的面板直接读写它们，**也是「应用规则到源码」唯一替换的内容**（`explore` 等自定义代码保留）。

除下表两项为对象数组外，其余均为字符串：

| 常量 | 格式 | 说明 |
|---|---|---|
| `BASE_URL` | string | 站点根地址（`@url` 去掉尾部路径），测试时的解析基址 |
| `HEADERS` | object | 附加 HTTP header（来自 legado 导入时可带自定义头） |
| `SEARCH_PATH` | string | 搜索路径模板，支持 `{keyword}` / `{page}` 占位符 |
| `SEARCH_METHOD` | string | `GET` / `POST` / `POST_RAW`，见 §5 |
| **`SEARCH_BODY_PARAMS`** | **对象数组** `[{"key":"q","value":"{keyword}"},...]` | 仅 `POST` 表单模式使用，value 支持 `{keyword}` / `{page}` |
| `SEARCH_CONTENT_TYPE` | string | `POST` 模式的 Content-Type，默认 `application/x-www-form-urlencoded` |
| `SEARCH_RAW_BODY` | string | 仅 `POST_RAW` 使用，模板原文替换后不 encode |
| `SEARCH_ITEM_RULE` | string | 搜索结果条目提取规则 |
| `SEARCH_AUTHOR_RULE` | string | **可选增强**：搜索结果条目内的作者规则，留空 = 不提取 |
| `SEARCH_CATEGORY_RULE` | string | **可选增强**：搜索结果条目内的分类规则，留空 = 不提取 |
| `BOOK_TITLE_RULE` | string | 书名提取规则 |
| `BOOK_AUTHOR_RULE` | string | 作者提取规则 |
| `CHAPTER_ITEM_RULE` | string | 章节链接提取规则 |
| `CONTENT_RULE` | string | 正文提取规则 |
| **`CONTENT_REPLACE_RULES`** | **对象数组** `[{"rule":"正则","replace":"替换为"},...]` | 按数组顺序对正文做 g 模式全局替换；`replace` 留空即删除命中；非法正则跳过不中断后续 |
| `BOOK_CATEGORY_RULE` | string | 分类提取规则 |
| `COVER_RULE` | string | 封面提取规则，缺省 `css:img` |

### 规则值：CSS 选择器或正则

`*_RULE` 的值按以下顺序判定（见生成代码里的 `isCssRule()`）：

1. 以 `css:` 前缀开头 → 强制按 **CSS 选择器**（前缀被去掉）
2. 含 ``\ ( ) { } ? | ^ $ * +`` 中任一字符 → 按 **正则**
3. 兜底 → 按 **CSS 选择器**

沙箱内没有 DOM，CSS 选择器经 `legado.query` 主线程 DOMParser 代理执行，正则直接走 `RegExp`。

> ⚠️ **格式变更（破坏性）**：`SEARCH_BODY_PARAMS` 与 `CONTENT_REPLACE_RULES` 早期版本使用元组形态（`[["k","v"],...]` / `[["正则","替换"],...]`），现已统一为上表的对象数组，**只支持对象一种形态**。用智能添加重新生成，或在编辑源页重填保存，即可升级为新格式。

### 搜索结果的作者 / 分类（可选增强规则）

有些站点在搜索结果列表里就带作者、分类。`SEARCH_AUTHOR_RULE` /
`SEARCH_CATEGORY_RULE` 就是为此准备的：**它们是补充，不是必需** —— 留空时
`search()` 照常返回 `{ name, author: '', kind: '', bookUrl }`，搜索结果不受影响。

作用域是**搜索结果条目内部**，不是整页：

| `SEARCH_ITEM_RULE` 模式 | 增强规则的提取范围 |
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

```javascript
const SEARCH_ITEM_RULE = "dl.list dd"
const SEARCH_AUTHOR_RULE = "css:.author"       // → 猫腻
const SEARCH_CATEGORY_RULE = "css:.kind"      // → 历史穿越（写入返回项的 kind）
```

命中后 `search()` 返回 `{ name, author: '猫腻', kind: '历史穿越', bookUrl }`；
聚合搜索、去重、导入书籍（`Book.author` / `Book.kind`）沿用既有链路。

> 智能添加页 / 编辑源页的「结果-作者 / 结果-分类」两个输入框 + 「测试搜索」
> 会把命中条数显示在摘要里；规则填了却一条没命中时，摘要会提示作用域问题。
> 老书源没有这两个常量也能正常加载运行（按「未配置」处理）。

## 7. 示例

```javascript
// @name          示例书源
// @url           https://www.example.com
// @enabled       true
// @type          novel
// @tags          示例, 小说
// @minDelayMs    500

function search(keyword, page) {
  const url = `https://www.example.com/search?q=${encodeURIComponent(keyword)}&page=${page}`;
  const html = legado.http.get(url);
  // 解析 HTML 提取书名/作者/链接...
  return [];
}

function bookInfo(bookUrl) {
  const html = legado.http.get(bookUrl);
  // 解析书页，提取书名/作者/章节列表
  return { title: '', author: '', chapters: [] };
}

function toc(bookUrl) {
  return bookInfo(bookUrl).chapters;
}

function chapterContent(chapterUrl) {
  const html = legado.http.get(chapterUrl);
  return html.replace(/<[^>]+>/g, ''); // 简单去标签
}
```

## 8. 安装与调试

1. 把书源 `.js` 文件保存到 `<userData>/booksources/`
2. 启动应用 → 打开「书源管理」页（`/book-sources`）
3. 卡片显示启用开关 / 编辑 / 删除 / 检测按钮
4. 点击「编辑」修改源码，「保存」即时生效（IPC 触发 `invalidate`）
5. 「删除」前有二次确认

## 9. 故障排查

| 现象 | 可能原因 | 排查方式 |
|---|---|---|
| 启停失效 | marker 文件冲突 | 删除 `<userData>/booksources/<fileName>.enabled` / `.disabled` |
| HTTP 失败 | URL 已被禁（内网/私网） | 检查主进程 `safeNetRequest` 日志；拒绝 `127.0.0.1` / `10/8` / `172.16/12` / `192.168/16` |
| 超时 | 网络慢 | 调整 `@minDelayMs` 加大间隔，或检查目标站点可达性 |
| 沙箱隔离 | 书源访问 `fetch` 等 | 重写为 `legado.http.{get,post,request}` |
| 编辑后旧代码生效 | invalidate 未触发 | 保存后重启应用；或手动调用 IPC `booksourceInvalidate(fileName)` |
| 返回签名差异 | `search`/`bookInfo` 字段命名不规范 | 参见 §3 函数签名表 |