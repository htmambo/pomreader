// Playwright E2E 测试配置（T-016 + EVO-8；P-0-2 从 e2e/ 移到仓库根）
// 依赖：Angular CLI dev server 已在 4200 端口运行（webServer 自动启动）
// 运行：npm run e2e / npx playwright test（均从仓库根执行，自动发现本文件）
// 位置说明：配置必须在仓库根，否则 `playwright test` 找不到配置会回落到
// 默认 testDir=cwd + 默认 testMatch，误收 54 个 vitest 单测并报 0 tests
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  // 测试文件根目录：e2e/，只收 e2e 下的 spec（vitest 单测在 src/、electron/，天然隔离）
  testDir: './e2e',
  // 仅匹配 *.spec.ts（显式声明，避免将来默认匹配扩大范围）
  testMatch: /.*\.spec\.ts$/,
  testIgnore: ['**/node_modules/**', '**/dist/**'],
  // 单用例超时 30s（包含网络请求 + Angular 启动）
  timeout: 30_000,
  // 串行执行，避免多个 dev server 实例同时拉起
  fullyParallel: false,
  // CI/本地统一不重试（保留失败现场便于排查）
  retries: 0,
  // 输出格式：list（精简）
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:4200',
    // 仅在首次重试时记录 trace
    trace: 'on-first-retry',
    // 关闭有头浏览器时的截图（默认仅失败时截图已足够）
    screenshot: 'only-on-failure',
  },
  // 仅 chromium（与 Electron 行为最接近）
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // 自动启动 ng serve（webServer）
  webServer: {
    command: 'npm run start',
    url: 'http://localhost:4200',
    // 已有 4200 端口运行时复用，避免重复拉起 dev server
    reuseExistingServer: true,
    // dev server 冷启动最长等待 60s
    timeout: 60_000,
  },
});
