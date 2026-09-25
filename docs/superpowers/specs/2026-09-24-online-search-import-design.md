# 万能搜索 + 导入在线书页 — 真实功能引入设计

> **创建**：2026-09-24
> **位置**：子项目 `pomreader-ui-clone/`（仓根下）
> **前置**：v1.1 设计稿（`docs/Architecture/2026-09-24-POMREADER_UI_CLONE_DESIGN.md`）将真实书源接入列为 Out of scope；本 spec 把它转为 In scope。
> **用户声明**：新应用必须使用 Electron 打包成可跨平台应用。

---

## 1. 背景与目标

原 vendor（`白虎阅读_asar/`，AOT 编译 bundle，无源码）的两个功能依赖 Electron 主进程能力，clone 当前为纯浏览器 Angular + mock 实现。本设计把这两个功能按原 vendor 行为级复刻引入 clone，同时把 clone 升级为 Electron 跨平台应用。

### 1.1 原 vendor 行为逆向结论

| 功能 | 原 vendor 实现 |
|---|---|
| 万能搜索 | Electron `<webview>` 内嵌浏览器，加载百度/搜狗等搜索引擎 + 6 个好书网址书签；地址栏同步、前进/后退/跳转；webview 监听 `will-navigate`/`did-start-loading`/`did-stop-loading`/`new-window` |
| 导入在线书页 | URL 输入框（placeholder `完整的URL，例如：https://www.abc.com/xyz`）→ 抓取书页 HTML → 解析目录/章节列表 → 预览 → 导入入库；正文按需抓取（bundle 中 `preloadChapter`/`nextChapter` 暗示） |

### 1.2 goodSites（从 bundle 提取）

```
百度      https://www.baidu.com/
搜狗      https://www.sogou.com/
读书369   http://www.dushu369.com/        (名著)
国学123   http://www.guoxue123.com/       (国学)
读书人365 http://www.readers365.com/       (情怀)
科幻小说网 http://www.khuan.net.cn/        (科幻)   ← bundle 断在此处，实现时补全验证
```

### 1.3 关键决策（用户确认）

| # | 决策 | 选择 |
|---|---|---|
| 1 | 保真程度 | 完整复刻原 vendor 行为 |
| 2 | 书源范围 | 覆盖全部 6 个书签站 + 可扩展框架基座 |
| 3 | 正文获取 | 目录全量入库 + 预加载前 3 章 + 后续按需抓取 |
| 4 | 解析框架 | 适配器注册表（Adapter Registry） |
| 5 | 兜底适配器 | 不做启发式兜底；未知 URL 直接报错，提示支持的站点；`register()` 开放扩展 |
| 6 | 编码处理 | GBK/UTF-8 双向；6 注册站编码+选择器写入配置固定；其它站点自动侦测 |
| 7 | webview 编码 | 工具栏加编码切换（auto/UTF-8/GBK），用户可手动纠正侦测错误 |

---

## 2. 整体架构与 Electron 集成

### 2.1 现状

clone 是纯 Angular CLI 项目（`ng serve` 浏览器运行），无 Electron。两个功能天然依赖 Electron 主进程能力（webview 标签 + 跨域抓取）。

### 2.2 三层结构

```
pomreader-ui-clone/
├── electron/
│   ├── main.ts            # 主进程：BrowserWindow + webviewTag:true + 单实例锁 + contextIsolation:true
│   ├── preload.ts         # contextBridge：暴露 pomAPI.fetchHtml / openExternal / setWebviewEncoding
│   └── ipc/
│       ├── fetch-handler.ts     # ipcMain.handle('pom:fetch-html') 主进程 net.request 跨域抓取
│       └── external-handler.ts  # ipcMain.handle('pom:open-external') shell.openExternal
├── src/app/               # Angular 渲染进程（现有 + 新增 webview 组件 + book-source 模块）
├── angular.json           # build 输出到 electron/www
└── package.json           + electron + electron-builder + iconv-lite + concurrently 依赖 + scripts
```

### 2.3 主进程配置

