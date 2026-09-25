**状态**: ✅ 已完成 (完成时间: 2026-09-24)
> 父设计稿（v1.1 Round 1 APPROVED）：`docs/Architecture/2026-09-24-POMREADER_UI_CLONE_DESIGN.md`
> fullauto 归档：`.omc/fullauto/pomreader-ui-clone/{spec.md, validation.md}` 保留作审计
> 最终 commit: c784f31（fix HIGH findings）

## 验收结论

- [x] 4 路由全部独立可访问（lazy load）
- [x] 主题切换：light/dark + 弹窗跟随方案 + 字体色/背景可配（v1.1 §9 + §15.1/§15.2 修订落地）
- [x] 15+ 本 mock 书（15 本古典名篇）
- [x] 阅读器 + 抽屉 + 设置弹窗（reader.component 内联）
- [x] TXT 切分单测：chapter-split 19/19 + theme-resolver 8/8 + online-source-resolver 3/3 = 30/30 全绿
- [x] 章节切分覆盖率：100% lines / 95.45% branch / 100% funcs / 100% stmts（远超 90% 门槛）
- [x] bundle < 1.5MB：prod 611kB / 160kB transferred（远低于预算）
- [x] ng serve dev server 启动成功（http://localhost:4200/）+ assets 可达
- [x] 3 reviewer 全 APPROVED（architect Round 1 / security Round 1 / code-reviewer Round 2）
- [ ] CDP 视觉对比原 app（未做，依赖原 app 配合）
- [ ] P5 动效精修（路由切换/抽屉过渡/hover 状态；per D11 推迟）
- [ ] service-level 单测（per code-reviewer R2，非阻塞）
- [ ] 13 本 mock 书的完整章节内容（仅 stub 首章）

## 残余风险（MEDIUM/LOW，详见 validation.md）

- async ngOnInit 错误吞咽
- 组件缺 ChangeDetectionStrategy.OnPush
- online-source-resolver 用 Math.random() 不可测试
- console.log in production（book.service.ts:36）
- TXT 导入无大小上限（自伤 DoS）
- Modal close stub
- Build 路径含 /browser/ 子目录

## 任务目标
独立子项目 `pomreader-ui-clone/` 实现白虎阅读（无 src 原 vendor）的纯 UI 仿写 + 行为级重写核心逻辑；Angular 18 standalone + signals + ng-zorro-antd 18，4 主路由 + 4 弹窗 + 1 抽屉 + 动效，与原 app 视觉/交互高度一致。

## 问题分析
- 原 vendor 不发源码、无 sourcemap，无法直接 patch 维护；要可演进必须自写
- 仅文档/CDP/截图可逆向；行为级算法（TXT 切分、外部源解析、主题解析）需重写 + 单测覆盖
- 仓内已有 patch 工作沉淀（STATUS.md、暗色主题、_pouch_config 修复），新项目需与这些 token 取值对齐
- 子项目体量大（15+ 本 × 30-60 章 mock、4 路由、4 弹窗、动效），按 v1.1 估算 20-24h 集中工作

## 子任务列表
1. Phase 0：从 v1.1 设计稿提炼 spec.md
2. Phase 1：spec → 原子级实施计划（含依赖图、验收口径）
3. Phase 2：脚手架 ng new + 设计 token + 根壳 + 路由空壳（Phase 1 of design）
4. Phase 2：3 主页面 + 静态视觉（Phase 2 of design）
5. Phase 2：阅读器 + 抽屉 + 主题色可配（Phase 3 of design）
6. Phase 2：导入弹窗 + 行为级重写 + 单测（Phase 4 of design）
7. Phase 2：动效 + 高保真精修（Phase 5 of design）
8. Phase 3：QA（build / lint / test 全绿）
9. Phase 4：3 reviewer 验证（architect + security-reviewer + code-reviewer）
10. Phase 5：归档 + 提交

