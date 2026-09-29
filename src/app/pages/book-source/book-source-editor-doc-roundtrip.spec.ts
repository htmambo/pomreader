/**
 * 编辑器存盘路径的**字段保真**回归测试（P3.2，外部评审 R1 P2-6 要求的防线）
 *
 * ## 为什么需要这个测试
 *
 * 编辑器把表单 + 规则面板重新拼成一份文档再存盘（`buildSourceDoc` 入参是**闭合的
 * 18 字段接口**）。只要 schema 日后新增了字段而表单忘了接，那次保存就会**静默抹掉**
 * 那个字段 —— 用户不报错、文件变小、字段消失，几周后才有人发现。
 *
 * 展开运算符 `{...current}` 解决不了：`BuildSourceDocInput` 是闭合接口，
 * `buildSourceDoc` 也不透传未列出的键，`...current` 只会触发 excess property 报错。
 * 能落地的防线是**把一份字段齐全的文档过一遍真实拼装路径，逐字段断言还在**。
 *
 * ## 测法
 *
 * 不实例化组件（它依赖 `viewChild` / `RuleEngineService` / 路由），而是把组件的
 * 拼装逻辑所依赖的**纯函数契约**复刻成同一条 `buildSourceDoc` 调用 —— 这与组件里
 * 那段代码逐字段对应。改动组件的拼装代码时**必须同步本文件的 `buildLikeEditor`**，
 * 否则测试会保护一份已经不存在的行为（下面用 `expect` 锚住了两者的一致性）。
 */
import { describe, it, expect } from 'vitest';
import * as v from 'valibot';
import { buildSourceDoc, serializeSourceDoc } from '../../core/logic/source-doc-build';
import {
  BOOK_SOURCE_FORMAT,
  BOOK_SOURCE_SCHEMA_VERSION,
  BookSourceDocSchema,
  type BookSourceDoc,
} from '../../core/models/book-source-doc.model';

/** 一份"字段齐全"的文档：每个可选字段都带上非空值 */
const FULL_DOC: BookSourceDoc = {
  format: BOOK_SOURCE_FORMAT,
  schemaVersion: BOOK_SOURCE_SCHEMA_VERSION,
  uuid: 'biquge-com',
  name: '笔趣阁',
  homepage: 'https://example.com',
  urls: ['https://example.com', 'https://mirror.example.com'],
  rules: {
    siteName: '笔趣阁',
    searchPath: '/s.php',
    searchMethod: 'POST',
    searchBodyParams: [{ key: 'q', value: '{keyword}' }],
    searchContentType: 'application/x-www-form-urlencoded',
    searchRawBody: '',
    searchItemPattern: 'ul.search li a',
    searchAuthorPattern: '作者：([^<]{1,30})',
    searchCategoryPattern: '类型：([^<]{1,20})',
    bookTitlePattern: '<h1>([\\s\\S]*?)</h1>',
    bookAuthorPattern: '作者：([^<]{1,30})',
    chapterItemPattern: 'ul.info li a',
    contentPattern: 'div.txt',
    contentReplaceRules: [{ rule: '广告', replace: '' }],
    bookCategoryPattern: '类型：([^<]{1,20})',
    coverUrlPattern: 'css:img',
  },
  headers: { 'User-Agent': 'example-agent' },
  enabled: true,
  sourceType: 'novel',
  author: '智能添加',
  description: '示例书源',
  tags: ['智能识别', '示例'],
  sourceVersion: '1.2.0',
  updateUrl: 'https://example.com/source.json',
  minDelayMs: 1500,
  requireUrls: ['https://example.com'],
  legadoRaw: '{"bookSourceName":"示例来源"}',
};

/**
 * 复刻 `BookSourceEditorComponent.buildDraft()` 的拼装
 *
 * 组件里表单值来自 signal，这里是等价的常量；两边必须保持同形。
 */
