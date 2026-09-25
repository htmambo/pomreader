// Playwright E2E 测试配置（T-016）
// 依赖：Angular CLI dev server 已在 4200 端口运行（webServer 自动启动）
// 运行：npm run e2e
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  // 测试文件根目录
  testDir: './e2e',
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
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
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