```ts
// electron/main.ts 关键配置
new BrowserWindow({
  webPreferences: {
    webviewTag: true,          // 显式开启 webview（Electron 默认禁用）
    contextIsolation: true,    // 安全（比原 vendor 的 false 更安全，新写无旧 bundle 包袱）
    preload: path.join(__dirname, 'preload.js'),
  },
});
app.requestSingleInstanceLock();  // 沿用原 vendor 兼容补丁 ⑤，防双实例 IndexedDB 锁争用
```

### 2.4 scripts

```json
{
  "electron": "electron .",
  "dev": "concurrently \"ng build --watch\" \"wait-on electron/www/index.html && electron .\"",
  "dist": "ng build && electron-builder",
  "start": "ng serve"
}
```

`start`（纯浏览器）保留为开发兜底：webview/抓取功能在浏览器下降级提示，但 UI 不崩。

### 2.5 降级探测

组件用 `@ViewChild` + `elementRef.tagName === 'WEBVIEW'` 探测环境，浏览器下显示「此功能需 Electron 环境，请运行 npm run dev」。

---

## 3. 万能搜索（webview 内嵌浏览器）

### 3.1 组件

```
src/app/pages/universal-search/
└── universal-search.component.ts   # 页面壳：地址栏 + 工具栏 + 书签栏 + webview 容器
```

### 3.2 UI 结构（对标原 vendor）

```
┌─ nz-page-header「万能搜索」nzSubtitle「当您搜索一本书的时候...」 ─┐
├─ 工具栏：[←后退] [→前进] [刷新] [地址输入框        ][跳转] [编码▾] ─
├─ 书签栏：[百度] [搜狗] [读书369] [国学123] [读书人365] [科幻小说网]
├─ <webview src="https://www.baidu.com" allowpopups>   flex 占满 calc(100vh-280px)
└─ 顶部「导入在线书页」按钮 → 打开导入 modal（URL 预填 webview 当前地址）
```

### 3.3 webview 交互（与原 vendor 一致）

- `will-navigate` → 同步地址栏 `url`
- `did-start-loading` / `did-stop-loading` → `loading` 状态（刷新按钮图标 + nz-spin 遮罩）
- `did-stop-loading` → `url = webview.getURL()`（最终落地 URL）
- `new-window` → 拦截，`loadURL` 在当前 webview 内跳转（原 vendor 兼容补丁 ③ 行为）
- 前进/后退/跳转：`goBack()/goForward()/loadURL()`
- 输入框回车或跳转：自动补 `http://` 前缀（原 vendor `.url="http://"+this.url`）

### 3.4 编码切换（用户手动兜底）

工具栏编码下拉 `auto | UTF-8 | GBK`：
- `auto`（默认）：不干预，webview 按 HTTP header / meta 自动解码
- `UTF-8` / `GBK`：通过 `webview.webContents.session.webRequest.onHeadersReceived` 重写 `Content-Type` 的 charset，强制按指定编码解码，重新加载

状态 `encodingMode` 本地保存，切换后对后续加载生效。仅影响 webview 渲染，不影响导入解析的抓取编码（独立链路）。

### 3.5 与导入在线的衔接

用户在 webview 里找到书页后，复制 URL → 顶部「导入在线书页」按钮打开导入 modal，URL 预填。对标原 vendor 真实流程。

---

## 4. 导入在线书页 + 书源适配器框架

### 4.1 导入 modal 流程

组件：`src/app/modals/import-online/import-online.component.ts`（重写现有 mock 版本）

1. 用户输入/预填书页 URL（如 `https://www.xbiquge.cc/book/9231/`）
2. 点「解析」→ `BookSourceRegistry.fetchCatalog(url)` → 返回 `{ title, author, chapters: [{title, url}] }`
3. 预览：nz-list 展示章节标题（`nzHeader` + 350px overflow scroll，对标原 vendor `nzSize:small height:350px`）
4. 点「导入」→ `BookService.addBook()` 存目录 + 预抓前 3 章 → 关闭 modal
5. 失败降级：`source-unavailable` / `invalid-url` / `parse-failed` / `unsupported-source` 文案

