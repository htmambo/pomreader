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
| `search(keyword, page)` | 关键词（string）+ 页码（number） | `Array<{ name, author?, url, intro? }>` |
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

## 5. 示例

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

## 6. 安装与调试

1. 把书源 `.js` 文件保存到 `<userData>/booksources/`
2. 启动应用 → 打开「书源管理」页（`/book-sources`）
3. 卡片显示启用开关 / 编辑 / 删除 / 检测按钮
4. 点击「编辑」修改源码，「保存」即时生效（IPC 触发 `invalidate`）
5. 「删除」前有二次确认

## 7. 故障排查

| 现象 | 可能原因 | 排查方式 |
|---|---|---|
| 启停失效 | marker 文件冲突 | 删除 `<userData>/booksources/<fileName>.enabled` / `.disabled` |
| HTTP 失败 | URL 已被禁（内网/私网） | 检查主进程 `safeNetRequest` 日志；拒绝 `127.0.0.1` / `10/8` / `172.16/12` / `192.168/16` |
| 超时 | 网络慢 | 调整 `@minDelayMs` 加大间隔，或检查目标站点可达性 |
| 沙箱隔离 | 书源访问 `fetch` 等 | 重写为 `legado.http.{get,post,request}` |
| 编辑后旧代码生效 | invalidate 未触发 | 保存后重启应用；或手动调用 IPC `booksourceInvalidate(fileName)` |
| 返回签名差异 | `search`/`bookInfo` 字段命名不规范 | 参见 §3 函数签名表 |