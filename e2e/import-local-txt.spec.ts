// 导入本地 TXT E2E（真实浏览器回归）
// 覆盖：书架页「导入」菜单 → 导入本地 TXT modal → 真实文件上传 → 分章识别
//      → 确认导入 → 书架书卡 → 阅读页正文 → 刷新后仍可读
//
// 关键点（相对旧用例的强化）：
//  - 真实 input[type=file] 上传，不依赖任何隐藏/条件渲染假设
//  - 断言「识别到 2 个章节」，验证分章逻辑而非仅 modal 打开
//  - 断言书卡真实渲染、阅读页真实章节标题与正文标记
//  - reload 后复验，确认数据真的落进浏览器 IndexedDB
//  - 显式断言 window.pomAPI 不存在（无 Electron IPC → 走浏览器 PouchDB 后端）
//  - 收集 pageerror 并在结尾断言为空；不吞点击错误、不保留恒真断言
//  - 每个用例用独立书名：导入按书名去重，同名会被标「重复，将跳过」
//  - 定位器一律精确匹配文本并限定作用域，避免子串/全局误匹配
import { test, expect, type Page } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 第一章标题（章节切分按「第X章」行首匹配） */
const CHAPTER_ONE_TITLE = '第一章 起';
/** 正文唯一标记：用于证明读到的是真实章节内容 */
const MARKER_ONE = 'E2E_MARKER_ALPHA_7F3A';
const MARKER_TWO = 'E2E_MARKER_BETA_9C1B';

const SAMPLE_TXT = [
  CHAPTER_ONE_TITLE,
  `${MARKER_ONE} 这是甲段正文。`,
  '第二章 承',
  `${MARKER_TWO} 这是乙段正文。`,
].join('\n');

/** 本次运行创建的临时目录（用例结束后清理） */
const tempDirs: string[] = [];

/** 书名序号：同一次运行内保证书名互不相同 */
let titleSeq = 0;

/** 生成唯一书名（书名 = 文件名去扩展名，见 LocalTxtImportService.titleOf） */
function nextBookTitle(): string {
  titleSeq += 1;
  return `E2E导入样书_${titleSeq}_${Date.now().toString(36)}`;
}

/** 生成中性 TXT 样例文件（书名唯一，避免与既有书库撞名被跳过） */
function createSampleFile(title: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'pomreader-e2e-'));
  tempDirs.push(dir);
  const file = join(dir, `${title}.txt`);
  writeFileSync(file, SAMPLE_TXT, 'utf8');
  return file;
}

/** 走完「导入本地 TXT」全流程，结束时书架应出现书卡；返回实际导入的书名 */
async function importSampleBook(page: Page): Promise<string> {
  const title = nextBookTitle();
  await page.goto('#/bookshelf');

  const importButton = page.locator('app-page-header .actions button', {
    hasText: /^\s*导入\s*$/,
  });
  await expect(importButton).toBeVisible({ timeout: 10_000 });
  await importButton.click();

  const menuItem = page.locator('li[nz-menu-item]', { hasText: /^\s*导入本地 TXT\s*$/ });
  await expect(menuItem).toBeVisible({ timeout: 10_000 });
  await menuItem.click();

  const modal = page.locator('.ant-modal', { hasText: '导入本地 TXT' });
  await expect(modal).toBeVisible({ timeout: 10_000 });

  await modal.locator('input[type="file"]').setInputFiles(createSampleFile(title));
  await expect(modal.getByText('识别到 2 个章节')).toBeVisible({ timeout: 15_000 });

  // 限定在当前 modal 作用域内，避免页面上其它同名主按钮被误点
  await modal
    .locator('.ant-modal-footer button.ant-btn-primary', { hasText: /^\s*确认导入\s*$/ })
    .click();
  await expect(modal).toBeHidden({ timeout: 15_000 });
  return title;
}

test.describe('导入本地 TXT E2E', () => {
  test.afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('应能导入两章 TXT 并在书架出现书卡（浏览器 IndexedDB 路径）', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    const title = await importSampleBook(page);

    const card = page.locator('app-book-card', { hasText: title });
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card.locator('.meta .title')).toHaveText(title);

    // 无 Electron preload → 必然走浏览器 PouchDB（IndexedDB）后端
    const hasPomApi = await page.evaluate(
      () => (window as unknown as { pomAPI?: unknown }).pomAPI === undefined,
    );
    expect(hasPomApi).toBe(true);

    // 本用例独立证明持久化：刷新后书卡仍在（数据确实落在浏览器 IndexedDB）
    await page.reload();
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card.locator('.meta .title')).toHaveText(title);

    // 浏览器后端确实创建了 pomreader 库（PouchDB 的 IndexedDB 适配器加 `_pouch_` 前缀）
    // 用 expect.poll 等待库注册完成，避免 CI 高负载下 IndexedDB 写入尚未落定导致偶发失败
    await expect
      .poll(
        async () =>
          page.evaluate(async () => {
            const factory = indexedDB as IDBFactory & {
              databases?: () => Promise<{ name?: string }[]>;
            };
            if (!factory.databases) return [];
            const dbs = await factory.databases();
            return dbs.map((db) => db.name ?? '');
          }),
        { timeout: 15_000 },
      )
      .toContain('_pouch_pomreader');

    expect(errors).toEqual([]);
  });

  test('导入后应能打开阅读页读到正文，刷新后仍可读', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    const title = await importSampleBook(page);

    // 后端选择：浏览器构建不得走 Electron IPC
    expect(
      await page.evaluate(() => (window as unknown as { pomAPI?: unknown }).pomAPI === undefined),
    ).toBe(true);

    const card = page.locator('app-book-card', { hasText: title });
    await expect(card).toBeVisible({ timeout: 15_000 });
    await card.locator('a.book-card').click();

    await expect(page).toHaveURL(/#\/reader\//, { timeout: 15_000 });
    await expect(page.locator('.text-head h3')).toContainText('第一章', { timeout: 15_000 });
    await expect(page.locator('.read-content')).toContainText(MARKER_ONE, { timeout: 15_000 });
    // 章节总数为 2（来自导入时分章结果）
    await expect(page.locator('.text-info')).toContainText('第 1 / 2 章');

    await page.reload();
    await expect(page).toHaveURL(/#\/reader\//);
    await expect(page.locator('.text-head h3')).toContainText('第一章', { timeout: 15_000 });
    await expect(page.locator('.read-content')).toContainText(MARKER_ONE, { timeout: 15_000 });

    expect(errors).toEqual([]);
  });
});