### 4.2 适配器接口

```ts
// src/app/core/book-source/book-source.adapter.ts
export interface CatalogEntry { title: string; url: string; }
export interface ResolvedBook {
  title: string;
  author: string;
  chapters: CatalogEntry[];
}
export interface BookSourceAdapter {
  /** 判断本适配器是否处理该 URL */
  match(url: string): boolean;
  /** 抓取书页，解析出书名/作者/目录 */
  fetchCatalog(url: string, fetcher: PageFetcher): Promise<ResolvedBook>;
  /** 抓取单章正文（HTML→纯文本） */
  fetchChapter(entry: CatalogEntry, fetcher: PageFetcher): Promise<string>;
}

// 抓取工具抽象
export interface PageFetcher {
  fetchHtml(url: string): Promise<string>;  // 返回解码后的 HTML 文本
}
```

### 4.3 注册表

```ts
// src/app/core/book-source/book-source.registry.ts
@Injectable({ providedIn: 'root' })
export class BookSourceRegistry {
  private adapters: BookSourceAdapter[] = [];
  register(a: BookSourceAdapter): void { this.adapters.push(a); }
  private resolve(url: string): BookSourceAdapter {
    const a = this.adapters.find(a => a.match(url));
    if (!a) throw new Error('unsupported-source');
    return a;
  }
  async fetchCatalog(url: string): Promise<ResolvedBook> {
    return this.resolve(url).fetchCatalog(url, this.fetcher);
  }
  async fetchChapter(entry: CatalogEntry): Promise<string> {
    // entry.url 决定用哪个适配器；fetcher 已注入
    return this.resolve(entry.url).fetchChapter(entry, this.fetcher);
  }
  // fetcher: PageFetcher 通过构造注入（PageFetcherService）
  supportedSources(): string[] { return this.adapters.map(a => a.name); }
}
```

注册时机：`app.config.ts` 的 `APP_INITIALIZER` 注入 registry 并注册 6 个适配器；或 Angular multi-provider token 注入数组，registry 构造时收集。`register()` 保留开放扩展。

### 4.4 6 站适配器

```
src/app/core/book-source/adapters/
├── xbiquge.adapter.ts        # 笔趣阁（网文）   utf-8
├── dushu369.adapter.ts       # 读书369（名著）   gbk
├── guoxue123.adapter.ts      # 国学123（国学）   gbk
├── readers365.adapter.ts     # 读书人365（情怀） gbk
├── kehuan.adapter.ts         # 科幻小说网        utf-8
└── book-source.config.ts     # 6 站编码+选择器规则配置（固定，失效改一处）
```

每站适配器封装该站 CSS 选择器 + 正则，编码 + 选择器从 `book-source.config.ts` 读取：

```ts
// book-source.config.ts
export const SOURCE_CONFIG: Record<string, { encoding: 'utf-8'|'gbk'; catalog: string; chapter: string; title: string; author: string; }> = {
  xbiquge:  { encoding: 'utf-8', catalog: '#list dl dd a', title: '#info h1', author: '#info p', chapter: '#content' },
  dushu369: { encoding: 'gbk',   /* ... 实现时按 fixture 确认 */ },
  // ...
};
```

实现示例：
```ts
// xbiquge.adapter.ts 核心结构
export class XbiqugeAdapter implements BookSourceAdapter {
  readonly name = '笔趣阁';
  private cfg = SOURCE_CONFIG.xbiquge;
  match(url: string): boolean { return /xbiquge\.cc/.test(url); }
  async fetchCatalog(url, fetcher) {
    const html = await fetcher.fetchHtml(url);  // fetcher 已按 cfg.encoding 解码
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const chapters = [...doc.querySelectorAll(this.cfg.catalog)]
      .map(a => ({ title: a.textContent.trim(), url: this.absUrl(url, a.getAttribute('href')) }))
      .filter(c => c.url);
    const title = doc.querySelector(this.cfg.title)?.textContent.trim() ?? '未知书名';
    const author = doc.querySelector(this.cfg.author)?.textContent.match(/作者[：:](.+)/)?.[1]?.trim() ?? '未知';
    return { title, author, chapters };
  }
  async fetchChapter(entry, fetcher) {
    const html = await fetcher.fetchHtml(entry.url);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const node = doc.querySelector(this.cfg.chapter);
    return node ? this.toPlainText(node) : '（正文解析失败）';
  }
}
```

