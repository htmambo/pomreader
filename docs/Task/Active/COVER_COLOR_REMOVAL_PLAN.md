# 移除 Book.coverColor + SVG fallback + 引入 CSS-only 占位

**Status**: ✅ Implementation complete (2026-09-26) — pending archive
**Owner**: Claude (Opus 5)

## 背景

调研发现 `Book.coverColor` 字段已**几乎无意义**：

- 所有导入路径（local-txt / import-online / 生成封面）都自动写入 `coverImageUrl`
- book-card 渲染仅在 `coverImageUrl` 为空时用 SVG fallback（用 `coverColor` 作背景）
- 用户场景下 `coverColor` 几乎从不生效（除非用户主动清空 `coverImageUrl`）
- 所有写入路径都用硬编码固定色（`#8b4513` / `#177ddc`）—— 不是用户选色

## 用户决策（方案 B 极简版）

**方案 B：删除 `coverColor` 字段 + SVG fallback 分支**
**极简 UI 占位**：CSS-only 占位 + "暂无封面"文字（0 新资源、不新建 SVG 文件、不依赖外部图）

## 改动清单

### 1. 数据模型（删除字段）
- `book.model.ts`：删 `coverColor: string`
- `db.service.ts`：删 `BookDoc.coverColor`；**老数据迁移**：`bookPut` / `bookDocToBook` 主动 strip coverColor（防止 `...rest` 展开把多余字段带进新数据）
- `db.service.ts` BookDoc `kind` / `sourceUrl` 不动（用户在用）

### 2. 写入路径（删除 coverColor 赋值）
- `local-txt-import.service.ts:47` 删 `coverColor: '#8b4513'`
- `import-online.component.ts:384` 删 `coverColor: '#177ddc'`

### 3. 渲染路径（删除 SVG fallback + 加 CSS 占位）
- `book-card.component.ts`：
  - 删 `<svg class="cover">` 分支（line 33-58）
  - 改 `<div class="cover cover-placeholder">暂无封面</div>`
  - scoped CSS 加 `.cover-placeholder { ... }`
- 删除 `[style.--cover-color]="book.coverColor"`（line 25）

### 4. 编辑对话框（删除封面颜色 UI）
- `edit-book-info-dialog.component.ts`：
  - `EditBookInfoResult` 接口删 `coverColor: string`
  - template 删「封面颜色」整块（含色板按钮 + color input）
  - `confirm()` 不再写 coverColor
  - 移除 `coverColor` 信号字段（line 229）

### 5. 测试更新
- `bookshelf-sort.spec.ts:8` 用例含 `coverColor: '#000'` → 删
- 任何含 coverColor 的 mock / fixture → 删

## 预期效果

1. ✅ 书架卡片：3 种状态
   - 有 `coverImageUrl` → 显示图片
   - 无 `coverImageUrl` → CSS 占位 + "暂无封面"文字
   - 不再有 SVG fallback（不再需要 coverColor）
2. ✅ 数据模型简化：删 1 个字段（`coverColor`）
3. ✅ 老数据兼容：迁移时 strip coverColor，不会污染新数据
4. ✅ 编辑对话框简化：删「封面颜色」整块 UI

## 验收标准

- [ ] tsc --noEmit 0 错误
- [ ] vitest 全绿（含 bookshelf-sort 调整）
- [ ] 无 `coverColor` 残留（除 `bookshelf-sort.spec.ts` 调整外）
- [ ] 老 PouchDB 数据迁移：含 coverColor 的老 Book 读出后无多余字段

## 风险评估

| 风险 | 缓解 |
|---|---|
| 老 PouchDB 数据有 coverColor → bookDocToBook 多余字段 | bookPut / bookDocToBook 主动 strip（destructure coverColor 拿掉） |
| 编辑对话框字段引用漏改 | 用 `rg coverColor` 全局扫描 + 一次 Edit 替换 |
| 测试 fixture 残留 | rg `coverColor:` 找所有测试用例 + 删除 |

## External Review Opinion

### Round 1/5 (chat fallback, review_code 端点暂不可达)

`mcp__coding-bridge__review_code` 两次均返回 `Failed to parse API response`，改用 `mcp__coding-bridge__chat` 同语义评审。

- VERDICT: **APPROVED**
- RISKS: []

Reviewer 主要观察（已二次复核，全部解决）：

1. **`--cover-color` token 残留检查** — rg 全仓 0 命中（book-card.component.ts 已删 `[style.--cover-color]` host attr 与 `.cover-img { background: var(--cover-color); }`，tokens.scss 中从未定义该 token）。**已 clean**
2. **`bookDocToBook` 旁路检查** — `bookAll()` / `bookGet()` 全部走 `bookDocToBook(d)`；`seedIfEmpty` 中 `as Book[]` 是 JSON.parse 类型断言，不经 PouchDB。**无旁路**
3. **`edit-book-info-dialog` imports 清理** — `FormsModule` 仍用于 title/author/sourceUrl/kind/coverImageUrl 共 5 个字段 ngModel 绑定，未变 orphan。**已确认仍需要**
4. **WCAG 对比度（亮色 3.0:1）** — reviewer 标注 "non-blocker"，占位文字非关键内容。**不动 token**（避免全局涟漪）
5. **broken-image 兜底** — pre-existing 行为，不在本任务范围

**实施 diff 摘要**（8 文件 +20/-148）：
- 5 处字面量删除（model/db-doc/importTxt/importOnline/spec）
- 1 处 destructure strip 双路加护（bookPut + bookDocToBook）
- 1 处 SVG fallback → CSS-only 占位（book-card）
- 1 处编辑对话框 UI 整块删除（coverColor 接口 + 色板 + 输入 + 6 个 CSS 块）
- 1 处 seed JSON 清理（books.json 15 行）

## 验收结果

- [x] tsc --noEmit 0 错误（改动文件）
- [x] vitest 219/219 全绿（含 bookshelf-sort 调整后）
- [x] rg coverColor 仅 db.service.ts 4 处（皆为迁移期 strip，预期）
- [x] 老 PouchDB 数据迁移：bookPut / bookDocToBook 主动 strip coverColor，不会污染新数据
- [x] 主题自适应验证：占位用 `--pom-card` / `--pom-text-muted` / `--pom-border` 三个 token，无硬编码颜色
