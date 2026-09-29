import { describe, it, expect } from 'vitest';
import { parseJsSource, extractJsConsts, extractHeaders } from './rule-parse';
import { DEFAULT_PATTERNS } from '../book-source/smart-add/smart-rules';

/**
 * 真实存量产物形态：@version 1.1.0，没有 SEARCH_AUTHOR_RULE / SEARCH_CATEGORY_RULE
 * （本机 ~/.config/pomreader/booksources 的实际书源就是这个形态）
 */
const LEGACY_V110 = `// @name        笔趣阁
// @version     1.1.0
// @author      智能添加
// @url         https://example.com
// @enabled     true

const BASE_URL = "https://example.com"
const HEADERS = {}

// ── 规则(可视化编辑的值,直接改这里也生效) ──
const REGEX_HINT_CHARS = '\\\\(){}?|^$*+'
const MAX_EXTRACT_LINKS = 500
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
`;

describe('parseJsSource — 存量 1.1.0 产物', () => {
  it('抽出全部既有规则，且标记出老模板天然缺失的两个常量', () => {
    const { rules, missingConsts, siteName, baseUrl } = parseJsSource(LEGACY_V110);
    expect(siteName).toBe('笔趣阁');
    expect(baseUrl).toBe('https://example.com');
    expect(rules.searchPath).toBe('/s.php');
    expect(rules.searchMethod).toBe('POST');
    expect(rules.searchItemPattern).toBe('ul.search li span.name a');
    expect(rules.coverUrlPattern).toBe('div.zhutu img');
    // 老模板**没有**这两个常量 —— 迁移必须按 '' 处理，不得因此判 needs-manual
    expect(rules.searchAuthorPattern).toBe('');
    expect(rules.searchCategoryPattern).toBe('');
    expect(missingConsts).toEqual(['SEARCH_AUTHOR_RULE', 'SEARCH_CATEGORY_RULE']);
  });

  it('常量值不会被下一行注释吞掉（HEADERS / COVER_RULE 各带一节注释）', () => {
    const { rules, headers } = parseJsSource(LEGACY_V110);
    expect(headers).toEqual({});
    expect(rules.coverUrlPattern).toBe('div.zhutu img');
    expect(rules.coverUrlPattern).not.toContain('//');
  });
});

describe('parseJsSource — 缺省值必须逐条对齐生成模板', () => {
  it('POST_RAW 的 searchContentType 缺省为 application/json', () => {
    const { rules } = parseJsSource('const SEARCH_METHOD = "POST_RAW"');
    expect(rules.searchMethod).toBe('POST_RAW');
    expect(rules.searchContentType).toBe('application/json');
  });

  it('GET / POST 缺省 form-urlencoded', () => {
    expect(parseJsSource('const SEARCH_METHOD = "GET"').rules.searchContentType).toBe(
      'application/x-www-form-urlencoded',
    );
    expect(parseJsSource('const SEARCH_METHOD = "POST"').rules.searchContentType).toBe(
      'application/x-www-form-urlencoded',
    );
  });

  it('非法 searchMethod 降级 GET，不抛', () => {
    const { rules } = parseJsSource('const SEARCH_METHOD = "FETCH"');
    expect(rules.searchMethod).toBe('GET');
  });

  it('显式写了的 searchContentType 优先于缺省', () => {
    const { rules } = parseJsSource(
      'const SEARCH_METHOD = "POST_RAW"\nconst SEARCH_CONTENT_TYPE = "text/plain"',
    );
    expect(rules.searchContentType).toBe('text/plain');
  });

  it('BOOK_CATEGORY_RULE / COVER_RULE 缺省走 DEFAULT_PATTERNS（编辑器留空是既有缺陷）', () => {
    const { rules } = parseJsSource('');
    expect(rules.bookCategoryPattern).toBe(DEFAULT_PATTERNS.bookCategoryPattern);
    expect(rules.coverUrlPattern).toBe(DEFAULT_PATTERNS.coverUrlPattern);
  });

  it('searchRawBody / searchAuthorPattern / searchCategoryPattern 缺省为空串', () => {
    const { rules } = parseJsSource('');
    expect(rules.searchRawBody).toBe('');
    expect(rules.searchAuthorPattern).toBe('');
    expect(rules.searchCategoryPattern).toBe('');
  });

  it('searchBodyParams / contentReplaceRules 缺省空数组', () => {
    const { rules } = parseJsSource('');
    expect(rules.searchBodyParams).toEqual([]);
    expect(rules.contentReplaceRules).toEqual([]);
  });
});

describe('parseJsSource — 历史元组形态升级', () => {
  it('SEARCH_BODY_PARAMS: [["k","v"]] → [{key,value}]', () => {
    const { rules } = parseJsSource(
      'const SEARCH_BODY_PARAMS = [["type","articlename"],["s","{keyword}"]]',
    );
    expect(rules.searchBodyParams).toEqual([
      { key: 'type', value: 'articlename' },
      { key: 's', value: '{keyword}' },
    ]);
  });

  it('CONTENT_REPLACE_RULES: [["正则","替换"]] → [{rule,replace}]', () => {
    const { rules } = parseJsSource('const CONTENT_REPLACE_RULES = [["广告","删除"]]');
    expect(rules.contentReplaceRules).toEqual([{ rule: '广告', replace: '删除' }]);
  });

  it('元组与对象形态混排都能收，元组元素不足 2 项被丢弃', () => {
    const { rules } = parseJsSource(
      'const SEARCH_BODY_PARAMS = [{"key":"a","value":"b"},["c","d"],["only"]]',
    );
    expect(rules.searchBodyParams).toEqual([
      { key: 'a', value: 'b' },
      { key: 'c', value: 'd' },
    ]);
  });

  it('常量写坏（非法 JSON）回退空数组，不抛 —— 单个常量坏不该让整个迁移失败', () => {
    const { rules } = parseJsSource('const SEARCH_BODY_PARAMS = {不是数组}');
    expect(rules.searchBodyParams).toEqual([]);
  });
});

