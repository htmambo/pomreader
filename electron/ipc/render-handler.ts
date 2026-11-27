import { BrowserWindow, IpcMain } from 'electron';
import { URL } from 'url';
import { isPrivateHost } from './net-guard';
import { FETCH_PARTITION, getUA } from './fetch-session';

const LOAD_TIMEOUT_MS = 20000;
const POLL_INTERVAL_MS = 400;
const STABLE_POLLS_NEEDED = 2; // 文本连续 2 次稳定即认为页面 JS 已完成重排/注水
const MAX_POLLS = 15; // 最长 ~6s 稳定等待
const CF_PASS_TIMEOUT_MS = 20000; // Tier 1 自动过盾总上限
const CF_PASS_POLL_MS = 500;

/**
 * 渲染后 DOM 上的正文提取脚本。
 * 与渲染进程 heuristic-parser 同一密度算法（0.6 骤降截断），
 * 但评分/提取用可见文本 vtext（getComputedStyle 逐层剔除 display:none 水印/诱饵、
 * visibility:hidden 目录侧栏等不可见子树）。
 * （导出供 e2e 脚本复用）
 */
export const EXTRACT_SCRIPT = `(function(){
  var PUNCT=/[，。？！：、]/g;
  var SKIP={A:1,BUTTON:1,SCRIPT:1,STYLE:1,NOSCRIPT:1,IFRAME:1,INPUT:1,SELECT:1,TEXTAREA:1,NAV:1,HEADER:1,FOOTER:1};
  var BLOCK={BR:1,DIV:1,P:1,H1:1,H2:1,H3:1,H4:1,LI:1,DD:1,DT:1,SECTION:1,ARTICLE:1,TR:1};
  function visible(el){var s=getComputedStyle(el);return s.display!=='none'&&s.visibility!=='hidden'&&s.visibility!=='collapse';}
  // 可见文本（display:none / visibility:hidden 子树整体剔除；innerText 管不了 visibility）
  function vtext(el){
    var out='';
    for(var i=0;i<el.childNodes.length;i++){
      var n=el.childNodes[i];
      if(n.nodeType===3){out+=n.nodeValue;continue;}
      if(n.nodeType!==1)continue;
      if(SKIP[n.tagName]||!visible(n))continue;
      var t=vtext(n);
      if(BLOCK[n.tagName]){out+='\\n'+t+'\\n';}else{out+=t;}
    }
    return out;
  }
  function cjk(t){var n=0;for(var i=0;i<t.length;i++){var c=t.charCodeAt(i);if(c>=0x4e00&&c<=0x9fff)n++;}return n;}
  function density(el){var t=vtext(el);return cjk(t)+10*((t.match(PUNCT)||[]).length);}
  var cur=document.body;
  while(cur){
    var best=null,bs=-1;
    for(var i=0;i<cur.children.length;i++){
      var ch=cur.children[i];
      if(SKIP[ch.tagName]||!visible(ch))continue;
      var sc=density(ch);
      if(sc>bs){bs=sc;best=ch;}
    }
    if(!best)break;
    if(0.6*density(cur)>bs)break;
    cur=best;
  }
  var text=vtext(cur);
  return text.split('\\n').map(function(s){return s.trim();}).filter(Boolean).join('\\n\\n');
})()`;

let renderWin: BrowserWindow | null = null;
/** CF 过盾专用隐藏窗口：与渲染抓取窗口**分离**（见下方说明） */
let cfWin: BrowserWindow | null = null;

/**
 * 功能级串行队列（两条链互不排队）。
 *
 * 原实现只有一条全局 chain，`pom:fetch-rendered` 与 `cfFetchHtmlHidden` 共用 →
 * 一次 CF 过盾抓取（最长 40s = 20s loadURL 竞速 + 20s 等挑战消失）会把**所有**
 * 渲染抓取一起堵在后面。
 */
