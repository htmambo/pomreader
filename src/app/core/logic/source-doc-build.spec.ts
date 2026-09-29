/**
 * `buildSourceDoc` 单测（书源 JSON 规则化 P2.3）
 *
 * 重点钉两件容易做错、且做错后**不报错**的事：
 * ① 缺省**不能**在写盘时物化（否则用户改 `searchMethod` 会带着陈旧 contentType）；
 * ② 落盘格式必须与主进程逐字节一致（两边不能共享代码，只能互相用测试锁住）。
 */
import { describe, it, expect } from 'vitest';
import * as v from 'valibot';
import {
  buildSourceDoc,
  hostOf,
  isValidSourceDocFileName,
  serializeSourceDoc,
  sourceDocFileName,
} from './source-doc-build';
import {
  BookSourceDocSchema,
  BOOK_SOURCE_FORMAT,
  BOOK_SOURCE_SCHEMA_VERSION,
} from '../models/book-source-doc.model';
import {
  buildRules,
  impliedSearchContentType,
  resolveRuleDefaults,
  type SourceRules,
} from '../book-source/smart-add/smart-rules';

const RULES: SourceRules = {
  siteName: '示例站点',
  searchPath: '/s?q={keyword}',
  searchItemPattern: 'ul.list li',
  bookTitlePattern: 'h1',
  bookAuthorPattern: 'css:.author',
  chapterItemPattern: 'ul.c a',
  contentPattern: 'div#content',
};

function doc(overrides: Partial<Parameters<typeof buildSourceDoc>[0]> = {}) {
  return buildSourceDoc({
    uuid: 'uuid-1',
    name: '示例源',
    homepage: 'https://example.com',
    rules: RULES,
    ...overrides,
  });
}

describe('结构', () => {
  it('产物能过 BookSourceDocSchema（构造器产出即合法文档）', () => {
    expect(v.safeParse(BookSourceDocSchema, doc()).success).toBe(true);
  });

  it('format / schemaVersion 常量正确', () => {
    const d = doc();
    expect(d.format).toBe(BOOK_SOURCE_FORMAT);
    expect(d.schemaVersion).toBe(BOOK_SOURCE_SCHEMA_VERSION);
  });

  it('urls 缺省取 [homepage]（单站源不必显式写 urls）', () => {
    expect(doc().urls).toEqual(['https://example.com']);
  });

  it('显式 urls 原样保留（多镜像）', () => {
    expect(doc({ urls: ['https://a.test', 'https://b.test'] }).urls).toEqual([
      'https://a.test',
      'https://b.test',
    ]);
  });

  it('enabled 缺省 true，false 也照写', () => {
    expect(doc().enabled).toBe(true);
    expect(doc({ enabled: false }).enabled).toBe(false);
  });

  it('sourceType 缺省 novel', () => {
    expect(doc().sourceType).toBe('novel');
    expect(doc({ sourceType: 'comic' }).sourceType).toBe('comic');
  });
});

describe('空值处理：键缺席 ≠ 键存在且为空', () => {
  it('未提供的可选字段**不出现**在文档里（不是 null / 不是空数组）', () => {
    const d = doc();
    for (const key of ['author', 'description', 'tags', 'updateUrl', 'headers', 'legadoRaw']) {
      expect(key in d, `不该有键 ${key}`).toBe(false);
    }
  });

  it('空 tags / 空 headers 不写入', () => {
    const d = doc({ tags: [], headers: {} });
    expect('tags' in d).toBe(false);
    expect('headers' in d).toBe(false);
  });

  it('rules 里的 undefined 被剔除，**但空串保留**（空串 = 显式"不提取"）', () => {
    const d = doc({
      rules: { ...RULES, searchAuthorPattern: '', coverUrlPattern: undefined },
    });
    expect(d.rules.searchAuthorPattern).toBe('');
    expect('coverUrlPattern' in d.rules).toBe(false);
  });

  it('JSON 文本里不含 undefined 字面量（真会被 JSON.stringify 吞掉，故先剔除）', () => {
    const d = doc({ rules: { ...RULES, searchCategoryPattern: undefined } });
    expect(serializeSourceDoc(d)).not.toContain('undefined');
  });
});

describe('⚠️ 缺省不在写盘时物化', () => {
  it('searchContentType 未显式给出时**不写进文件**（条件缺省留给装载时按 method 推导）', () => {
    const d = doc();
    expect('searchContentType' in d.rules).toBe(false);
    expect(serializeSourceDoc(d)).not.toContain('searchContentType');
  });

  it('用户事后把 searchMethod 改成 POST_RAW，不会有陈旧的 form-urlencoded 跟着', () => {
    const raw = serializeSourceDoc(doc({ rules: { ...RULES, searchMethod: 'GET' } }));
    // 文件里没有 contentType → 装载时按 POST_RAW 推导成 application/json，而不是用陈旧值
    expect(raw).not.toContain('searchContentType');
    const edited = raw.replace('"searchMethod": "GET"', '"searchMethod": "POST_RAW"');
    expect(edited).not.toContain('searchContentType');
  });

  it('显式给了就照写（用户主动指定的不该被改）', () => {
    const d = doc({ rules: { ...RULES, searchContentType: 'text/plain' } });
    expect(d.rules.searchContentType).toBe('text/plain');
  });

  it('DEFAULT_PATTERNS 类缺省同样不物化（bookCategoryPattern / coverUrlPattern）', () => {
    const d = doc();
    expect('bookCategoryPattern' in d.rules).toBe(false);
    expect('coverUrlPattern' in d.rules).toBe(false);
  });
});