### 4.5 未知 URL 处理

不做启发式兜底。registry `resolve()` 找不到匹配适配器时抛 `unsupported-source`，modal 显示：
> 暂不支持该书源，当前支持：笔趣阁 / 读书369 / 国学123 / 读书人365 / 科幻小说网。后续可扩展。

---

## 5. 存储架构与预加载策略

### 5.1 数据模型调整

```ts
// chapter.model.ts 扩展
export interface Chapter {
  bookId: string;
  index: number;
  title: string;
  content: string;          // 已抓取正文；未抓取时为空串
  sourceUrl?: string;       // 在线导入章节的原始页面 URL（按需抓取入口）
  loaded?: boolean;         // 该章正文是否已抓取
}
```

### 5.2 存储分层

```
内存（BookService signals）
  ├─ books: Signal<Book[]>              书元数据（含章节列表元数据）
  └─ chapters: Map<bookId, Chapter[]>   章节正文（内存缓存）

localStorage（持久化，仅元数据 + 进度，正文不入库 — 沿用设计稿 §3 R2）
  ├─ pom:books          书列表（id/title/author/chapterCount/sourceUrl/source）
  └─ pom:progress       阅读进度
```

在线书章节正文不持久化：只存目录元数据（标题+URL），正文按需抓取后缓存内存。理由：
1. 多章书正文体积大，localStorage 易溢出（R2）
2. 书站内容可能更新，按需抓取保证最新
3. 内存够用：用户同时阅读的书有限

### 5.3 预加载策略

导入时：抓目录 → 入库 → 预抓前 3 章（`index 0,1,2`）。

阅读时按需加载链：
```
用户打开第 N 章
  ├─ Chapter.loaded === true → 直接渲染
  └─ Chapter.loaded === false → 显示「加载中...」→ fetchChapter(entry) → 缓存 → 渲染
       └─ 预加载：N 章渲染后，后台异步预抓 N+1 章（对标原 vendor preloadChapter）
```

`ReaderService.openChapter(n)` 渲染后 `setTimeout(0)` 触发 `bookSource.fetchChapter(chapters[n+1])`，抓完更新内存 signal，不阻塞 UI。失败静默（下次打开重试）。

### 5.4 抓取错误降级

- 目录抓取失败 → modal 内显示错误，不关闭，用户可改 URL 重试
- 单章抓取失败 → 阅读区显示「该章节加载失败，[重试]」按钮，不影响翻章
- 网络超时 → 15s 超时

---

## 6. 跨域抓取实现（主进程 IPC）

### 6.1 主进程抓取服务

```
electron/
├── main.ts                  # BrowserWindow + webviewTag:true + contextIsolation:true
├── preload.ts               # contextBridge 暴露 window.pomAPI
└── ipc/fetch-handler.ts     # ipcMain.handle('pom:fetch-html')
```

**preload.ts**：
```ts
import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('pomAPI', {
  fetchHtml: (url: string, encoding?: 'auto'|'utf-8'|'gbk'): Promise<{html?: string; error?: string}> =>
    ipcRenderer.invoke('pom:fetch-html', url, encoding),
  openExternal: (url: string): Promise<void> =>
    ipcRenderer.invoke('pom:open-external', url),
});
```

