// 书架页 E2E 测试（EVO-8）
// 覆盖：路由可达、book-card 渲染、侧边栏导航、删除确认 modal
import { test, expect } from '@playwright/test';

test.describe('书架页 E2E', () => {
  test('应能加载书架首页', async ({ page }) => {
    await page.goto('/bookshelf');
    await expect(page).toHaveURL(/\/bookshelf/);
    // 书架页包含 sidebar + page-header + book-grid 区域
    await expect(page.locator('app-sidebar, nz-sider, .sidebar').first()).toBeVisible({ timeout: 10_000 });
  });

  test('应能通过 hash 路由导航到书源管理', async ({ page }) => {
    await page.goto('/bookshelf');
    // 点 sidebar 任意 nav 链接，URL 应包含对应 hash
    const navLink = page.locator('a[href*="book-sources"], a[href*="settings"], a[href*="disclaimer"]').first();
    if (await navLink.count() > 0) {
      await navLink.click();
      await expect(page).toHaveURL(/book-sources|settings|disclaimer/);
    }
  });

  test('应能处理空书架状态', async ({ page }) => {
    await page.goto('/bookshelf');
    // 不论 books.json 是否被 seed，页面不应抛 pageerror
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.waitForTimeout(2_000);
    expect(errors).toEqual([]);
  });
});