/**
 * CF 过盾链路端到端验证（真实 Electron 主进程 + 真实 CF 站点）
 *
 * 验证点：
 *  1. sanity：普通站点 fetchHtml 不受影响
 *  2. Tier 1：CF 挑战站点 fetchHtml —— 隐藏窗口自动过盾后拿到真实 HTML
 *  3. Tier 1（书源代理链路）：booksourceHttpProxy 同样自动过盾
 *
 * 运行：node scripts/e2e-cf-guard.cjs（需 DISPLAY 可用；会短暂闪现主窗口）
 */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const puppeteer = require('puppeteer-core');

const DEBUG_PORT = 9333;
const CF_TARGETS = [
  'https://www.scrapingcourse.com/cloudflare-challenge',
  'https://nowsecure.nl/',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

(async () => {
  const electronBin = path.join(__dirname, '..', 'node_modules', '.bin', 'electron');
  const app = spawn(electronBin, ['.', `--remote-debugging-port=${DEBUG_PORT}`], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  app.stderr.on('data', (d) => {
    const line = String(d).trim();
    if (line && !/dbus|GPU|Vulkan|gbm|EGL/i.test(line)) console.log('[electron]', line);
  });

  let browser;
  const results = [];
  try {
    // 等 devtools 端口起来
    let version = null;
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      try {
        version = await getJson(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
        break;
      } catch { /* not ready */ }
    }
    if (!version) throw new Error('electron devtools 端口未就绪');
    browser = await puppeteer.connect({ browserWSEndpoint: version.webSocketDebuggerUrl, defaultViewport: null });

    // 找应用主页面
    let page = null;
    for (let i = 0; i < 20; i++) {
      const pages = await browser.pages();
      page = pages.find((p) => p.url().includes('index.html'));
      if (page) break;
      await sleep(500);
    }
    if (!page) throw new Error('未找到应用主页面');
    await sleep(2000); // 等 Angular 起来 + preload 注入

    const hasApi = await page.evaluate(() => !!window.pomAPI?.fetchHtml);
    if (!hasApi) throw new Error('window.pomAPI.fetchHtml 不存在（preload 未加载）');

    // 1. sanity：普通站点
    const sanity = await page.evaluate(async () => {
      const r = await window.pomAPI.fetchHtml('https://example.com/');
      return { error: r.error, ok: !!r.html && r.html.includes('Example Domain'), len: r.html?.length ?? 0 };
    });
    console.log('sanity (example.com):', JSON.stringify(sanity));
    results.push({ name: 'sanity 普通站点', pass: sanity.ok });

    // 2./3. CF 站点（fetchHtml + booksourceHttpProxy）
    for (const target of CF_TARGETS) {
      const r1 = await page.evaluate(async (url) => {
        const r = await window.pomAPI.fetchHtml(url);
        // 是否挑战页以主进程 isCfChallenge 判定为准（error === 'cf-challenge'），
        // 不再对 body 做关键词检测（真实页面可能含 cloudflare 字样造成误报）
        return { error: r.error, len: r.html?.length ?? 0 };
      }, target);
      console.log(`fetchHtml ${target}:`, JSON.stringify(r1));
      results.push({ name: `Tier1 fetchHtml ${target}`, pass: !r1.error && r1.len > 2000, inconclusive: r1.error === 'cf-challenge' });

      const r2 = await page.evaluate(async (url) => {
        const r = await window.pomAPI.booksourceHttpProxy({ url });
        return { status: r.status, cfChallenge: !!r.cfChallenge, len: r.body?.length ?? 0 };
      }, target);
      console.log(`proxy ${target}:`, JSON.stringify(r2));
      results.push({ name: `Tier1 proxy ${target}`, pass: r2.status === 200 && !r2.cfChallenge && r2.len > 2000, inconclusive: r2.cfChallenge });
    }
  } catch (e) {
    console.log('TEST ERROR:', e.message);
    process.exitCode = 2;
  } finally {
    if (browser) await browser.disconnect();
    app.kill('SIGTERM');
    await sleep(1000);
    if (!app.killed) app.kill('SIGKILL');
  }

  console.log('\n=== RESULT ===');
  for (const r of results) {
    console.log(`${r.pass ? '✅ PASS' : r.inconclusive ? '⚠️  INCONCLUSIVE(需人工验证窗口)' : '❌ FAIL'}: ${r.name}`);
  }
  if (!process.exitCode) process.exitCode = results.every((r) => r.pass) ? 0 : 1;
})();