let renderChain: Promise<unknown> = Promise.resolve();
let cfChain: Promise<unknown> = Promise.resolve();

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 远程内容窗口的导航护栏。
 *
 * `loadURL` 的入口 URL 已在调用方校验过，但**服务器重定向**由 Chromium 内部跟随，
 * 不会再次经过 isPrivateHost —— 公网页面 302 到 `http://127.0.0.1:端口` 就成了 SSRF。
 * 在 will-redirect / will-navigate 上统一拦截非 http(s) 与内网目标。
 */
export function guardRemoteNavigation(win: BrowserWindow): void {
  const isSafeUrl = (url: string): boolean => {
    try {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
      return !isPrivateHost(u.hostname);
    } catch {
      return false;
    }
  };
  win.webContents.on('will-navigate', (event, url) => {
    if (!isSafeUrl(url)) event.preventDefault();
  });
  win.webContents.on('will-redirect', (event, url) => {
    if (!isSafeUrl(url)) event.preventDefault();
  });
  // 页面 window.open 不走 will-navigate / will-redirect，必须单独禁止；
  // 否则远程页可借全局 window-open 处理器把内网地址 loadURL 进来（SSRF 读取）。
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

/**
 * 隐藏窗口工厂。
 *
 * session 持久化（与 net.request 抓取链路共享 persist:fetch，CF cookie 互通）。
 */
function createHiddenWindow(): BrowserWindow {
  const win = new BrowserWindow({
    show: false,
    width: 1000,
    height: 800,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      partition: FETCH_PARTITION,
    },
  });
  guardRemoteNavigation(win);
  return win;
}

/** 渲染抓取专用隐藏窗口 */
function getRenderWindow(): BrowserWindow {
  if (renderWin && !renderWin.isDestroyed()) return renderWin;
  renderWin = createHiddenWindow();
  renderWin.on('closed', () => {
    renderWin = null;
  });
  return renderWin;
}

/**
 * CF 过盾专用隐藏窗口。
 *
 * **为什么必须与渲染窗口分离**：同一 BrowserWindow 同一时刻只能加载一个页面 ——
 * 两个 loadURL 会互相打断，且任一方的 about:blank 清理会清掉另一方正在用的页面。
 * 若只拆队列而共用窗口，CF 抓取期间普通渲染抓取仍会被窗口物理约束挡住（最长 40s），
 * 拆队列等于白拆。故 CF 走自己的窗口：
 * - 两条链彻底互不阻塞（各自的窗口 + 各自的队列）
 * - 两个窗口共用同一个 partition（FETCH_PARTITION）→ cookie / cf_clearance 互通，
 *   用户在渲染窗口里过的盾对 CF 窗口同样有效
 * - CF 窗口按需创建（只有真遇到挑战页才建），不常驻占内存
 */
function getCfWindow(): BrowserWindow {
  if (cfWin && !cfWin.isDestroyed()) return cfWin;
  cfWin = createHiddenWindow();
  cfWin.on('closed', () => {
    cfWin = null;
  });
  return cfWin;
}

async function renderOnce(
  win: BrowserWindow,
  rawUrl: string,
): Promise<{ text?: string; error?: string }> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return { error: 'invalid-url' };
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || isPrivateHost(u.hostname)) {
    return { error: 'invalid-url' };
  }

  try {
    await Promise.race([
      win.loadURL(rawUrl, { userAgent: getUA() }),
      sleep(LOAD_TIMEOUT_MS).then(() => Promise.reject(new Error('timeout'))),
    ]);
  } catch (e) {
    return { error: (e as Error).message === 'timeout' ? 'timeout' : 'source-unavailable' };
  }

  let last = '';
  let stable = 0;
  let result: { text?: string; error?: string } = { error: 'parse-failed' };
  for (let i = 0; i < MAX_POLLS; i++) {
    await sleep(POLL_INTERVAL_MS);
    if (win.isDestroyed()) break;
    let text = '';
    try {
      text = (await win.webContents.executeJavaScript(EXTRACT_SCRIPT)) as string;
    } catch {
      continue; // 页面正在跳转/销毁中，下轮重试
    }
    if (text && text === last) {
      stable++;
      if (stable >= STABLE_POLLS_NEEDED) {
        result = { text };
        break;
      }
    } else {
      stable = 0;
    }
    if (text) last = text;
  }
  if (!result.text && last) result = { text: last };

  // 释放页面（停掉定时器/媒体），失败无碍下一次抓取
  try {
    await win.loadURL('about:blank');
  } catch {
    /* noop */
  }
  return result;
}