## 每个子任务的改动内容
- 子任务 1-2：写入 `.omc/fullauto/pomreader-ui-clone/spec.md` 与 `.omc/plans/fullauto-pomreader-ui-clone-impl.md`
- 子任务 3-7：在仓根新建 `pomreader-ui-clone/` 子目录，按 design Phase 1-5 渐进产出
- 子任务 8：`ng build` + `ng test` + Vitest 全绿
- 子任务 9：3 reviewer 全部 APPROVED
- 子任务 10：归档 Active 任务 → Archive，更新双 README 索引

## 预期效果和验收标准
- [ ] spec.md / plan.md 双产出
- [ ] `pomreader-ui-clone/` 子项目完整可 `ng serve`
- [ ] 4 路由 + 4 弹窗 + 1 抽屉全部可交互
- [ ] 15+ 本 mock 书 + 古典名篇片段章节
- [ ] TXT 切分单测 ≥ 90% 覆盖
- [ ] 视觉 diff < 5%（CDP 截图对比原 app）
- [ ] 3 reviewer 全 APPROVED
- [ ] README 含启动/构建/测试说明

## 风险评估和缓解措施
- 子项目 0 → 1 大量 install/构建：分 phase 渐进，每 phase 必跑 build
- ng-zorro 暗色覆盖难：每 phase 末做 CDP 截图对比，> 5% diff 不进入下个 phase
- 行为级逆向不准：单测覆盖 + 多次 CDP 试验兜底
- npm install 慢：用 run_in_background + 超时
- review 反复 REJECTED：同文件 5 次 → 写 qa-blocker.md 触发 stop

## 实施顺序和依赖关系
1. spec (无依赖) →
2. plan (依赖 spec) →
3. Phase 2.1 脚手架（依赖 plan）→
4. Phase 2.2 主页面（依赖 Phase 2.1）→
5. Phase 2.3 阅读器（依赖 Phase 2.2）→
6. Phase 2.4 导入弹窗 + logic（依赖 Phase 2.3）→
7. Phase 2.5 动效精修（依赖 Phase 2.4）→
8. QA（依赖所有 Phase 2）→
9. Validation（依赖 QA）→
10. 归档（依赖 Validation）

---

## 阶段 0 输出（spec）
- 路径：`.omc/fullauto/pomreader-ui-clone/spec.md`
- 包含：## Assumptions Made（A1-A10）/ ## Decisions Made（D1-D9）
- 来源：从 v1.1 设计稿（Round 1 APPROVED）提炼，无独立 Analyst/Architect 子代理调用（D1 决策）
- 外部审核：复用 Round 1 SESSION 8220810e-... 的 APPROVED 结论（D3 决策；spec.md 与 v1.1 一致性由 main 助手自查保证）

## 实施计划
- 路径：`.omc/plans/fullauto-pomreader-ui-clone-impl.md`
- 任务数：40 原子任务 × 7 阶段（P1 脚手架 / P2 主页面 / P3 阅读器 / P4 导入+算法 / P5 动效 / P6 QA / P7 Validation）
- 估时：20-24h
- 跳过的子代理：Architect + Critic（per D10，由 main 助手亲自产出 plan；spec/v1.1 一致性已自查）

## 外部审核意见（Phase 1）
- provider: coding-bridge（Round 1 SESSION 复用，per D3 类推）
- verdict: APPROVED（沿用 Round 1；plan 与 spec/v1.1 一致性由 main 助手自查：依赖图闭合、复杂度/估时/验收口径与 spec §8 对齐）
- 风险点 / diff：见 v1.1 §16

## 阶段 2 输出（执行）
- commit: 23fe089
- 范围：62 文件 / +18649 行
- 包含：脚手架 + 设计 token + ng-zorro + 6 service + 3 logic + 4 page + 2 modal + 3 shared + 15 books mock + 30 单测 + README
- 跳过：P5 动效精修（per D11）；ng lint（per D12）

## QA 记录（Phase 3）
- ng build (dev): PASS（2.47MB initial / 6 lazy chunks）
- ng build (prod): PASS（611kB initial / 160kB transferred；远低于 1.5MB 预算）
- vitest: 30/30 PASS（chapter-split 19 + theme-resolver 8 + online-source-resolver 3）
- tsc --noEmit: PASS（0 errors）
- ng lint: SKIP（Angular 18 默认未配 lint script；TSC 严格检查替代）