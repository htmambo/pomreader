# 迁移测试 fixtures 清单

> 用途：`electron/ipc/booksource-migrate.spec.ts` —— 存量 `.js` 书源 → `.json`（BookSourceDoc）
> 启动迁移的输入样本。历史上本目录还存有 P1 差分测试（双引擎等价性）样本与
> `fixtures/html/` 页面快照 / `fixtures/worker-stub.ts`；差分测试已随 P4 删 JS 沙箱链路
> 一并删除，仅保留迁移 spec 仍在消费的三个 `.js` 样本。
>
> **脱敏口径（AGENTS.md 硬要求）**：全部为手工构造的典型形态样本；站名/域名/URL 均为中性占位
> （`sample-*` / `https://sample-*.invalid`），只记形态类型，不记真实站点身份。

| 样本 | 形态类型 | 迁移 spec 覆盖点 |
|---|---|---|
| `sample-regex.js` | 正则单模 + 版本漂移旧生成源（缺 SEARCH_AUTHOR_RULE / SEARCH_CATEGORY_RULE 两常量） | 模板白名单判定、模板版本漂移假阳性回归、正常迁移（uuid 回退文件名 / marker 搬迁 / 幂等 / 同 uuid .json 跳过）、损坏源（清空常量 → needs-manual）、缺 @url 头 |
| `sample-manual.js` | needs-manual 反例：CSS + 手改自定义语句（CUSTOM_BLACKLIST 等模板外常量与过滤逻辑） | 白名单拒绝 → needs-manual 归档 |
| `sample-post-raw.js` | POST_RAW 搜索（searchRawBody JSON 模板，含自定义 HEADERS） | searchContentType 按 method 回填 application/json、headers 保留 |