**fetch-handler.ts**（主进程）：
```ts
import { ipcMain, net } from 'electron';
import { URL } from 'url';
import iconv from 'iconv-lite';

ipcMain.handle('pom:fetch-html', async (_e, rawUrl: string, encoding: 'auto'|'utf-8'|'gbk' = 'auto') => {
  // 1. SSRF 防护：校验 URL，仅 http/https，拒绝内网 IP
  const u = new URL(rawUrl);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { error: 'invalid-url' };
  if (isPrivateIp(u.hostname)) return { error: 'invalid-url' };

  // 2. net.request 抓取（主进程无 CORS 限制）
  return new Promise((resolve) => {
    const req = net.request({ url: rawUrl, redirect: 'follow' });
    req.setHeader('User-Agent', 'Mozilla/5.0 ... Chrome/152 Safari/537.36');
    const chunks: Buffer[] = [];
    req.on('response', (resp) => {
      resp.on('data', (c) => chunks.push(c));
      resp.on('end', () => {
        const buf = Buffer.concat(chunks);
        // 3. 编码处理：指定优先 > Content-Type charset > HTML meta 探测 > utf-8
        const html = decodeBuffer(buf, encoding, resp.headers);
        resolve({ html });
      });
    });
    req.on('error', () => resolve({ error: 'source-unavailable' }));
    req.end();
    setTimeout(() => { req.abort(); resolve({ error: 'timeout' }); }, 15000);
  });
});

function decodeBuffer(buf: Buffer, mode: 'auto'|'utf-8'|'gbk', headers): string {
  if (mode === 'utf-8') return iconv.decode(buf, 'utf-8');
  if (mode === 'gbk')   return iconv.decode(buf, 'gbk');
  // auto: Content-Type charset > meta charset 探测 > 默认 utf-8
  const ctCharset = parseCharsetFromHeaders(headers);
  if (ctCharset) return iconv.decode(buf, ctCharset);
  const metaCharset = detectMetaCharset(buf);  // 扫 <meta charset=...>
  if (metaCharset) return iconv.decode(buf, metaCharset);
  return iconv.decode(buf, 'utf-8');
}
```

### 6.2 关键细节

- **编码处理**：支持 GBK/UTF-8 双向，6 注册站编码固定（配置传入），其它站点自动侦测（Content-Type charset > HTML meta > utf-8 默认）；依赖 `iconv-lite`（主进程引入，渲染进程不感知）。
- **SSRF 防护**：校验协议 + 拒绝 `127.0.0.1`/`localhost`/`10.*`/`192.168.*`/`172.16-31.*`。
- **User-Agent**：伪装桌面 Chrome，避免书站返回移动版/拦截。

### 6.3 渲染进程 PageFetcher

```ts
// src/app/core/book-source/page-fetcher.service.ts
declare global {
  interface Window { pomAPI?: { fetchHtml: (u: string, enc?: 'auto'|'utf-8'|'gbk') => Promise<{html?: string; error?: string}> }; }
}

@Injectable({ providedIn: 'root' })
export class PageFetcherService implements PageFetcher {
  async fetchHtml(url: string, encoding?: 'auto'|'utf-8'|'gbk'): Promise<string> {
    if (!window.pomAPI?.fetchHtml) {
      // 浏览器降级：fetch 受 CORS 限制，书站基本失败，仅占位
      const r = await fetch(url, { mode: 'no-cors' });
      return await r.text();
    }
    const res = await window.pomAPI.fetchHtml(url, encoding);
    if (res.error) throw new FetchError(res.error);
    return res.html!;
  }
}
```

适配器从 `book-source.config.ts` 读取该站固定编码，传给 `fetcher.fetchHtml(url, cfg.encoding)`，与 Electron IPC 解耦——纯逻辑可单测（mock fetcher）。

---

## 7. 测试策略

| 层 | 工具 | 覆盖 | 说明 |
|---|---|---|---|
| 适配器纯逻辑 | Vitest | ≥ 90% | mock PageFetcher 返回固定 HTML fixture，验证目录/正文解析。每站 1 套 fixture |
| Registry | Vitest | match/resolve 路由 | 6 站 URL 各命中对应适配器，未知 URL 抛 unsupported-source |
| 编码侦测 | Vitest | GBK/UTF-8 双向 | 给定 bytes + charset meta，验证正确解码 |
| PageFetcher | Vitest | IPC 调用 + 降级 | mock window.pomAPI，验证 IPC 透传 + encoding 参数；无 pomAPI 时降级路径 |
| 组件交互 | 手动 | webview + modal 流程 | Electron 环境下端到端：搜索→找书→导入→阅读 |
| 主进程 IPC | 手动 | 抓取真实书站 | 6 站各抓 1 次验证选择器 + 编码 |

