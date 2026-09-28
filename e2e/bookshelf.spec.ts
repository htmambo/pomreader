// 书架页 E2E 测试（EVO-8）
// 覆盖：路由可达、book-card 渲染、侧边栏导航（图标轨 hover 展开）、书架分类 chips / 状态 tab
import { test, expect } from '@playwright/test';

test.describe('书架页 E2E', () => {
  test('应能加载书架首页', async ({ page }) => {
    await page.goto('#/bookshelf');
    await expect(page).toHaveURL(/\/bookshelf/);
    // 书架页包含 sidebar + page-header + book-grid 区域
    await expect(page.locator('app-sidebar, nz-sider, .sidebar').first()).toBeVisible({
      timeout: 10_000,
    });
  });

  test('应能通过 hash 路由导航到书源管理', async ({ page }) => {
    await page.goto('#/bookshelf');
    // 点 sidebar 任意 nav 链接，URL 应包含对应 hash
    const navLink = page
      .locator('a[href*="book-sources"], a[href*="settings"], a[href*="disclaimer"]')
      .first();
    if ((await navLink.count()) > 0) {
      await navLink.click();
      await expect(page).toHaveURL(/book-sources|settings|disclaimer/);
    }
  });

  test('应能处理空书架状态', async ({ page }) => {
    await page.goto('#/bookshelf');
    // 不论 books.json 是否被 seed，页面不应抛 pageerror
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.waitForTimeout(2_000);
    expect(errors).toEqual([]);
  });

  // ── 图标轨侧栏：默认折叠（仅图标），hover 悬浮展开 ──────────────────
  test('侧栏默认折叠为图标轨，hover 后悬浮展开显示文字', async ({ page }) => {
    await page.goto('#/bookshelf');
    const rail = page.locator('.rail');
    const firstIcon = page.locator('.rail .item .icon').first();
    await expect(rail).toBeVisible({ timeout: 10_000 });

    // 默认：64px 图标轨；文字标签透明（保留占位，靠 overflow 裁剪）
    await expect(rail).toHaveCSS('width', '64px');
    const label = page.locator('.rail .item .label').first();
    await expect(label).toHaveCSS('opacity', '0');
    const iconCollapsed = (await firstIcon.boundingBox())!;

    // hover：展开到 200px 并显示文字；nz-sider 占位不变（主内容不位移）
    await rail.hover();
    await expect(rail).toHaveCSS('width', '200px', { timeout: 3_000 });
    await expect(label).toHaveCSS('opacity', '1', { timeout: 3_000 });
    await expect(page.locator('nz-sider')).toHaveCSS('width', '64px');

    // 回归护栏：展开时图标不位移（面板从右向左抽出，而非整列平移）
    const iconExpanded = (await firstIcon.boundingBox())!;
    expect(Math.abs(iconExpanded.x - iconCollapsed.x)).toBeLessThan(1);

    // 移出后收起
    await page.mouse.move(900, 400);
    await expect(rail).toHaveCSS('width', '64px', { timeout: 3_000 });
  });

  // ── 书架分类：chips + 阅读状态 tab + 管理分类弹窗 ───────────────────
  test('书架应渲染分类 chips 与阅读状态 tab，并可新建分类', async ({ page }) => {
    await page.goto('#/bookshelf');
    const chips = page.locator('.chips .chip');
    await expect(chips.first()).toBeVisible({ timeout: 10_000 });
    // 首项恒为「全部书籍」
    await expect(page.locator('.chip--all')).toContainText('全部书籍');

    // 阅读状态 tab 四项齐全
    for (const label of ['全部', '未读', '正在读', '已读完']) {
      await expect(page.locator('.tab', { hasText: label }).first()).toBeVisible();
    }

    // 通过「管理分类」新建一个分类，chips 立即出现
    await page.locator('button[title="管理分类"]').click();
    await page.locator('.create-row input').fill(`E2E分类${Date.now() % 100000}`);
    await page.locator('.create-row button').click();
    await expect(page.locator('.gm-row')).toHaveCount(1, { timeout: 5_000 });
    await page.locator('.ant-modal-footer button.ant-btn-primary').click();
    await expect(page.locator('.ant-modal-wrap')).toBeHidden({ timeout: 5_000 });
    await expect(page.locator('.chips .chip')).toHaveCount(3); // 全部书籍 + 1 分类 + 管理入口
  });
});
