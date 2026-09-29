import { describe, it, expect } from 'vitest';
import {
  checkPureTemplate,
  detectSkeletonSource,
  migrateJsSource,
  normalizeLegacyMeta,
  type LegacyJsMeta,
} from './rule-migrate';
import { makeSampleJsSource } from '../book-source/json-rule/differential/legacy-runner';
import * as v from 'valibot';
import { BookSourceDocSchema } from '../models/book-source-doc.model';

/** 真实存量产物：1.1.0 模板，缺 SEARCH_AUTHOR_RULE / SEARCH_CATEGORY_RULE（本机书库形态） */
const LEGACY_110 = `// @name        笔趣阁
// @version     1.1.0
// @author      智能添加
// @url         https://example.com
// @enabled     true

const BASE_URL = "https://example.com"
const HEADERS = {}

// ── 规则(可视化编辑的值,直接改这里也生效) ──
const SEARCH_PATH = "/s.php"
const SEARCH_METHOD = "POST"
const SEARCH_BODY_PARAMS = [{"key":"type","value":"articlename"},{"key":"s","value":"{keyword}"}]
const SEARCH_CONTENT_TYPE = "application/x-www-form-urlencoded"
const SEARCH_RAW_BODY = ""
const SEARCH_ITEM_RULE = "ul.search li span.name a"
const BOOK_TITLE_RULE = "<h1[^>]*>([\\\\s\\\\S]*?)<\\\\/h1>"
const BOOK_AUTHOR_RULE = "作者[：:]\\\\s*([^<]{1,30})"
const CHAPTER_ITEM_RULE = "ul.info li a"
const CONTENT_RULE = "div.txt"
const CONTENT_REPLACE_RULES = [{"rule":"一秒记住","replace":""}]
const BOOK_CATEGORY_RULE = "类型[：:]\\\\s*([^<]{1,20})"
const COVER_RULE = "div.zhutu img"

function isCssRule(p) {
  p = String(p).trim()
  if (p.toLowerCase().startsWith('css:')) return true
  for (const ch of '\\\\(){}?|^$*+') if (p.indexOf(ch) !== -1) return false
  return true
}

function ruleSelector(p) {
  p = String(p).trim()
  return p.toLowerCase().startsWith('css:') ? p.slice(4).trim() : p
}

function stripTags(html) {
  return String(html || '').replace(/<[^>]+>/g, '').trim()
}

function absUrl(href, base) {
  try { return new URL(href, base).href } catch { return href || '' }
}

async function search(key, page) {
  const url = BASE_URL + SEARCH_PATH
  const html = await legado.http.get(url)
  return extractSearchItems(SEARCH_ITEM_RULE, html, BASE_URL)
}

function searchExtraRules() {
  return { author: SEARCH_AUTHOR_RULE || '', category: '' }
}

async function extractSearchItems(rule, html, baseUrl) {
  return extractLinks(rule, html, baseUrl)
}

async function extractLinks(rule, html, baseUrl) {
  const m = String(html).match(/<a[^>]+href="([^"]+)"/g) || []
  return m.map((x) => ({ url: absUrl(String(x), baseUrl) }))
}

function matchAll(re, html) {
  const out = []
  return out
}

async function extractText(rule, html, baseUrl) {
  return stripTags(html)
}

async function extractHtml(rule, html, baseUrl) {
  return html
}

async function extractAttr(rule, html, baseUrl, attr) {
  return []
}

function buildFormBody(params, keyword, page) {
  return ''
}

async function bookInfo(bookUrl) {
  return { title: '', author: '', chapters: [] }
}

async function chapterList(bookUrl) {
  return []
}

async function chapterContent(chapterUrl) {
  return ''
}
`;

/** 旧版 legado 骨架源（`legado-translator.makeSkeleton` 的真实形态） */
const LEGADO_JSON = JSON.stringify(
  {
    bookSourceName: '示例来源',
    bookSourceUrl: 'https://example.com',
    bookSourceGroup: '测试',
    enabled: true,
    header: '{"User-Agent":"example-agent"}',
    ruleSearch: { bookList: '<div class="book"><a href="{{url}}">{{name}}</a></div>' },
    ruleBookInfo: { name: '<h1>{{name}}</h1>', author: '<span>{{author}}</span>' },
    ruleToc: { chapterList: '<a href="{{url}}">{{name}}</a>' },
    ruleContent: { content: '<div id="content">{{content}}</div>' },
  },
  null,
  2,
);

