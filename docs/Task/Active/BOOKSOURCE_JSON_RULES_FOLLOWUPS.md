# 书源 JSON 规则化 — 二期及后续跟进项

> 状态：**Active（待启动，随主方案推进逐项激活）** · 创建：2026-09-29
> 上游方案：[2026-09-29-BOOKSOURCE-JSON-RULES-PLAN.md v2.1 §11](../Architecture/2026-09-29-BOOKSOURCE-JSON-RULES-PLAN.md)
> 目的：主方案 v1 明确不做的项集中在此跟踪，防止遗忘。每项注明触发条件，不要盲目提前做。
> 编号用 `T-n`（track），与上游方案 §2 事实基线的 `Fn`（fact）刻意错开（v2.1 评审修订第 10 条）。
> schema v1 已为标 ⭐ 的项预留扩展位（详见上游方案 §3.1）。

## 表达力扩展（二期，按优先级）

- [ ] **T-1 ⭐ 目录分页 `tocPagination`**：目录分多页时循环抓取拼接。触发：遇到目录分页站点。表达力损失的最大头。
- [ ] **T-2 ⭐ 正文分页 `contentPagination`**：一章拆多页合并。触发：同上。
- [ ] **T-3 ⭐ 搜索二次跳转 `follow`**：搜索命中中转页 → 二次请求拿真实 bookUrl。触发：中转页型站点。
- [ ] **T-4 ⭐ 多候选规则**：`contentPattern` 等接受数组按序尝试（`string | string[]`）。替代手改 JS 的 try 多选择器。
- [ ] **T-5 ⭐ `responseType:'json'` + jsonpath**：兼容 legado API 型书源（当前被拒翻译的一大类）。需引入 jsonpath 求值器，先评估包体。
- [ ] **T-6 XPath 选择器**：CSS/正则都搞不定的顽固站点。低优先级。
- [ ] **T-7 签名/加解密能力**：时间戳签名、md5 参数。只能是内置参数化算法（不再走用户 JS），需单独安全评审。

## 引擎与运行时

- [ ] **T-8 ⭐ `encoding` 字段**（auto/utf-8/gbk 显式指定）。触发：代理层 auto 判错编码的站点出现。
- [ ] **T-9 `minDelayMs` 主链路强制限流**（现状仅镜像间限流）。触发：被站点限流/封禁的反馈。
- [ ] **T-10 P1.5 正则移 Web Worker**（可 terminate 强杀）。判据：出现 UI 卡顿报告或 ReDoS 源；v1 靠 guard 静态拦截兜底。
- [ ] **T-11 explore / 发现页规则**。触发：有真实需求（现状与 v1 均无）。

## 生态与工具

- [>] **T-12 书源导入/导出 bundle 实施**：✅ 前置已清——`docs/Architecture/2026-09-28-BOOKSOURCE_IMPORT_EXPORT_DESIGN.md` 已于 2026-09-29 按 JSON 契约修订（commit 3b91948）。已于 2026-09-30 激活，立项见 [2026-09-30-BOOKSOURCE-BUNDLE-TASK.md](2026-09-30-BOOKSOURCE-BUNDLE-TASK.md)。
- [ ] **T-13 needs-manual 源人工重写指引 + BOOKSOURCE_GUIDE.md 规则编写指南**。触发：P3 迁移后有 needs-manual 残留。（P0 实跑本机存量手改 0%；GUIDE 已含 JSON 规则章节，本条只剩「needs-manual 重写指引」待有真实残留时补）
- [ ] **T-14 `booksources_legacy/` 清理策略**：保留 ≥1 个版本周期；之后设置页提供「清理旧书源备份」按钮（永不自动删）。
- [ ] **T-15 书源分享/订阅**：T-12 bundle 落地后的自然延伸。

## 机制验证

- [ ] **T-16 `schemaVersion` 演进机制首次实战**（v1→v2 迁移分支）：表达力扩展任一字段落地时顺势验证，避免 R6「形同虚设」。
- [ ] **T-17 差分测试 fixture 库持续维护**：每次表达力扩展落地时同步补典型站样本。

## 激活规则

1. 主方案 P0-P4 推进期间，本清单只增不改（新发现的二期候选追加到对应分组）。
2. 某项被激活时：从 `- [ ]` 改为 `- [>]`，在本仓 `docs/Task/Active/` 单独立项，本条目加链接。
3. 某项完成或明确放弃：移入 `docs/Task/Archive/` 或标注放弃原因，不留悬置项。
