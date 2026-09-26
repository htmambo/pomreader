import { BrowserWindow, IpcMain } from 'electron';
import { URL } from 'url';
import { isPrivateHost } from './fetch-handler';
import { FETCH_PARTITION, getFetchSession, UA } from './fetch-session';

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
      win.loadURL(rawUrl, { userAgent: UA }),
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

/** Tier 1 自动过盾：隐藏窗口加载挑战页，等 cf_clearance 出现或挑战标记消失（与抓取共用串行 chain） */
export function cfPass(rawUrl: string): Promise<boolean> {
  const p = chain.then(() => cfPassOnce(rawUrl));
  chain = p.catch(() => undefined);
  return p;
}

async function cfPassOnce(rawUrl: string): Promise<boolean> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || isPrivateHost(u.hostname)) {
    return false;
  }

  const win = getRenderWindow();
  try {
    await Promise.race([
      win.loadURL(rawUrl, { userAgent: UA }),
      sleep(LOAD_TIMEOUT_MS).then(() => Promise.reject(new Error('timeout'))),
    ]);
  } catch {
    return false;
  }

  try {
    const deadline = Date.now() + CF_PASS_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(CF_PASS_POLL_MS);
      if (win.isDestroyed()) return false;
      // cf_clearance 落入共享 session → 过盾成功
      try {
        const cookies = await getFetchSession().cookies.get({ url: rawUrl, name: 'cf_clearance' });
        if (cookies.length > 0) return true;
      } catch {
        /* session 暂不可用，继续轮询 */
      }
      // 挑战标记消失（title 不含挑战文案且 body 无 cf-chl）→ 视为已过盾
      try {
        const marker = (await win.webContents.executeJavaScript(
          `(document.title || '') + '|' + (document.body ? document.body.innerHTML.slice(0, 4096) : '')`
        )) as string;
        const title = marker.split('|')[0];
        const stillChallenge =
          /Just a moment|请稍候|Attention Required/.test(title) || marker.includes('cf-chl');
        if (!stillChallenge) return true;
      } catch {
        continue; // 页面正在跳转，下轮重试
      }
    }
    return false;
  } finally {
    // 释放页面（停掉定时器/媒体），失败无碍下一次抓取
    try {
      await win.loadURL('about:blank');
    } catch {
      /* noop */
    }
  }
}
