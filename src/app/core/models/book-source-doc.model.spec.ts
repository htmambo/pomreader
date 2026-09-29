import { describe, it, expect } from 'vitest';
import * as v from 'valibot';
import {
  BookSourceDocSchema,
  BOOK_SOURCE_FORMAT,
  BOOK_SOURCE_SCHEMA_VERSION,
  type BookSourceDoc,
  type ParsedSourceRules,
} from './book-source-doc.model';
import {
  generateSourceCode,
  DEFAULT_PATTERNS,
  type SourceRules,
} from '../book-source/smart-add/smart-rules';
import { parseJsSource } from '../logic/rule-parse';

/** 一份覆盖全部字段的合法文档 */
function validDoc(overrides: Partial<BookSourceDoc> = {}): BookSourceDoc {
  return {
    format: BOOK_SOURCE_FORMAT,
    schemaVersion: BOOK_SOURCE_SCHEMA_VERSION,
    uuid: 'sample-a.js',
    name: '示例源',
    homepage: 'https://example.com',
    urls: ['https://example.com'],
    enabled: true,
    sourceType: 'novel',
    minDelayMs: 0,
    headers: {},
    rules: {
      siteName: '示例源',
      searchPath: '/s.php',
      searchItemPattern: 'ul.search li a',
      bookTitlePattern: '<h1[^>]*>([\\s\\S]*?)<\\/h1>',
      bookAuthorPattern: '作者[：:]\\s*([^<]{1,30})',
      chapterItemPattern: 'ul.info li a',
      contentPattern: 'div.txt',
    },
    ...overrides,
  };
}

