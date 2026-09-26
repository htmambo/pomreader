// 书源系统 E2E 测试（T-016）
// 覆盖范围：核心路由可达性 + 书源列表 / 缓存设置 / 导入 modal
// 验收标准（spec §10 模块级 FR-1 ~ FR-4）：路由可达、关键组件可挂载、无 pageerror
import { test, expect } from '@playwright/test';

/**
 * 书源系统核心流程 E2E
 * 每个用例尽量独立，不依赖其他用例的状态（避免顺序耦合）
 */
test.describe('书源系统 E2E', () => {
  test('应能在书架页加载', async ({ page }) => {
    await page.goto('/bookshelf');
    // 项目 index.html 标题为「白虎阅读」
    await expect(page).toHaveTitle(/白虎|pomreader/i);
  });

  test('应能访问书源管理列表页', async ({ page }) => {
    await page.goto('/book-sources');
    await expect(page.locator('app-book-source-list')).toBeVisible({ timeout: 5000 });
  });

  test('应能访问书源搜索页', async ({ page }) => {
    await page.goto('/book-sources/search');
    await expect(page.locator('app-source-search')).toBeVisible({ timeout: 5000 });
  });

  test('应能访问缓存设置页', async ({ page }) => {
    await page.goto('/settings/cache');
    await expect(page.locator('app-cache-settings')).toBeVisible({ timeout: 5000 });
  });

  test('应能打开导入在线书 modal（条件存在）', async ({ page }) => {
    await page.goto('/bookshelf');
    // 书架页可能存在「导入」入口；若存在则尝试打开 modal
    const importBtn = page.locator('button:has-text("导入")').first();
    if (await importBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
      await importBtn.click();
      await expect(page.locator('app-import-online')).toBeVisible({ timeout: 3000 });
    }
    // 若入口尚未接入，仅保证书架页可达
    await expect(page).toHaveURL(/\/bookshelf/);
  });
});

/**
 * 路由可达性 + 控制台错误巡检
 * 遍历关键路由，断言 pageerror 与 console.error 均为空
 * 已知非阻塞警告：ng-zorro antd icon 动态加载提示、favicon 404
 */
test.describe('路由可达性（无控制台错误）', () => {
  const routes = [
    '/bookshelf',
    '/book-sources',
    '/book-sources/search',
    '/settings/cache',
    '/disclaimer',
  ];

  for (const route of routes) {
    test(`路由 ${route} 不抛错`, async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text());
      });
      await page.goto(route);
      await page.waitForLoadState('networkidle');
      // 过滤已知非阻塞警告
      const realErrors = errors.filter(
        (e) => !e.includes('[ng-zorro-antd-icon]') && !e.includes('favicon'),
      );
      expect(realErrors, `路由 ${route} 报错：\n${realErrors.join('\n')}`).toEqual([]);
    });
  }
});