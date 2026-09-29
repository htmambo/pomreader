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
| `ELECTRON_EXTRA_ARGS` | 空 | 仅 `e2e-cf-guard.cjs`：透传额外 Electron 启动参数（空格分隔）。已有应用实例在跑时单实例锁会让本进程秒退，传 `--user-data-dir` 指向独立 profile 绕行：`ELECTRON_EXTRA_ARGS="--user-data-dir=/tmp/pom-cf-smoke"` |
| `CF_TARGETS` | 内置两个 CF 站点 | 仅 `e2e-cf-guard.cjs`：逗号分隔的 CF 挑战站点 URL 列表 |

## 用例

| 脚本 | 场景 |
|---|---|
| `e2e-import-online.cjs` | 点页头"导入 → 导入在线书页" → 填 URL（同源 `127.0.0.1:PORT/smoke-book/*.html`，请求拦截回包，规避浏览器 `no-cors` 降级拿不到跨源内容）→ 解析 10 章 → 确认导入 → 书架 +1 |
| `e2e-import-local-txt.cjs` | 点页头"导入 → 导入本地 TXT" → 上传 `/tmp/test-classic.txt` → 确认导入 → 书架 +1 |
| `e2e-search.cjs` | `/#/book-sources/search` 跨书源聚合搜索：输入关键词 → 点搜索 → 断言确定性终态（结果列表或空态提示其一必现）+ 无 JS 错误 |
| `e2e-txt-preview.cjs` | 导入本地 TXT → 章节切分预览展示 |
| `e2e-cf-guard.cjs` | （需 DISPLAY，真实 Electron）普通站点 sanity + CF 站点 Tier 1 自动过盾（fetchHtml / booksourceHttpProxy 双链路）。CF 自动过盾受站点难度/网络环境影响，未自动通过时报 `⚠️ INCONCLUSIVE`（隐藏窗口转人工验证），不算应用回归 |

## 退出码 / 输出

- ✅ PASS → `console.log("✅ PASS: ...")`
- ❌ FAIL → `console.log("❌ FAIL: ...")`
- 抛异常 → `TEST ERROR: ...`

## 盘点脚本（非 e2e）

| 脚本 | 场景 |
|---|---|
| `audit-booksources.ts` | P0 书源存量盘点（只读，方案 §4.1）：`node scripts/audit-booksources.ts [书源目录] [--out report.json]`。目录缺省自动探测 `<userData>/booksources`；默认打印人类可读报告，`--out` 另存完整 JSON。目录里唯一的 TS 脚本：Node ≥ 22.18 原生 type stripping 直接跑，无需 tsx/ts-node、无需 dev server |
