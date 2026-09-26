# e2e / smoke 脚本

需要 puppeteer-core（已在 devDeps）+ 系统 chrome：

```bash
npm start          # 终端 1：ng serve --port 4203
PORT=4203 node scripts/e2e-import-online.cjs
PORT=4203 node scripts/e2e-import-local-txt.cjs
```

> 当前脚本硬编码 `127.0.0.1:4202`；如换端口请编辑脚本顶部 URL 或通过环境变量改写（TODO）。

## 用例

| 脚本 | 场景 |
|---|---|
| `e2e-import-online.cjs` | 点页头"导入 → 导入在线书页" → 填 URL → 解析 → 确认导入 → 书架 +1 |
| `e2e-import-local-txt.cjs` | 点页头"导入 → 导入本地 TXT" → 上传 `/tmp/test-classic.txt` → 确认导入 → 书架 +1 |
| `e2e-cf-guard.cjs` | （需 DISPLAY，真实 Electron）普通站点 sanity + CF 站点 Tier 1 自动过盾（fetchHtml / booksourceHttpProxy 双链路） |

## 退出码 / 输出

- ✅ PASS → `console.log("✅ PASS: ...")`
- ❌ FAIL → `console.log("❌ FAIL: ...")`
- 抛异常 → `TEST ERROR: ...`