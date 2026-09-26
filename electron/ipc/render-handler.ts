import { BrowserWindow, IpcMain } from 'electron';
import { URL } from 'url';
import { isPrivateHost } from './fetch-handler';
import { FETCH_PARTITION, getFetchSession, getUA } from './fetch-session';

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
let chain: Promise<unknown> = Promise.resolve();

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 共享隐藏窗口：session 持久化（与 net.request 抓取链路共享 persist:fetch，CF cookie 互通） */
function getRenderWindow(): BrowserWindow {
  if (renderWin && !renderWin.isDestroyed()) return renderWin;
  renderWin = new BrowserWindow({
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
  renderWin.on('closed', () => {
    renderWin = null;
  });
  return renderWin;
}

async function renderOnce(rawUrl: string): Promise<{ text?: string; error?: string }> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return { error: 'invalid-url' };
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || isPrivateHost(u.hostname)) {
    return { error: 'invalid-url' };
  }

  const win = getRenderWindow();
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
  // 共享隐藏窗口，抓取请求串行执行
  ipcMain.handle('pom:fetch-rendered', (_e, rawUrl: string) => {
    const p = chain.then(() => renderOnce(rawUrl));
    chain = p.catch(() => undefined);
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
    `(document.title || '') + '|' + (document.body ? document.body.innerHTML.slice(0, 4096) : '')`
  )) as string;
}

/**
 * 等窗口里的页面不再是挑战页（轮询 title/body 标记）。
 * 真实浏览器导航通常无感通过 managed challenge；交互式 Turnstile 则一直保持挑战页。
 */
export async function waitForPageCleared(
  win: BrowserWindow,
  timeoutMs: number
): Promise<boolean> {
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
      'document.documentElement.outerHTML'
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
  const p = chain.then(() => cfFetchHtmlOnce(rawUrl));
  chain = p.catch(() => undefined);
  return p;
}

async function cfFetchHtmlOnce(rawUrl: string): Promise<string | null> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || isPrivateHost(u.hostname)) {
    return null;
  }

  const win = getRenderWindow();
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