describe('BookSourceDocSchema', () => {
  it('解析合法文档（含可选项缺省）', () => {
    const parsed = v.parse(BookSourceDocSchema, validDoc());
    expect(parsed.name).toBe('示例源');
    expect(parsed.tags).toEqual([]);
    expect(parsed.headers).toEqual({});
    expect(parsed.requireUrls).toEqual([]);
    // rules 里的可选项按 schema 缺省补齐
    expect(parsed.rules.searchAuthorPattern).toBe('');
    expect(parsed.rules.contentReplaceRules).toEqual([]);
  });

  it('searchMethod 可选且缺省 GET —— 存量 v1.1.0 产物没有这个常量，不得因此判非法', () => {
    // 刻意丢弃 searchMethod 来模拟"存量 v1.1.0 产物没有这个常量"；
    // 丢弃项按项目 no-unused-vars 约定改用 `_` 前缀
    const { searchMethod: _omitted, ...rules } = validDoc().rules;
    expect(
      v.parse(BookSourceDocSchema, validDoc({ rules: rules as SourceRules })).rules.searchMethod,
    ).toBe('GET');
    expect(v.parse(BookSourceDocSchema, validDoc()).rules.searchMethod).toBe('GET');
  });

  it('searchContentType 缺省**不填值**（缺省依赖 searchMethod，由 rule-parse 推导）', () => {
    const parsed = v.parse(BookSourceDocSchema, validDoc());
    // 若 schema 给 form-urlencoded 缺省，POST_RAW 源会在此处被静默定死
    expect(parsed.rules.searchContentType).toBeUndefined();
  });

  it('format / schemaVersion 用 literal —— 未来版本走「先按原始值分支再解析」', () => {
    expect(() => v.parse(BookSourceDocSchema, { ...validDoc(), schemaVersion: 2 })).toThrow();
    expect(() => v.parse(BookSourceDocSchema, { ...validDoc(), format: 'other' })).toThrow();
  });

  it('必填 7 项规则缺一即失败', () => {
    for (const key of [
      'siteName',
      'searchPath',
      'searchItemPattern',
      'bookTitlePattern',
      'bookAuthorPattern',
      'chapterItemPattern',
      'contentPattern',
    ] as const) {
      const rules: Record<string, unknown> = { ...validDoc().rules };
      delete rules[key];
      expect(
        () => v.parse(BookSourceDocSchema, validDoc({ rules: rules as SourceRules })),
        `缺 ${key} 应失败`,
      ).toThrow();
    }
  });

  it('sourceType 只接受 5 个合法值', () => {
    expect(() => v.parse(BookSourceDocSchema, { ...validDoc(), sourceType: 'podcast' })).toThrow();
    for (const t of ['novel', 'comic', 'video', 'music', 'webpage'] as const) {
      expect(v.parse(BookSourceDocSchema, { ...validDoc(), sourceType: t }).sourceType).toBe(t);
    }
  });

  it('minDelayMs 缺省 0（此前写成必填，与注释"默认 0"矛盾）', () => {
    const { minDelayMs: _omitted, ...rest } = validDoc();
    expect(v.parse(BookSourceDocSchema, rest as BookSourceDoc).minDelayMs).toBe(0);
    expect(v.parse(BookSourceDocSchema, validDoc({ minDelayMs: 500 })).minDelayMs).toBe(500);
  });

  it('bookCategoryPattern / coverUrlPattern 缺省取 DEFAULT_PATTERNS（与生成模板一致）', () => {
    // 缺省写 '' 会让「没填」与「显式留空=不提取」混淆
    const parsed = v.parse(BookSourceDocSchema, validDoc());
    expect(parsed.rules.bookCategoryPattern).toBe(DEFAULT_PATTERNS.bookCategoryPattern);
    expect(parsed.rules.coverUrlPattern).toBe(DEFAULT_PATTERNS.coverUrlPattern);
    // 显式留空是「不提取」，必须被保留
    const explicit = v.parse(
      BookSourceDocSchema,
      validDoc({ rules: { ...validDoc().rules, coverUrlPattern: '' } }),
    );
    expect(explicit.rules.coverUrlPattern).toBe('');
  });

  it('headers 严格校验字符串值 —— 非字符串视为文档损坏，直接判非法', () => {
    // 非字符串 header 的清洗发生在 rule-parse.extractHeaders（构造 doc 之前），
    // 到达 schema 这一层还带非字符串说明文档本身有问题，不该静默吞掉
    expect(() =>
      v.parse(BookSourceDocSchema, validDoc({ headers: { 'User-Agent': 'x', n: 1 as never } })),
    ).toThrow();
    expect(
      v.parse(BookSourceDocSchema, validDoc({ headers: { 'User-Agent': 'x' } })).headers,
    ).toEqual({ 'User-Agent': 'x' });
  });
});

describe('类型一致性（编译期 + 运行期）', () => {
  it('schema 推出的 rules 结构可赋给既有 SourceRules', () => {
    // 这一行是**编译期断言**：若两处字段漂移，TS 会在此报错
    const asSourceRules: SourceRules = v.parse(BookSourceDocSchema, validDoc()).rules;
    expect(asSourceRules.searchItemPattern).toBe('ul.search li a');
  });

  it('schema 推出的 rules 与 rule-parse 的产出结构兼容', () => {
    const parsed: ParsedSourceRules = v.parse(BookSourceDocSchema, validDoc()).rules;
    const fromJs = parseJsSource('const SEARCH_PATH = "/s.php"');
    expect(parsed.searchPath).toBe(fromJs.rules.searchPath);
  });
});