const SKELETON_JS = `// @name        示例来源
// @version     1.0.0
// @author      legado-import
// @url         https://example.com
// @enabled     false
// @tags        legado-import
// @description 由 legado 订阅源导入

// 由 legado 订阅源导入（未能自动转换）。失败原因：
//   ruleContent.content 含 <js>/{{}}/$.jsonpath，非纯 CSS/regex，无法自动转换
//
// ── 原始 Legado JSON（参考用）───────────────────────────────────────────────
${LEGADO_JSON.split('\n')
  .map((l) => `// ${l}`)
  .join('\n')}
//
// ── 留空待用户手写：编辑此文件实现 search / bookInfo / chapterContent ──────────
//   参考：src/app/core/book-source/js-source/js-source.adapter.ts

async function search(keyword, page) {
  throw new Error('此源由 legado 导入，需手写 search() — ruleContent.content 含 <js>')
}

async function bookInfo(bookUrl) {
  throw new Error('此源由 legado 导入，需手写 bookInfo() — ruleContent.content 含 <js>')
}

async function chapterList(bookUrl) {
  throw new Error('此源由 legado 导入，需手写 chapterList() — ruleContent.content 含 <js>')
}

async function chapterContent(chapterUrl) {
  throw new Error('此源由 legado 导入，需手写 chapterContent() — ruleContent.content 含 <js>')
}
`;

function metaOf(over: Partial<LegacyJsMeta> = {}): LegacyJsMeta {
  return {
    fileName: 'example.js',
    uuid: 'example.js',
    name: '示例',
    url: 'https://example.com',
    urls: ['https://example.com'],
    author: '智能添加',
    logo: null,
    description: null,
    enabled: true,
    sourceType: 'novel',
    version: '1.1.0',
    updateUrl: null,
    tags: ['智能识别'],
    minDelayMs: 0,
    requireUrls: [],
    ...over,
  };
}

describe('checkPureTemplate — 手改检测', () => {
  it('真实生成模板（generateSourceCode 产物）判为纯模板', () => {
    const v = checkPureTemplate(makeSampleJsSource());
    expect(v.pure, v.reason ?? '').toBe(true);
  });

  it('1.1.0 存量形态判为纯模板', () => {
    const v = checkPureTemplate(LEGACY_110);
    expect(v.pure, v.reason ?? '').toBe(true);
  });

  it('正则字面量里的花括号不会打乱层级（/\\d{1,3}/ 后面跟顶层声明）', () => {
    const src = `${LEGACY_110}
const EXTRA = /\\d{1,3}/
function stillOk() { return 1 }
`;
    const v = checkPureTemplate(src);
    // EXTRA 不在白名单 → 判手改；但**理由必须是 EXTRA**，不能是"花括号不配对"之类被正则污染的结论
    expect(v.pure).toBe(false);
    expect(v.reason).toContain('EXTRA');
  });

  it('字符串 / 模板串里的花括号同样不参与配对', () => {
    const src = `${LEGACY_110}
const TEMPLATE_ONE = \`a } b { c \`
`;
    const v = checkPureTemplate(src);
    expect(v.pure).toBe(false);
    expect(v.reason).toContain('TEMPLATE_ONE');
  });

  it('模板外函数判手改', () => {
    const v = checkPureTemplate(`${LEGACY_110}\nfunction myHelper() { return 1 }\n`);
    expect(v.pure).toBe(false);
    expect(v.reason).toContain('模板外函数');
    expect(v.reason).toContain('myHelper');
  });

  it('模板外常量判手改（含 let/var —— 模板只用 const）', () => {
    expect(checkPureTemplate(`${LEGACY_110}\nconst MY_FLAG = 1\n`).reason).toContain('模板外常量');
    expect(checkPureTemplate(`${LEGACY_110}\nlet myFlag = 1\n`).pure).toBe(false);
    expect(checkPureTemplate(`${LEGACY_110}\nvar myFlag = 1\n`).pure).toBe(false);
  });

  it('顶层表达式语句判手改', () => {
    const v = checkPureTemplate(`${LEGACY_110}\nconsole.log('hi')\n`);
    expect(v.pure).toBe(false);
    expect(v.reason).toContain('非白名单语句');
  });

  it('顶层 export / import 判手改', () => {
    expect(checkPureTemplate(`${LEGACY_110}\nexport {}\n`).pure).toBe(false);
    expect(checkPureTemplate(`${LEGACY_110}\nimport x from 'y'\n`).pure).toBe(false);
  });

  it('被注释掉的代码判手改，而模板自己的小节注释不误伤', () => {
    const commented = checkPureTemplate(`${LEGACY_110}\n// const SEARCH_PATH = "/x"\n`);
    expect(commented.pure).toBe(false);
    expect(commented.reason).toContain('注释掉的代码');
    // 模板原样：正文里本来就有一堆散文注释，必须判纯
    expect(checkPureTemplate(LEGACY_110).pure).toBe(true);
  });

  it('多余的右花括号判手改', () => {
    expect(checkPureTemplate(`${LEGACY_110}\n}\n`).reason).toContain('多余的 }');
  });

  it('顶层箭头函数体闭合后**必须**回到语句起点（否则后面那条语句整条漏检）', () => {
    // SEARCH_RAW_BODY 是白名单常量，箭头体在深度 0 处闭合：
    // 若把 `=> {` 的 `{` 误判成对象字面量，闭合后 atStmtStart 不复位，
    // 紧随其后的 `function hidden()` 会被整段跳过 → 判成"纯模板"（漏检）。
    const src = `${LEGACY_110}
const SEARCH_RAW_BODY = x => { return x }
function hidden() { return 2 }
`;
    const v = checkPureTemplate(src);
    expect(v.pure).toBe(false);
    expect(v.reason).toContain('hidden');
  });
});

