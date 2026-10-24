// 在线导入 modal E2E 测试
// 覆盖：书架页可达、「导入」下拉菜单含在线/本地两项、/search 的真实搜索界面
//
// 说明：/search 路由只渲染占位组件（app-search-placeholder，模板为空），
// 真正的搜索界面是外壳常驻保活的 <app-universal-search>，
// 因此断言对象是 app-universal-search 内的地址栏与「导入在线书页」按钮，而不是空占位。
import { test, expect } from '@playwright/test';

test.describe('在线导入 modal E2E', () => {
  test('应能从书架页进入导入流程（路径可达）', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await page.goto('#/bookshelf');
    await expect(page.locator('app-sidebar, nz-sider').first()).toBeVisible({ timeout: 10_000 });

    // 「导入」下拉应同时提供在线书页与本地 TXT 两个入口
    const importButton = page.locator('app-page-header .actions button', {
      hasText: /^\s*导入\s*$/,
    });
    await expect(importButton).toBeVisible({ timeout: 10_000 });
    await importButton.click();
    await expect(page.locator('li[nz-menu-item]', { hasText: /^\s*导入在线书页\s*$/ })).toBeVisible(
      { timeout: 10_000 },
    );
    await expect(page.locator('li[nz-menu-item]', { hasText: /^\s*导入本地 TXT\s*$/ })).toBeVisible(
      { timeout: 10_000 },
    );

    expect(errors).toEqual([]);
  });

  test('应能在搜索页打开（万能搜索界面真实可见）', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await page.goto('#/search');
    await expect(page).toHaveURL(/\/search/);

    // 外壳常驻保活的万能搜索组件在 /search 激活时可见
    const searchPanel = page.locator('app-universal-search');
    await expect(searchPanel).toBeVisible({ timeout: 10_000 });
    await expect(
      searchPanel.locator('input[placeholder="输入网址或搜索词，回车跳转"]'),
    ).toBeVisible({ timeout: 10_000 });
    await expect(searchPanel.locator('button[title="导入在线书页"]')).toBeVisible({
      timeout: 10_000,
    });

    expect(errors).toEqual([]);
  });
});
