const puppeteer = require('puppeteer-core');
const PORT = process.env.PORT || 4200;
const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/google-chrome';
(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    headless: 'new',
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`[console] ${m.text()}`);
  });
  try {
    await page.goto(`http://127.0.0.1:${PORT}/bookshelf`, { waitUntil: 'networkidle2' });
    await new Promise((r) => setTimeout(r, 5000));
    const before = await page.$$eval('.book-card', (els) => els.length);
    console.log(`before books: ${before}`);
    // Click 导入 button
    const importBtn = await page.evaluateHandle(() => [...document.querySelectorAll('button')].find((b) => b.textContent.trim().includes('导入')));
    await importBtn.asElement().click();
    await new Promise((r) => setTimeout(r, 500));
    // Click 导入在线书页 menu item
    const menuItem = await page.evaluateHandle(() => [...document.querySelectorAll('li')].find((li) => li.textContent.includes('导入在线书页')));
    await menuItem.asElement().click();
    await new Promise((r) => setTimeout(r, 500));
    // Type URL
    await page.type('input[nz-input]', 'https://example.com/test-book-' + Date.now());
    await new Promise((r) => setTimeout(r, 300));
    // Click 解析
    const parseBtn = await page.evaluateHandle(() => [...document.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith('解析')));
    await parseBtn.asElement().click();
    await new Promise((r) => setTimeout(r, 1500));
    // Verify chapter list appeared
    const chapters = await page.$$eval('.ant-list-item', (els) => els.length);
    console.log(`chapters parsed: ${chapters}`);
    await page.screenshot({ path: '/tmp/import-online-parsed.png', fullPage: true });
    // Click 确认导入
    const okBtn = await page.evaluateHandle(() => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '确认导入'));
    await okBtn.asElement().click();
    await new Promise((r) => setTimeout(r, 2000));
    const after = await page.$$eval('.book-card', (els) => els.length);
    console.log(`after books: ${after}`);
    await page.screenshot({ path: '/tmp/after-import.png', fullPage: true });
    console.log(`\n=== ERRORS (${errors.length}) ===`);
    errors.forEach((e) => console.log(e));
    console.log(`\n=== RESULT ===`);
    console.log(after > before ? '✅ PASS: book added to list' : `❌ FAIL: before=${before} after=${after}`);
  } catch (e) {
    console.log('TEST ERROR:', e.message, e.stack);
  } finally {
    await browser.close();
  }
})();