describe('落盘格式与主进程一致', () => {
  it('2 空格缩进 + 结尾换行（convert / toggle 用的就是这个格式）', () => {
    const text = serializeSourceDoc(doc());
    expect(text.startsWith('{\n  "format"')).toBe(true);
    expect(text.endsWith('\n')).toBe(true);
  });

  it('往返：parse 回来等于原对象（键序稳定、无信息丢失）', () => {
    const d = doc();
    expect(JSON.parse(serializeSourceDoc(d))).toEqual(d);
  });

  it('往返产物仍过 schema', () => {
    expect(v.safeParse(BookSourceDocSchema, JSON.parse(serializeSourceDoc(doc()))).success).toBe(
      true,
    );
  });
});

describe('文件命名', () => {
  it('host 去点 + .json（沿用既有 host 命名，只换后缀）', () => {
    expect(sourceDocFileName('https://www.hetushu.com/book/1')).toBe('hetushu_com.json');
  });

  it('hostOf 去 www.，非法 URL 返回空串而不是抛', () => {
    expect(hostOf('https://www.a.b.com/x')).toBe('a.b.com');
    expect(hostOf('不是 URL')).toBe('');
  });

  it('非法 URL 也能给出可用的兜底文件名', () => {
    expect(sourceDocFileName('不是 URL')).toBe('book_source.json');
  });

  it('合法性校验只认 .json', () => {
    expect(isValidSourceDocFileName('a_b-c.json')).toBe(true);
    expect(isValidSourceDocFileName('中文源.json')).toBe(true);
    expect(isValidSourceDocFileName('a.js')).toBe(false);
    expect(isValidSourceDocFileName('a.json.js')).toBe(false);
    expect(isValidSourceDocFileName('../evil.json')).toBe(false);
  });
});

describe('与智能添加探测结果直连（真实调用链的一段）', () => {
  it('buildRules 的产物能直接进 buildSourceDoc 并通过 schema', () => {
    const html = `<html><head><title>示例站</title></head><body>
      <h1>书名</h1><p>作者：小明</p>
      <ul class="chapter-list"><li><a href="/c/1">第一章</a></li></ul>
      <div id="content">正文</div></body></html>`;
    const rules = buildRules('https://example.com/book/1', html);
    const d = buildSourceDoc({ uuid: 'u', name: 'n', homepage: 'https://example.com', rules });
    expect(v.safeParse(BookSourceDocSchema, d).success).toBe(true);
  });
});

describe('⚠️ 与推导缺省相同时不写 searchContentType（拆掉"改 method 不改 contentType"的后门）', () => {
  it('探测器显式给的 form-urlencoded（GET 的缺省值）→ 不写', () => {
    const d = doc({ rules: { ...RULES, searchContentType: 'application/x-www-form-urlencoded' } });
    expect('searchContentType' in d.rules).toBe(false);
  });

  it('POST_RAW + json（该 method 的缺省值）→ 不写', () => {
    const d = doc({
      rules: { ...RULES, searchMethod: 'POST_RAW', searchContentType: 'application/json' },
    });
    expect('searchContentType' in d.rules).toBe(false);
  });

  it('**非**缺省值照写（用户特意指定的不能被吞）', () => {
    const d = doc({ rules: { ...RULES, searchMethod: 'GET', searchContentType: 'text/plain' } });
    expect(d.rules.searchContentType).toBe('text/plain');
  });

  it('POST_RAW + form（故意与缺省不同）→ 照写', () => {
    const d = doc({
      rules: {
        ...RULES,
        searchMethod: 'POST_RAW',
        searchContentType: 'application/x-www-form-urlencoded',
      },
    });
    expect(d.rules.searchContentType).toBe('application/x-www-form-urlencoded');
  });

  it('模拟探测器原样输入：写出来的文件里没有 contentType（G→POST_RAW 后不会带陈旧值）', () => {
    // `buildRules()` 的真实输出形态：GET + 显式 form-urlencoded
    const rules: SourceRules = {
      ...RULES,
      searchMethod: 'GET',
      searchContentType: 'application/x-www-form-urlencoded',
    };
    const raw = serializeSourceDoc(doc({ rules }));
    expect(raw).not.toContain('searchContentType');
  });
});

describe('文件名输出恒合法（外部评审 R1：IPv6 字面量的 hostname 会生成非法名）', () => {
  it('IPv6 字面量 URL → 非白名单字符被替换，产物仍过 isValidSourceDocFileName', () => {
    const name = sourceDocFileName('http://[::1]:8080/book/1');
    expect(isValidSourceDocFileName(name)).toBe(true);
  });

  it('带端口的普通 host 同样合法', () => {
    expect(isValidSourceDocFileName(sourceDocFileName('http://example.com:8080/x'))).toBe(true);
  });

  it('IDN / 中文域名 → 非法字符被换掉后仍合法', () => {
    expect(isValidSourceDocFileName(sourceDocFileName('https://例子.测试/x'))).toBe(true);
  });
});

describe('impliedSearchContentType 与引擎推导链同源（外部评审 R1：人工镜像会悄悄过期）', () => {
  it('两边对同一 method 推出同一个值（直接比对，不靠"我以为一致"）', () => {
    for (const method of [undefined, 'GET', 'POST', 'POST_RAW'] as const) {
      const rules = resolveRuleDefaults({ ...RULES, searchMethod: method });
      expect(impliedSearchContentType(method), method).toBe(rules.searchContentType);
    }
  });

  it('非法 method 也一致（两边都先 normalize）', () => {
    const bogus = 'PUT' as SourceRules['searchMethod'];
    expect(impliedSearchContentType(bogus)).toBe(
      resolveRuleDefaults({ ...RULES, searchMethod: bogus }).searchContentType,
    );
  });
});