describe('往返：generateSourceCode → parseJsSource', () => {
  it('全字段往返后规则完全一致', () => {
    const rules: SourceRules = {
      siteName: '示例站点',
      searchPath: '/search?q={keyword}&p={page}',
      searchMethod: 'POST',
      searchBodyParams: [
        { key: 'type', value: 'articlename' },
        { key: 's', value: '{keyword}' },
      ],
      searchContentType: 'application/x-www-form-urlencoded',
      searchRawBody: '',
      searchItemPattern: 'ul.search li span.name a',
      searchAuthorPattern: 'css:.author',
      searchCategoryPattern: 'css:.kind',
      bookTitlePattern: '<h1[^>]*>([\\s\\S]*?)<\\/h1>',
      bookAuthorPattern: '作者[：:]\\s*([^<]{1,30})',
      chapterItemPattern: 'ul.info li a',
      contentPattern: 'div.txt',
      contentReplaceRules: [{ rule: '一秒记住', replace: '' }],
      bookCategoryPattern: '分类[：:]\\s*([^<]{1,20})',
      coverUrlPattern: 'div.zhutu img',
    };
    const code = generateSourceCode('https://example.com', rules);
    const back = parseJsSource(code).rules;
    expect(back).toEqual(rules);
  });

  it('HEADERS 往返 —— legado 导入源的自定义请求头不能丢', () => {
    const code = generateSourceCode(
      'https://example.com',
      {
        siteName: 'S',
        searchPath: '/s',
        searchItemPattern: 'a',
        bookTitlePattern: 'h1',
        bookAuthorPattern: 'a',
        chapterItemPattern: 'a',
        contentPattern: 'div',
      },
      { headers: { 'User-Agent': 'legado', Referer: 'https://example.com/' } },
    );
    const parsed = parseJsSource(code);
    expect(parsed.headers).toEqual({ 'User-Agent': 'legado', Referer: 'https://example.com/' });
    expect(parsed.baseUrl).toBe('https://example.com');
  });
});

/**
 * 必填 7 项的**非空**约束 —— 必须与主进程 `jsonEnvelopeError` 同判据
 *
 * ## 为什么单独钉
 *
 * 真实故障：编辑器存盘前用本 schema 校验，主进程用 `jsonEnvelopeError` 判「规则损坏」。
 * 两者曾对必填项一个放行 `''`、一个拒绝，于是编辑器把一份 7 项全空的文档写进了
 * `booksources/`，列表页立刻标红「规则损坏」——而编辑器那句「不合规不会写盘」是假的。
 *
 * ## 为什么两边各写一份清单（而不是共享一个常量）
 *
 * D4/D8：主进程**不能** import `src/`（`tsconfig.electron.json` 的 rootDir 锁死
 * `electron/` 且 `exclude: ["../src"]`，import 报 TS6059 且会就地输出污染 `src/`）；
 * 反向从 `src/` import `electron/` 同样越界（渲染端 bundle 不该含 fs/path/crypto）。
 * 故只能两边各钉一份，并用 `REQUIRED_RULE_KEYS` 的定义处互相注释引用 ——
 * 改一边必须同步另一边，改动会被下面两条测试各自顶红。
 */
const MANDATORY_RULE_KEYS = [
  'siteName',
  'searchPath',
  'searchItemPattern',
  'bookTitlePattern',
  'bookAuthorPattern',
  'chapterItemPattern',
  'contentPattern',
] as const;

describe('必填 7 项必须非空（与主进程 jsonEnvelopeError 对齐）', () => {
  it.each(MANDATORY_RULE_KEYS)(
    '%s = "" 必须判非法（否则会被写盘后立刻标成「规则损坏」）',
    (key) => {
      const base = validDoc();
      const doc = { ...base, rules: { ...base.rules, [key]: '' } };
      const parsed = v.safeParse(BookSourceDocSchema, doc);
      expect(parsed.success, `${key} 置空竟然通过了 schema`).toBe(false);
      // 报错要指向具体字段，而不是一个笼统的 "Invalid input"
      expect(JSON.stringify(parsed.issues ?? [])).toContain(key);
    },
  );

  it('7 项齐全的非空值必须通过 —— 收紧不能误杀合法源', () => {
    expect(v.safeParse(BookSourceDocSchema, validDoc()).success).toBe(true);
  });

  it('" "（仅空格）仍按主进程口径放行：信封只挡 ""，schema 不比它更严', () => {
    // 刻意不收紧到 trim：主进程用 `!(x as string)`，只挡空串。
    // schema 更松才会写出坏文档；更严只是多拒收，不安全但会与信封产生口径差。
    const base = validDoc();
    const doc = { ...base, rules: { ...base.rules, contentPattern: ' ' } };
    expect(v.safeParse(BookSourceDocSchema, doc).success).toBe(true);
  });
});