describe('parseJsSource — HEADERS 提取（编辑器的反解析此前不含此项）', () => {
  it('legado 导入源的自定义请求头不丢', () => {
    const src = 'const HEADERS = {"User-Agent":"legado","Referer":"https://example.com/"}';
    expect(parseJsSource(src).headers).toEqual({
      'User-Agent': 'legado',
      Referer: 'https://example.com/',
    });
  });

  it('非对象 / 非法 JSON / 含非字符串值 → 只留字符串项，不抛', () => {
    expect(parseJsSource('const HEADERS = []').headers).toEqual({});
    expect(parseJsSource('const HEADERS = {oops').headers).toEqual({});
    expect(parseJsSource('const HEADERS = {"a":"1","n":5}').headers).toEqual({ a: '1' });
  });

  it('未声明 HEADERS 时为空对象', () => {
    expect(parseJsSource('').headers).toEqual({});
    expect(extractHeaders('')).toEqual({});
  });
});

describe('parseJsSource — 手写源的三种引号（外部评审 P1）', () => {
  it('单引号字面量解包正确 —— JSON.parse 只认双引号，早期版本会带着引号返回', () => {
    // 回归：`SEARCH_PATH = '/s.php'` 曾解析成 "'/s.php'"（带引号）→ 静默坏搜索路径
    expect(parseJsSource("const SEARCH_PATH = '/s.php'").rules.searchPath).toBe('/s.php');
    expect(parseJsSource("const CONTENT_RULE = 'div.txt'").rules.contentPattern).toBe('div.txt');
    expect(parseJsSource("const SEARCH_METHOD = 'POST'").rules.searchMethod).toBe('POST');
  });

  it('单引号内的两种转义（反斜杠引号 / 双反斜杠）被解开', () => {
    expect(parseJsSource(String.raw`const SEARCH_PATH = 'a\'b'`).rules.searchPath).toBe("a'b");
    expect(parseJsSource(String.raw`const SEARCH_PATH = 'a\\b'`).rules.searchPath).toBe('a\\b');
  });

  it('双引号与反引号仍走原路径', () => {
    expect(parseJsSource('const SEARCH_PATH = "/s.php"').rules.searchPath).toBe('/s.php');
    expect(parseJsSource('const SEARCH_PATH = `/s.php`').rules.searchPath).toBe('/s.php');
  });
});

describe('parseObjectArray — 对象形状校验（外部评审 P1）', () => {
  it('缺 key/value 的对象被丢弃，不冒充 SearchBodyParam', () => {
    // 回归：`{"k":1}` 曾被 `item as T` 直接放行，key/value 全 undefined
    const { rules } = parseJsSource('const SEARCH_BODY_PARAMS = [{"k":1},{"key":"a","value":"b"}]');
    expect(rules.searchBodyParams).toEqual([{ key: 'a', value: 'b' }]);
  });

  it('缺 rule/replace 的对象被丢弃', () => {
    const { rules } = parseJsSource(
      'const CONTENT_REPLACE_RULES = [{"r":"x"},{"rule":"a","replace":"b"}]',
    );
    expect(rules.contentReplaceRules).toEqual([{ rule: 'a', replace: 'b' }]);
  });

  it('非字符串的 key/value 也算不合格', () => {
    const { rules } = parseJsSource('const SEARCH_BODY_PARAMS = [{"key":1,"value":2}]');
    expect(rules.searchBodyParams).toEqual([]);
  });
});

describe('parseJsSource 的缺省收口（resolveRuleDefaults 的调用点）', () => {
  it('区分「常量缺席」与「声明了空串」', () => {
    // 缺席 → 走模板缺省
    expect(parseJsSource('const SEARCH_METHOD = "GET"').rules.searchContentType).toBe(
      'application/x-www-form-urlencoded',
    );
    // 显式空串 → 保留空串（与模板 `??` 一致）
    expect(parseJsSource('const SEARCH_CONTENT_TYPE = ""').rules.searchContentType).toBe('');
  });
});

describe('extractJsConsts — 跨行与模板字符串', () => {
  it('跨行数组整体取出，不被下一行 const 截断', () => {
    const src = `const A = [
  {"k":"1"},
  {"k":"2"}
]
const B = "b"`;
    const consts = extractJsConsts(src);
    expect(consts.A).toContain('{"k":"2"}');
    expect(consts.A).not.toContain('const B');
    expect(consts.B).toBe('"b"');
  });

  it('模板字符串里以 const 开头的内容行不被当成新声明', () => {
    const src = 'const NOTE = `line1\nconst fake = 1\nline3`\nconst REAL = "r"';
    const consts = extractJsConsts(src);
    expect(consts.NOTE).toContain('const fake = 1');
    expect(consts.REAL).toBe('"r"');
    expect(consts.fake).toBeUndefined();
  });
});
