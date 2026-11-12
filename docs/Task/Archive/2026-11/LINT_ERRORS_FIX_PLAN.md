# 任务计划：修复 ESLint 存量报错并规范化 Angular 控制流

**Status**: ✅ Completed (completion time: 2026-11-12)  
**Creator**: Claude Code  

## 1. 任务背景与目标
在全仓代码检查中，单元测试（1193 tests）和应用构建均正常，但在执行 `npm run lint` 时出现了 44 处告警和报错（43 errors / 1 warning）。
为了保证项目质量基线健康度（0 errors / 0 warnings），本任务对这些存量工程配置和代码规范问题进行收口修复。

## 2. 详细子任务清单与状态
- [x] **Sub-task 1** ✅ 迁移 `book-source-subscriptions.component.html` 中的 `*ngFor` 到 Angular 22 控制流 `@for (sub of subTable.data; track (sub.id ?? $index))`，并清理组件中的 `NgFor` import
- [x] **Sub-task 2** ✅ 在 `eslint.config.js` 中将 TS 源码与 spec 规则块的 `'no-undef'` 显式关闭（TypeScript 编译器已有静态类型检查，符合 `@typescript-eslint` 最佳实践，避免全局 `.d.ts` 类型声明误报）
- [x] **Sub-task 3** ✅ 在 `tsconfig.app.json` 的 `include` 中显式登记 `"src/app/core/services/source-health.service.ts"`，精准解决 typescript-eslint 项目索引缺失问题，避免全局污染
- [x] **Sub-task 4** ✅ 改造 `electron/ipc/booksource-handler.spec.ts` 中 fake IpcMain 类型断言为 `fake as unknown as Parameters<typeof registerBookSourceHandler>[0]`，清理多余的 eslint-disable 注释且不引入 any
- [x] **Sub-task 5** ✅ 全量运行 `npm run lint`、`npm test`、`npm run build` 与 `npm run format:check`，达成 0 errors / 0 warnings 验收目标

## 3. 验收标准与结果
- `npm run lint` 输出 0 errors, 0 warnings（通过 ✅）
- `npm test` 75 个测试文件 1193 个单元测试全部通过（通过 ✅）
- `npm run build` 成功通过（通过 ✅）
- `npm run format:check` 代码风格 100% 匹配 Prettier（通过 ✅）
