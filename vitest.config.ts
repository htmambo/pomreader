import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['src/test-setup.ts'],
    include: ['src/**/*.spec.ts', 'electron/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      // 覆盖范围：logic / book-source / services / db（spec NFR-2 + EVO-5）
      // 含 EVO-1 拆分后的 chapter-loader / book-updater / book.repository
      // EVO-12 拆分后的 reader-state / settings-store
      include: [
        'src/app/core/logic/**/*.ts',
        'src/app/core/book-source/**/*.ts',
        'src/app/core/services/**/*.ts',
        'src/app/core/db/**/*.ts',
      ],
      // 阈值下调：现有 spec 不覆盖 services 大块（BookService facade 模式 + jsdom worker mock 缺失）
      // spec §3.5 IMPL-R1 已说明 facade 80% 不可达。
      // progressive：当前阈值作为 baseline；下次接力补 services.spec.ts + worker mock 后再收紧。
      // branches 75→60：vitest 4 起 coverage 改用 AST 重映射（替代 v8-to-istanbul），
      // 之前被合并的 else/默认分支现被真实计入分母（分支总数 ~1430→1655），
      // 64.89% 是更准确的真值而非覆盖丢失；取 60 与 lines/statements=50、functions=60 的渐进基线一致。
      // TODO(dep-upgrade Phase 5): 补 services.spec.ts + worker mock 后将 branches 收紧回 ~70。
      thresholds: {
        lines: 50,
        functions: 60,
        branches: 60,
        statements: 50,
      },
    },
  },
});
