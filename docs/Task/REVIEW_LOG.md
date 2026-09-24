# External Review Log

记录所有通过 `mcp__coding-bridge__review_code` / `review_plan` 收到的 review verdict，
按 CLAUDE.md §1.5 Review Loop Protocol 处置。

---

## Round 1/5 — 2026-09-24 (commit f7ab390..70da9f4 累积改动)

**Provider:** coding-bridge
**Kind:** code
**VERDICT:** NEEDS_CHANGES

### Findings (按严重程度)

#### P1 - 严重

1. **`db.service.ts` chapterAllRaw / bookDelete 前缀冲突**
   - 风险：`chapter:{bookId}:` 前缀匹配，若 bookId 形如 `a` 与 `a-extra`，查询 `a` 的章节会误命中 `a-extra`
   - 实际 bookId 形态：`online-{ts}` 或本地 txt id，目前不含 `-` 后跟其他字符的情形；但代码鲁棒性差

2. **`db.service.ts` chapterPutMany 串行写入**
   - 千章规模 2000 次 IndexedDB 事务，导入慢且阻塞 UI
   - 应改 `db.bulkDocs`

#### P2 - 高

3. **`import-online.component.ts` 第 30 行 placeholder 是真实盗版站点 URL**
   - `https://www.xbiquge.cc/book/9231/` 违反 CLAUDE.md 中性 placeholder 规则
   - 改为 `https://example.com/book/123/`

4. **`db.service.ts` bookPut 读-改-写竞态**
   - 编辑书籍与自动进度保存可能并发，`bookPut` 会丢失中间进度
   - 用 PouchDB put 409 冲突检测 + 重试

5. **`reader.component.ts` 键盘事件 modal 期间仍响应**
   - Modal 打开时焦点在背景/按钮时按方向键仍翻页
   - 加 `modalOpen` signal 拦截

#### P3 - 中

6. **`jump-chapter-dialog.component.ts` 缺校验反馈**
   - `nz-input-number` 无 `[nzStatus]` 绑定
   - 加 error signal + nzStatus

7. **`db.service.ts` bookDocToBook / chapterDocToChapter `void _i` 不优雅**
   - 改 rest-sibling 解构 + 在 BookDoc 里把 type/_id/_rev 显式 mark

8. **`db.service.ts` seedIfEmpty 用 `info.doc_count` 判断空库**
   - doc_count 含 design docs，未来若引入 views 会误判
   - 改用 `bookAll().length === 0` 判断

9. **历史 commit 边界：`f7ab390` + `d4f4041` 不可独立 revert**
   - deps 引入 pouchdb-browser 与首次使用拆在不同 commit
   - 教训：未来 dep 引入 + 首次使用合并；本轮不可修复（已 push）

#### P4 - 低

10. **`edit-book-info-dialog.component.ts` coverColor 多控件 ngModel 双向同步闪烁**
    - color picker 输出小写 hex，手输可能大写；过程中轻微不一致
    - 加 `(ngModelChange)` 实时 lowercase + 校验

11. **`ng-zorro-overrides.scss` `.ant-modal .ant-list-items` 选择器脆弱**
    - 强依赖 ng-zorro 内部类名，大版本升级会断
    - 加自定义 class（如 `.modal-list-scrollable`）

---

## Round 2/5 — 2026-09-24 (待 re-review)

(下面填入第二轮 verdict)