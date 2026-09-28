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
      // 阈值说明（2026-09-28 Phase 5 收紧后）：
      // services 覆盖短板已补齐（db/book facade/chapter-loader/import-via-source/
      // source-test/source-search-state/settings/toast/sandbox/worker-pool 专项 spec），
      // 实测 branches 85.74%。历史背景：vitest 4 起 coverage 改 AST 重映射，
      // else/默认分支真实计入分母（分支总数 ~1430→1655）。
      // branches=80：实测 85.74% 留 ~5pp 缓冲（沿用既有"贴边无缓冲"教训）。
      // lines/statements=50、functions=60 维持渐进基线，后续可另行收紧。
      thresholds: {
        lines: 50,
        functions: 60,
        branches: 80,
        statements: 50,
      },
    },
  },
});
