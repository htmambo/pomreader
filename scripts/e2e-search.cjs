const puppeteer = require('puppeteer-core');
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
    await page.goto('http://127.0.0.1:4203/search', { waitUntil: 'networkidle2' });
    await new Promise((r) => setTimeout(r, 3000));
    // Type keyword
    await page.type('input[nz-input]', '西游');
    // Click 搜索
    const searchBtn = await page.evaluateHandle(() => [...document.querySelectorAll('button')].find((b) => b.textContent.includes('搜索')));
    await searchBtn.asElement().click();
    await new Promise((r) => setTimeout(r, 800));
    await page.screenshot({ path: '/tmp/search-results.png', fullPage: true });
    const resultCount = await page.$$eval('.ant-list-item', (els) => els.length);
    console.log(`results: ${resultCount}`);
    // Click first result (should be 西游记 本地库)
    const firstResult = await page.$('.ant-list-item');
    if (firstResult) {
      await firstResult.click();
      await new Promise((r) => setTimeout(r, 2000));
      const url = page.url();
      console.log(`after click first result, url: ${url}`);
    }
    await page.screenshot({ path: '/tmp/search-after-click.png', fullPage: true });
    console.log(`\n=== ERRORS (${errors.length}) ===`);
    errors.forEach((e) => console.log(e));
    console.log(`\n=== RESULT ===`);
    console.log(url.includes('/reader/') ? '✅ PASS: navigated to reader' : '❌ FAIL');
  } catch (e) {
    console.log('TEST ERROR:', e.message);
  } finally {
    await browser.close();
  }
})();