**fixture 采集**：实现前先一次性抓取 6 站各一个书页/目录页 HTML 存为 `core/book-source/adapters/__fixtures__/`，既验证选择器又作单测输入。消除「选择器靠猜」风险。

---

## 8. 风险与缓解

| 风险 | 等级 | 缓解 |
|---|---|---|
| 书站 DOM 改版导致选择器失效 | 高 | 选择器+编码写进 `book-source.config.ts`，失效时只改一处；失败报错而非崩溃 |
| 书站反爬（频控/验证码） | 中 | 请求加 UA + 间隔；预加载只前 3 章降低请求量；失败给重试按钮 |
| GBK 解码依赖 iconv-lite | 低 | 主进程引入，渲染进程不感知；fixture 验证；webview 编码切换兜底 |
| webview 在新 Electron 行为变化 | 中 | Electron 44+ webview 需 `webviewTag:true`；若未来废弃需迁移到 BrowserView |
| 6 站 fixture 抓取需联网 | 低 | 一次性，存入仓库；后续 DOM 改版再更新 |
| 科幻小说网 URL bundle 未完整提取 | 低 | 实现时访问确认实际域名（`kehuan.net.cn` 待验证） |
| Electron 打包体积增大 | 低 | electron-builder 跨平台产物，符合用户 Electron 声明 |

---

## 9. 实施阶段

1. **Electron 脚手架**：main/preload/IPC + angular.json 输出 + package.json scripts，`npm run dev` 能起空壳窗口
2. **主进程抓取 + 编码**：fetch-handler + iconv-lite + GBK/UTF-8 侦测，抓 6 站 fixture
3. **适配器框架**：接口 + registry + 6 站适配器（用 fixture 驱动 TDD）+ 单测
4. **导入在线 modal 重写**：真实解析 + 预览 + 导入入库
5. **万能搜索 webview**：goodSites + 地址栏 + 前进后退 + webview 事件 + 编码切换
6. **阅读器按需加载**：Chapter.loaded + 预加载 N+1 + 失败降级
7. **打包**：electron-builder 配置 + 跨平台产物

---

## 10. 验收标准（DoD）

- [ ] `npm run dev` 起 Electron 窗口，4 路由正常
- [ ] 万能搜索 webview 可加载百度/搜狗/6 书签站，地址栏同步、前进后退跳转正常
- [ ] webview 编码切换（auto/UTF-8/GBK）对 GBK 书站生效
- [ ] 导入在线：6 站 URL 各能解析出目录 + 预览
- [ ] 导入入库后，书架显示新书，可进入阅读器
- [ ] 阅读器：前 3 章预加载可读，第 4 章及以后按需加载，失败有重试
- [ ] 未知 URL 导入报错并提示支持的站点
- [ ] 适配器单测 ≥ 90% 覆盖，registry/编码/PageFetcher 单测全绿
- [ ] `npm run dist` 产出跨平台安装包
- [ ] 纯浏览器 `ng serve` 不崩，webview/抓取功能降级提示

---

## 附录：原 vendor bundle 逆向证据

- `main-es2015.e449042b0ddf3d54c6f8.js` 中 `goodSites` 数组：6 个书签站
- `app-import-web` 组件：`nzTitle:"导入在线书页"`、placeholder `完整的URL，例如：https://www.abc.com/xyz`、`nzSize:small height:350px overflow:scroll`、`nzOkDisabled:!e.book`（解析出 book 才能导入）
- webview 组件：`will-navigate`/`did-start-loading`/`did-stop-loading`/`new-window` 事件、`goBack()/goForward()/loadURL()`、`.url="http://"+this.url` 自动补前缀
- `preloadChapter`/`nextChapter`/`jumpToChapter`：正文按需抓取的间接证据
- `shell.openExternal`：外链走 Electron shell