describe('detectSkeletonSource — legado 骨架源识别', () => {
  it('识别骨架源并还原内嵌 JSON', () => {
    const info = detectSkeletonSource(SKELETON_JS);
    expect(info).not.toBeNull();
    expect(info?.source?.bookSourceName).toBe('示例来源');
    expect(info?.raw).toContain('"bookSourceName": "示例来源"');
  });

  it('纯模板源不是骨架源（四个同名函数存在但没有落款 / 没有 throw）', () => {
    expect(detectSkeletonSource(LEGACY_110)).toBeNull();
  });

  it('只有部分 stub 抛错不算骨架源', () => {
    const partial = SKELETON_JS.replace(
      /async function chapterList[\s\S]*?\n}\n/,
      'async function chapterList(bookUrl) { return [] }\n',
    );
    expect(detectSkeletonSource(partial)).toBeNull();
  });

  it('内嵌 JSON 坏掉时仍识别为骨架，但 source 为 null', () => {
    const broken = SKELETON_JS.replace('"bookSourceName": "示例来源"', '"bookSourceName": ');
    const info = detectSkeletonSource(broken);
    expect(info).not.toBeNull();
    expect(info?.source).toBeNull();
    expect(info?.raw).toContain('"bookSourceName":');
  });
});

describe('migrateJsSource — 迁移判定', () => {
  it('纯模板源 → convert，文档过 schema，且 uuid 保持命名空间口径', () => {
    const r = migrateJsSource({
      fileName: 'example.js',
      content: LEGACY_110,
      meta: metaOf(),
      existingUuids: new Set(),
    });
    expect(r.outcome).toBe('convert');
    if (r.outcome !== 'convert') return;
    expect(r.isSkeleton).toBe(false);
    expect(r.item.jsonFileName).toBe('example.json');
    expect(r.doc.uuid).toBe('example.js');
    expect(r.doc.homepage).toBe('https://example.com');
    expect(r.doc.rules.searchPath).toBe('/s.php');
    expect(v.safeParse(BookSourceDocSchema, r.doc).success).toBe(true);
  });

  it('marker 的禁用状态落进文档 enabled（头里 @enabled true 也要被覆盖）', () => {
    const r = migrateJsSource({
      fileName: 'example.js',
      content: LEGACY_110,
      meta: metaOf({ enabled: false }),
      existingUuids: new Set(),
    });
    expect(r.outcome === 'convert' && r.doc.enabled).toBe(false);
  });

  it('BASE_URL 优先于 @url 头（用户改过 BASE_URL 的忠实还原）', () => {
    const src = LEGACY_110.replace(
      'const BASE_URL = "https://example.com"',
      'const BASE_URL = "https://mirror.example.com"',
    );
    const r = migrateJsSource({
      fileName: 'example.js',
      content: src,
      meta: metaOf({ urls: ['https://example.com'] }),
      existingUuids: new Set(),
    });
    expect(r.outcome === 'convert' && r.doc.homepage).toBe('https://mirror.example.com');
  });

  it('同 uuid 的 JSON 已存在 → skip，且不产文档', () => {
    const r = migrateJsSource({
      fileName: 'example.js',
      content: LEGACY_110,
      meta: metaOf(),
      existingUuids: new Set(['example.js']),
    });
    expect(r.outcome).toBe('skip');
    expect('doc' in r).toBe(false);
  });

  it('含模板外语句 → needs-manual，理由带出具体函数名', () => {
    const r = migrateJsSource({
      fileName: 'example.js',
      content: `${LEGACY_110}\nfunction hackIt() { return 1 }\n`,
      meta: metaOf(),
      existingUuids: new Set(),
    });
    expect(r.outcome).toBe('needs-manual');
    expect(r.item.reason).toContain('hackIt');
  });

  it('必填规则为空 → needs-manual，且列出全部空项', () => {
    const src = LEGACY_110.replace(
      'const SEARCH_PATH = "/s.php"',
      'const SEARCH_PATH = ""',
    ).replace('const CONTENT_RULE = "div.txt"', 'const CONTENT_RULE = ""');
    const r = migrateJsSource({
      fileName: 'example.js',
      content: src,
      meta: metaOf(),
      existingUuids: new Set(),
    });
    expect(r.outcome).toBe('needs-manual');
    expect(r.item.reason).toContain('searchPath');
    expect(r.item.reason).toContain('contentPattern');
  });

  it('既无 BASE_URL 又无 @url → needs-manual（不产空 homepage 的坏文档）', () => {
    const src = LEGACY_110.replace('const BASE_URL = "https://example.com"', 'const BASE_URL = ""');
    const r = migrateJsSource({
      fileName: 'example.js',
      content: src,
      meta: metaOf({ url: '', urls: [] }),
      existingUuids: new Set(),
    });
    expect(r.outcome).toBe('needs-manual');
    expect(r.item.reason).toContain('主站地址');
  });

  it('legado 骨架源 → convert + isSkeleton，产出 enabled:false + legadoRaw + needs-manual 标签', () => {
    const r = migrateJsSource({
      fileName: 'skeleton.js',
      content: SKELETON_JS,
      meta: metaOf({
        fileName: 'skeleton.js',
        uuid: 'skeleton.js',
        name: '示例来源',
        tags: ['legado-import'],
        enabled: false,
      }),
      existingUuids: new Set(),
    });
    expect(r.outcome).toBe('convert');
    if (r.outcome !== 'convert') return;
    expect(r.isSkeleton).toBe(true);
    expect(r.doc.enabled).toBe(false);
    expect(r.doc.legadoRaw).toContain('"bookSourceName": "示例来源"');
    expect(r.doc.tags).toContain('needs-manual');
    expect(v.safeParse(BookSourceDocSchema, r.doc).success).toBe(true);
  });

  it('骨架源内嵌 JSON 坏掉 → needs-manual', () => {
    const broken = SKELETON_JS.replace('"bookSourceName": "示例来源"', '"bookSourceName": ');
    const r = migrateJsSource({
      fileName: 'skeleton.js',
      content: broken,
      meta: metaOf({ fileName: 'skeleton.js', uuid: 'skeleton.js' }),
      existingUuids: new Set(),
    });
    expect(r.outcome).toBe('needs-manual');
    expect(r.item.reason).toContain('原始 JSON');
  });

  it('骨架源已带 needs-manual 标签时不重复追加', () => {
    const r = migrateJsSource({
      fileName: 'skeleton.js',
      content: SKELETON_JS,
      meta: metaOf({ fileName: 'skeleton.js', uuid: 'skeleton.js', tags: ['needs-manual'] }),
      existingUuids: new Set(),
    });
    expect(r.outcome === 'convert' && r.doc.tags).toEqual(['needs-manual']);
  });
});

describe('normalizeLegacyMeta — IPC 边界归一', () => {
  it('缺 uuid 时回退到带扩展名的文件名（命名空间口径，不得剥扩展名）', () => {
    const m = normalizeLegacyMeta({ fileName: 'foo.js' });
    expect(m.uuid).toBe('foo.js');
    expect(m.name).toBe('foo');
  });

  it('坏形状输入不抛：非对象 / 字段类型不对都退回缺省', () => {
    expect(normalizeLegacyMeta(null).uuid).toBe('');
    expect(normalizeLegacyMeta('nope').fileName).toBe('');
    const m = normalizeLegacyMeta({
      fileName: 'a.js',
      urls: 'not-array',
      tags: [1, 'ok', ''],
      minDelayMs: -5,
      sourceType: 'weird',
      enabled: false,
    });
    expect(m.urls).toEqual([]);
    expect(m.tags).toEqual(['ok']);
    expect(m.minDelayMs).toBe(0);
    expect(m.sourceType).toBe('novel');
    expect(m.enabled).toBe(false);
  });

  it('非空 minDelayMs 保留', () => {
    expect(normalizeLegacyMeta({ fileName: 'a.js', minDelayMs: 1500 }).minDelayMs).toBe(1500);
  });
});
