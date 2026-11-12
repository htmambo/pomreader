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
      // 阈值说明（2026-11-12 收紧）：
      // 此前 lines/statements=50、functions=60、branches=80 相对实测（91-93%）形同虚设，
      // good-sites.ts（0%）、legado-parser.ts（函数 47%）均可轻松过关。
      // 现按实测值下调留缓冲：lines 93.62% / statements 91.68% / functions 90.75% /
      // branches 86.19%。各留 ~2-6pp 缓冲，防新增代码小幅拉低即破线。
      // 历史背景：vitest 4 起 coverage 改 AST 重映射，else/默认分支真实计入分母。
      thresholds: {
        lines: 88,
        functions: 85,
        branches: 80,
        statements: 86,
      },
    },
  },
});
