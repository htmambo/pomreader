const puppeteer = require('puppeteer-core');
const PORT = process.env.PORT || 4200;
const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/google-chrome';

// 内置微型书站（请求拦截方式）：目录页（h1 书名 + dl>dd>a 章节链，对齐启发式解析器
// 可识别形态）+ 10 个章节页。书页 URL 与 dev server 同源（127.0.0.1:PORT），
// 由 puppeteer 请求拦截直接回包 —— 这是必须的：
// PageFetcherService 浏览器降级用 fetch(url, {mode:'no-cors'})，跨源只拿到不透明
// 空响应（恒 catalog-empty），同源才可读。零外网依赖、零额外端口。
// （原脚本导入 https://example.com/test-book-<ts> 伪 URL，跨源 + 无章节结构，永远 FAIL）
const CHAPTERS = 10;
const chapterDds = Array.from(
  { length: CHAPTERS },
  (_, i) => `<dd><a href="/smoke-book/${i + 1}.html">第${i + 1}章 冒烟</a></dd>`,
).join('\n');
const pages = {
  '/smoke-book/catalog.html': `<!DOCTYPE html><html><head><meta charset="utf-8"><title>冒烟测试书</title></head><body>
<div id="info"><h1>冒烟测试书</h1><p>作者：冒烟作者</p></div>
<div id="list"><dl><dt>正文卷</dt>${chapterDds}</dl></div>
</body></html>`,
};
for (let i = 1; i <= CHAPTERS; i++) {
  pages[`/smoke-book/${i}.html`] =
    `<!DOCTYPE html><html><head><meta charset="utf-8"><title>第${i}章</title></head><body>` +
    `<h1>第${i}章 冒烟</h1><p>第${i}章正文第一段，用于导入预加载。</p><p>第${i}章正文第二段。</p></body></html>`;
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    headless: true,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`[console] ${m.text()}`);
  });
  // 同源书页请求拦截：/smoke-book/** 直接回包，其它请求放行给 dev server
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const path = new URL(req.url()).pathname;
    const body = pages[path];
    if (body) {
      void req.respond({ status: 200, contentType: 'text/html; charset=utf-8', body });
    } else {
      void req.continue();
    }
  });
  try {
    // hash 路由：/bookshelf 路径写法会被 hash 路由器忽略，必须走 /#/bookshelf
    await page.goto(`http://127.0.0.1:${PORT}/#/bookshelf`, { waitUntil: 'networkidle2' });
    await new Promise((r) => setTimeout(r, 5000));
    const before = await page.$$eval('.book-card', (els) => els.length);
    console.log(`before books: ${before}`);
    // Click 导入 button
    const importBtn = await page.evaluateHandle(() =>
      [...document.querySelectorAll('button')].find((b) => b.textContent.trim().includes('导入')),
    );
    await importBtn.asElement().click();
    await new Promise((r) => setTimeout(r, 500));
    // Click 导入在线书页 menu item
    const menuItem = await page.evaluateHandle(() =>
      [...document.querySelectorAll('li')].find((li) => li.textContent.includes('导入在线书页')),
    );
    await menuItem.asElement().click();
    await new Promise((r) => setTimeout(r, 500));
    // Type URL（同源拦截书站的目录页）
    const bookUrl = `http://127.0.0.1:${PORT}/smoke-book/catalog.html`;
    await page.type('input[nz-input]', bookUrl);
    await new Promise((r) => setTimeout(r, 300));
    // Click 解析
    const parseBtn = await page.evaluateHandle(() =>
      [...document.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith('解析')),
    );
    await parseBtn.asElement().click();
    await new Promise((r) => setTimeout(r, 3000));
    // Verify chapter list appeared
    const chapters = await page.$$eval('.ant-list-item', (els) => els.length);
    console.log(`chapters parsed: ${chapters}`);
    await page.screenshot({ path: '/tmp/import-online-parsed.png', fullPage: true });
    // Click 确认导入
    const okBtn = await page.evaluateHandle(() =>
      [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '确认导入'),
    );
    await okBtn.asElement().click();
    await new Promise((r) => setTimeout(r, 3000));
    const after = await page.$$eval('.book-card', (els) => els.length);
    console.log(`after books: ${after}`);
    await page.screenshot({ path: '/tmp/after-import.png', fullPage: true });
    console.log(`\n=== ERRORS (${errors.length}) ===`);
    errors.forEach((e) => console.log(e));
    console.log(`\n=== RESULT ===`);
    console.log(
      after > before
        ? `✅ PASS: book added to list (${chapters} chapters parsed)`
        : `❌ FAIL: before=${before} after=${after} chapters=${chapters}`,
    );
  } catch (e) {
    console.log('TEST ERROR:', e.message, e.stack);
  } finally {
    await browser.close();
  }
})();
