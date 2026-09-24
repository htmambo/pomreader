const puppeteer = require('puppeteer-core');
const path = require('path');
(async () => {
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    headless: 'new',
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`[console] ${m.text()}`); });
  try {
    await page.goto('http://127.0.0.1:4202/bookshelf', { waitUntil: 'networkidle2' });
    await new Promise((r) => setTimeout(r, 5000));
    const before = await page.$$eval('.book-card', (els) => els.length);
    console.log(`before books: ${before}`);
    const importBtn = await page.evaluateHandle(() => [...document.querySelectorAll('button')].find((b) => b.textContent.trim().includes('导入')));
    await importBtn.asElement().click();
    await new Promise((r) => setTimeout(r, 500));
    const menuItem = await page.evaluateHandle(() => [...document.querySelectorAll('li')].find((li) => li.textContent.includes('导入本地 TXT')));
    await menuItem.asElement().click();
    await new Promise((r) => setTimeout(r, 600));
    // upload TXT file
    const fileInput = await page.$('input[type="file"]');
    if (!fileInput) throw new Error('file input not found');
    await fileInput.uploadFile('/tmp/test-classic.txt');
    await new Promise((r) => setTimeout(r, 1500));
    await page.screenshot({ path: '/tmp/txt-parsed.png', fullPage: true });
    const chapterCount = await page.$$eval('.ant-list-item', (els) => els.length);
    console.log(`chapters parsed: ${chapterCount}`);
    // Click 确认导入
    const okBtn = await page.evaluateHandle(() => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '确认导入'));
    await okBtn.asElement().click();
    await new Promise((r) => setTimeout(r, 2000));
    const after = await page.$$eval('.book-card', (els) => els.length);
    console.log(`after books: ${after}`);
    await page.screenshot({ path: '/tmp/txt-after.png', fullPage: true });
    console.log(`\n=== ERRORS (${errors.length}) ===`);
    errors.forEach((e) => console.log(e));
    console.log(`\n=== RESULT ===`);
    console.log(after > before ? `✅ PASS: ${after - before} book added` : `❌ FAIL`);
  } catch (e) {
    console.log('TEST ERROR:', e.message);
  } finally {
    await browser.close();
  }
})();