export function registerRenderHandler(ipcMain: IpcMain): void {
  // 渲染抓取：功能队列内串行 + 窗口级互斥（与 CF 过盾互不排队）
  ipcMain.handle('pom:fetch-rendered', (_e, rawUrl: string) => {
    const p = renderChain.then(() => renderOnce(getRenderWindow(), rawUrl));
    renderChain = p.catch(() => undefined);
    return p;
  });
}

/** 挑战页判定（title / body 标记），cf-guard 的可见窗口流程复用 */
export function looksLikeChallenge(marker: string): boolean {
  const title = marker.split('|')[0];
  return (
    /Just a moment|请稍候|Attention Required/.test(title) ||
    marker.includes('cf-chl') ||
    marker.includes('challenge-platform')
  );
}

async function pageMarker(win: BrowserWindow): Promise<string> {
  return (await win.webContents.executeJavaScript(
    `(document.title || '') + '|' + (document.body ? document.body.innerHTML.slice(0, 4096) : '')`,
  )) as string;
}

/**
 * 等窗口里的页面不再是挑战页（轮询 title/body 标记）。
 * 真实浏览器导航通常无感通过 managed challenge；交互式 Turnstile 则一直保持挑战页。
 */
export async function waitForPageCleared(win: BrowserWindow, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(CF_PASS_POLL_MS);
    if (win.isDestroyed()) return false;
    // about:blank / 加载中的空页面不算"挑战已消失"
    if (!win.webContents.getURL().startsWith('http')) continue;
    try {
      if (!looksLikeChallenge(await pageMarker(win))) return true;
    } catch {
      continue; // 页面跳转中，下轮重试
    }
  }
  return false;
}

/** 提取渲染后的完整 HTML（浏览器侧已完成 charset 解码） */
export async function extractRenderedHtml(win: BrowserWindow): Promise<string | null> {
  try {
    const html = (await win.webContents.executeJavaScript(
      'document.documentElement.outerHTML',
    )) as string;
    return html && html.length > 0 ? html : null;
  } catch {
    return null;
  }
}

/**
 * CF 挑战回退抓取（Tier 1 核心）：隐藏窗口真实加载 URL，等挑战消失后直接提取渲染 HTML。
 * 不再追求 net.request 与浏览器的指纹对等——浏览器能打开页面即视为成功。
 * 返回 null = 加载失败 / 挑战未解除（交互式 Turnstile 需人工，走 Tier 2）。
 */
export function cfFetchHtmlHidden(rawUrl: string): Promise<string | null> {
  const p = cfChain.then(() => cfFetchHtmlOnce(getCfWindow(), rawUrl));
  cfChain = p.catch(() => undefined);
  return p;
}

async function cfFetchHtmlOnce(win: BrowserWindow, rawUrl: string): Promise<string | null> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || isPrivateHost(u.hostname)) {
    return null;
  }

  try {
    await Promise.race([
      win.loadURL(rawUrl, { userAgent: getUA() }),
      sleep(LOAD_TIMEOUT_MS).then(() => Promise.reject(new Error('timeout'))),
    ]);
  } catch {
    return null;
  }

  try {
    if (!(await waitForPageCleared(win, CF_PASS_TIMEOUT_MS))) return null;
    return await extractRenderedHtml(win);
  } finally {
    // 释放页面（停掉定时器/媒体），失败无碍下一次抓取
    try {
      await win.loadURL('about:blank');
    } catch {
      /* noop */
    }
  }
}
