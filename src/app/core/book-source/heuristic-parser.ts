/**
 * 通用启发式书页解析（复刻原 vendor hS/fS/nS/rS 算法）
 *
 * 原 vendor 用正文/链接密度评分找目录容器与正文段落，不限站点。
 * - hS: 给每个节点评分（A 标签 + 章节标题模式 = 10，否则 1），自底向上累加，
 *        找链接密度最高的路径 = 目录容器，提取其中所有 A = 章节列表
 * - fS: 同理找文字密度最高的容器 = 正文，提取段落
 * - og:novel:* meta 提取书名/作者/分类/描述/封面
 */

/** 中文标点（，。？！：、）— 用于正文密度评分 */
const CJK_PUNCT = /[，。？！：、]/g;

/** 数字/中文数字 — 用于章节标题识别 */
const NUMERIC = /[0-9零一二三四五六七八九十壹贰叁肆伍陆柒捌玖拾佰仟百千]/g;

/** 计算文本里中文字符数（近似 nS） */
function cjkCharCount(text: string | null | undefined): number {
  if (!text) return 0;
  let n = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    // CJK 统一汉字 + 扩展
    if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf)) n++;
  }
  return n;
}

/** 计算章节标题数字/中文数字匹配数（近似 rS） */
function numericCount(text: string | null | undefined): number {
  if (!text) return 0;
  const m = text.match(NUMERIC);
  return m ? m.length : 0;
}

/** 是否疑似章节标题链接（含数字 + 足够中文） */
function isChapterLikeLink(text: string | null | undefined): boolean {
  return cjkCharCount(text) > 0 && numericCount(text) > 0;
}

/** 递归展平所有后代节点（含自身），跳过 A/BUTTON/SCRIPT */
function flattenNodes(root: Node, skipTags: string[] = []): Node[] {
  const out: Node[] = [];
  if (root.nodeType === 1) {
    const tag = (root as Element).tagName;
    if (skipTags.includes(tag)) return out;
  }
  out.push(root);
  if (root.childNodes) {
    for (let i = 0; i < root.childNodes.length; i++) {
      out.push(...flattenNodes(root.childNodes[i], skipTags));
    }
  }
  return out;
}

export interface ParsedCatalog {
  title: string;
  author: string;
  chapters: { title: string; url: string }[];
}

/**
 * 解析目录页（复刻 hS：链接密度评分找目录容器）
 */
export function parseCatalog(doc: Document, baseUrl: string): { title: string; author: string; chapters: { title: string; url: string }[] } {
  // 1. og:novel:* meta 优先
  const title = getMeta(doc, 'og:novel:book_name') || doc.title || '未知书名';
  const author = getMeta(doc, 'og:novel:author') || '未知';

  // 2. 链接密度评分找目录容器
  const scores = new Map<Element, number>();
  const all: Element[] = [];

  const walk = (el: Element): void => {
    all.push(el);
    if (el.tagName === 'A') {
      scores.set(el, isChapterLikeLink((el as HTMLAnchorElement).innerText) ? 10 : 1);
    } else {
      scores.set(el, 0);
    }
    for (let i = 0; i < el.children.length; i++) walk(el.children[i]);
  };
  walk(doc.body);

  // 自底向上累加子节点分数到父节点
  for (let i = all.length - 1; i >= 0; i--) {
    const node = all[i];
    const parent = node.parentElement;
    if (parent && scores.has(parent)) {
      scores.set(parent, (scores.get(parent) ?? 0) + (scores.get(node) ?? 0));
    }
  }

  // 从 body 沿最高分子节点下行，找到目录容器
  const path: Element[] = [];
  let cur: Element | null = doc.body;
  while (cur) {
    path.push(cur);
    let best: Element | null = null;
    let bestScore = -1;
    for (let i = 0; i < cur.children.length; i++) {
      const child: Element = cur.children[i];
      const sc = scores.get(child) ?? 0;
      if (sc > bestScore) {
        bestScore = sc;
        best = child;
      }
    }
    cur = best;
    if (cur && cur.tagName === 'A') break;
  }

  // 取路径倒数第二个节点作为目录容器（最高密度的父级）
  const container = path[path.length - 2] ?? path[path.length - 1] ?? doc.body;
  const links = Array.from(container.querySelectorAll<HTMLAnchorElement>('a'));

  const chapters: { title: string; url: string }[] = [];
  for (const a of links) {
    const t = a.textContent?.trim();
    const href = a.getAttribute('href');
    if (!t || !href) continue;
    // 只收疑似章节链接（有文字 + 非锚点）
    if (t.length < 2) continue;
    try {
      const abs = new URL(href, baseUrl).href;
      chapters.push({ title: t, url: abs });
    } catch {
      /* skip invalid */
    }
  }

  return { title, author, chapters };
}

/**
 * 解析正文页（复刻 fS：文字密度评分找正文容器）
 */
export function parseChapterContent(doc: Document): string {
  const scores = new Map<Node, number>();
  // 展平所有节点（跳过 A/BUTTON/SCRIPT）
  const nodes = flattenNodes(doc.body, ['A', 'BUTTON', 'SCRIPT']);

  for (const node of nodes) {
    if (node.nodeType !== 1) continue;
    const text = (node as Element).textContent;
    // 密度 = 中文字符数 + 10 * 中文标点数
    const density = cjkCharCount(text) + 10 * ((text?.match(CJK_PUNCT)?.length ?? 0));
    scores.set(node, density);
  }

  // 找文字密度最高的路径
  const path: Node[] = [];
  let cur: Node | null = doc.body;
  while (cur) {
    path.push(cur);
    let best: Node | null = null;
    let bestScore = -1;
    for (let i = 0; i < cur.childNodes.length; i++) {
      const child: Node = cur.childNodes[i];
      if (child.nodeType !== 1) continue;
      const sc = scores.get(child) ?? 0;
      if (sc > bestScore) {
        bestScore = sc;
        best = child;
      }
    }
    cur = best;
  }

  // 最深的高密度节点 = 正文容器
  const container = (path[path.length - 1] as Element) ?? doc.body;
  // 提取段落：按 <p> 或 <br> 分段
  container.querySelectorAll('script, style, ins, .adsbygoogle').forEach((n) => n.remove());
  const paragraphs: string[] = [];

  const pNodes = container.querySelectorAll('p, div');
  if (pNodes.length > 0) {
    for (const p of Array.from(pNodes)) {
      const t = p.textContent?.trim();
      if (t && t.length > 10) paragraphs.push(t);
    }
  }
  if (paragraphs.length === 0) {
    const t = container.textContent?.trim();
    if (t) paragraphs.push(t);
  }

  return paragraphs.join('\n\n');
}

function getMeta(doc: Document, property: string): string | null {
  const el = doc.querySelector(`meta[property="${property}"]`) as HTMLMetaElement | null;
  return el?.getAttribute('content')?.trim() || null;
}
