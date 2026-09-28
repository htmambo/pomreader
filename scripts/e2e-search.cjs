const puppeteer = require('puppeteer-core');
const PORT = process.env.PORT || 4200;
const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/google-chrome';
// 跨书源聚合搜索冒烟（书源管理 → 搜索 Tab，MultiSourceSearchService）。
// 三个历史假设已失效，本版修正：
// 1. /search 非 hash 写法会被 hash 路由器忽略 → 书籍搜索真实路由是 /#/book-sources/search
//    （/search 是内置浏览器页，按钮为「跳转」非「搜索」）
// 2. 无头浏览器每次全新 profile（空书库），且本页搜的是远程书源不是本地库，
//    「西游 本地库」假设不成立 → 断言改为确定性终态：结果列表或空态提示其一必现
// 3. 离线环境下远程源必然失败/0 结果 → 空态（请尝试更换关键词…）也是合法 PASS，
//    核心断言是搜索管线完整执行（loading 起落后到终态）且无 JS 运行时错误
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
  try {
    await page.goto(`http://127.0.0.1:${PORT}/#/book-sources/search`, {
      waitUntil: 'networkidle2',
    });
    await new Promise((r) => setTimeout(r, 4000));
    await page.type('input[nz-input]', '测试');
    const searchBtn = await page.evaluateHandle(() =>
      [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '搜索'),
    );
    if (!searchBtn.asElement()) throw new Error('搜索按钮未找到');
    await searchBtn.asElement().click();
    // 等搜索管线起落（远程源离线会快速失败；给足 loading 窗口）
    await new Promise((r) => setTimeout(r, 6000));
    await page.screenshot({ path: '/tmp/search-results.png', fullPage: true });
    const resultCount = await page.$$eval('.ant-list-item', (els) => els.length);
    const emptyHint = await page.evaluate(() =>
      document.body.innerText.includes('请尝试更换关键词'),
    );
    const stillLoading = await page.evaluate(() =>
      [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === '搜索中'),
    );
    console.log(`results: ${resultCount}, emptyHint: ${emptyHint}, stillLoading: ${stillLoading}`);
    console.log(`\n=== ERRORS (${errors.length}) ===`);
    errors.forEach((e) => console.log(e));
    console.log(`\n=== RESULT ===`);
    const pass = !stillLoading && (resultCount > 0 || emptyHint) && errors.length === 0;
    console.log(pass ? '✅ PASS: search pipeline reached terminal state' : '❌ FAIL');
  } catch (e) {
    console.log('TEST ERROR:', e.message);
  } finally {
    await browser.close();
  }
})();
