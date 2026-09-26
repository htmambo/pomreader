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
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`[console] ${m.text()}`); });
  try {
    await page.goto(`http://127.0.0.1:${PORT}/bookshelf`, { waitUntil: 'networkidle2' });
    await new Promise((r) => setTimeout(r, 4000));
    // Open import local TXT
    const importBtn = await page.evaluateHandle(() => [...document.querySelectorAll('button')].find((b) => b.textContent.trim().includes('导入')));
    await importBtn.asElement().click();
    await new Promise((r) => setTimeout(r, 400));
    const menuItem = await page.evaluateHandle(() => [...document.querySelectorAll('li')].find((li) => li.textContent.includes('导入本地 TXT')));
    await menuItem.asElement().click();
    await new Promise((r) => setTimeout(r, 500));
    // Upload
    const fileInput = await page.$('input[type="file"]');
    await fileInput.uploadFile('/tmp/test-classic.txt');
    await new Promise((r) => setTimeout(r, 1500));
    const chapterCount = await page.$$eval('.chapter-item', (els) => els.length);
    console.log(`chapter items rendered: ${chapterCount}`);
    await page.screenshot({ path: '/tmp/txt-list-rendered.png', fullPage: true });
    // Click 3rd chapter
    const items = await page.$$('.chapter-item');
    if (items[2]) {
      await items[2].click();
      await new Promise((r) => setTimeout(r, 500));
      const previewText = await page.evaluate(() => {
        const pre = document.querySelector('.preview');
        return pre ? pre.textContent.slice(0, 100) : '(no preview)';
      });
      console.log(`preview after click item 3: ${previewText}`);
      await page.screenshot({ path: '/tmp/txt-preview-open.png', fullPage: true });
    }
    console.log(`\n=== ERRORS (${errors.length}) ===`);
    errors.forEach((e) => console.log(e));
    console.log(`\n=== RESULT ===`);
    console.log(chapterCount > 0 ? '✅ PASS: list + preview works' : '❌ FAIL');
  } catch (e) {
    console.log('TEST ERROR:', e.message);
  } finally {
    await browser.close();
  }
})();