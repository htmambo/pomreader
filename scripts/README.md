# e2e / smoke 脚本

需要 puppeteer-core（已在 devDeps）+ 系统 Chrome。先起 dev server（默认 4200）：

```bash
npm start                              # 终端 1：ng serve（默认端口 4200）
node scripts/e2e-import-online.cjs     # 终端 2：默认连 127.0.0.1:4200
```

环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `4200` | dev server 端口，如 `PORT=4203 node scripts/e2e-search.cjs` |
| `CHROME_PATH` | `/usr/bin/google-chrome` | Chrome 可执行文件路径 |

## 用例

| 脚本 | 场景 |
|---|---|
| `e2e-import-online.cjs` | 点页头"导入 → 导入在线书页" → 填 URL → 解析 → 确认导入 → 书架 +1 |
| `e2e-import-local-txt.cjs` | 点页头"导入 → 导入本地 TXT" → 上传 `/tmp/test-classic.txt` → 确认导入 → 书架 +1 |
| `e2e-search.cjs` | `/search` 万能搜索：输入关键词 → 点搜索 → 结果渲染 |
| `e2e-txt-preview.cjs` | 导入本地 TXT → 章节切分预览展示 |
| `e2e-cf-guard.cjs` | （需 DISPLAY，真实 Electron）普通站点 sanity + CF 站点 Tier 1 自动过盾（fetchHtml / booksourceHttpProxy 双链路） |

## 退出码 / 输出

- ✅ PASS → `console.log("✅ PASS: ...")`
- ❌ FAIL → `console.log("❌ FAIL: ...")`
- 抛异常 → `TEST ERROR: ...`