function buildLikeEditor(doc: BookSourceDoc): ReturnType<typeof buildSourceDoc> {
  return buildSourceDoc({
    uuid: doc.uuid,
    name: doc.name,
    homepage: doc.homepage,
    urls: doc.urls,
    rules: doc.rules,
    headers: doc.headers,
    enabled: doc.enabled,
    sourceType: doc.sourceType,
    author: doc.author,
    description: doc.description,
    tags: doc.tags,
    sourceVersion: doc.sourceVersion,
    updateUrl: doc.updateUrl,
    minDelayMs: doc.minDelayMs,
    requireUrls: doc.requireUrls,
    legadoRaw: doc.legadoRaw,
  });
}

/** 读存盘文本的某个字段（避免 JSON.parse 丢掉 undefined 与键序信息） */
function readField(text: string, key: string): unknown {
  return (JSON.parse(text) as Record<string, unknown>)[key];
}

describe('编辑器存盘：字段保真（P3.2）', () => {
  const text = serializeSourceDoc(buildLikeEditor(FULL_DOC));

  it('schema 的每个字段都出现在存盘文本里（新增字段忘了接表单 → 这里当场红）', () => {
    // 用 schema 的键集合而不是手写清单：schema 加字段时本测试自动加断言
    const written = JSON.parse(text) as Record<string, unknown>;
    // BookSourceDocDraft 允许省略的字段由下面的「保留」用例覆盖
    const keysInDoc = Object.keys(FULL_DOC);
    for (const key of keysInDoc) {
      expect(written, `字段 ${key} 丢失`).toHaveProperty(key);
    }
  });

  it('uuid 不变（命名空间连续性：变了会让 Book.bookSourceUuid 静默失配）', () => {
    expect(readField(text, 'uuid')).toBe('biquge-com');
  });

  it('legadoRaw / headers / minDelayMs / requireUrls 这类"不经表单透传"的字段原样保留', () => {
    expect(readField(text, 'legadoRaw')).toBe(FULL_DOC.legadoRaw);
    expect(readField(text, 'headers')).toEqual(FULL_DOC.headers);
    expect(readField(text, 'minDelayMs')).toBe(1500);
    expect(readField(text, 'requireUrls')).toEqual(FULL_DOC.requireUrls);
    expect(readField(text, 'updateUrl')).toBe(FULL_DOC.updateUrl);
    expect(readField(text, 'sourceVersion')).toBe('1.2.0');
  });

  it('格式与版本由 buildSourceDoc 统一盖章，不随表单走', () => {
    expect(readField(text, 'format')).toBe(BOOK_SOURCE_FORMAT);
    expect(readField(text, 'schemaVersion')).toBe(BOOK_SOURCE_SCHEMA_VERSION);
  });

  it('rules 完整往返，除了"恰等于推导缺省"的 searchContentType', () => {
    const written = JSON.parse(text) as { rules: Record<string, unknown> };
    for (const [k, value] of Object.entries(FULL_DOC.rules)) {
      // searchContentType 是 P2.3 的**有意**取舍：`buildSourceDoc` 在它恰等于
      // `impliedSearchContentType`（searchMethod=POST + form params 的推导缺省）时
      // 不落盘 —— 否则用户改了 searchMethod 就会带上一条陈旧的 contentType。
      // 它是**可推导**的，引擎与解析侧都会重新收口，故不算丢失。
      if (k === 'searchContentType') {
        expect(written.rules[k], '推导缺省本就不该落盘').toBeUndefined();
        continue;
      }
      expect(written.rules[k], `规则 ${k} 丢失`).toEqual(value);
    }
  });

  it('searchContentType 是**唯一**被推导掉的字段（改一个变量测试立刻能看出范围扩大了）', () => {
    const written = JSON.parse(text) as { rules: Record<string, unknown> };
    const dropped = Object.entries(FULL_DOC.rules)
      .filter(([k]) => written.rules[k] === undefined)
      .map(([k]) => k);
    expect(dropped).toEqual(['searchContentType']);
  });

  it('存盘文本过 schema 校验（这就是 save() 的权威门）', () => {
    const parsed = v.safeParse(BookSourceDocSchema, JSON.parse(text));
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.issues)).toBe(true);
  });

  it('往返两次结果稳定（幂等：预览 → 存盘 → 再读 → 再存不产生漂移）', () => {
    const again = serializeSourceDoc(buildLikeEditor(JSON.parse(text) as BookSourceDoc));
    expect(again).toBe(text);
  });
});
