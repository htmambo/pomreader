/**
 * 智能添加页的"新建源产出"单测（书源 JSON 规则化 P2.3）
 *
 * 验收口径是 **"新建源全程不产生 `.js`"**，所以这里覆盖的是产出链的三件事：
 * 文件名后缀、文本是 JSON、落盘前有 schema 校验（用户在 textarea 里手改过也可能非法）。
 *
 * 组件本身依赖 `viewChild(RulesPanelComponent)` + `PageFetcherService`，起完整 TestBed
 * 成本高且脆弱；这里直接驱动被测的两个纯环节（规则集 → 文档文本；文本 → 校验），
 * 与组件里 `buildDocText()` / `save()` 用的是同一组函数。
 */
import { describe, it, expect } from 'vitest';
import * as v from 'valibot';
import {
  buildSourceDoc,
  isValidSourceDocFileName,
  serializeSourceDoc,
  sourceDocFileName,
} from '../../core/logic/source-doc-build';
import { BookSourceDocSchema } from '../../core/models/book-source-doc.model';
import { buildRules } from '../../core/book-source/smart-add/smart-rules';

const HTML = `<html><head><title>示例站</title></head><body>
  <h1>书名</h1><p>作者：小明</p>
  <ul class="chapter-list"><li><a href="/c/1">第一章</a></li></ul>
  <div id="content">正文内容</div></body></html>`;

const URL_ = 'https://www.hetushu.com/book/5763';

function buildDocText(fileName: string, url: string): string {
  return serializeSourceDoc(
    buildSourceDoc({
      uuid: fileName,
      name: buildRules(url, HTML).siteName,
      homepage: new URL(url).origin,
      rules: buildRules(url, HTML),
    }),
  );
}

describe('新建源的文件名', () => {
  it('后缀是 .json（不再是 .js —— 这是 P2.3 的核心验收项）', () => {
    expect(sourceDocFileName(URL_)).toBe('hetushu_com.json');
    expect(sourceDocFileName(URL_).endsWith('.json')).toBe(true);
  });

  it('host 命名形态与旧 .js 保持一致（只换后缀，书架里看起来仍是同一个源）', () => {
    const old = 'hetushu_com.js';
    expect(sourceDocFileName(URL_)).toBe(old.replace(/\.js$/, '.json'));
  });

  it('文件名校验只认 .json', () => {
    expect(isValidSourceDocFileName(sourceDocFileName(URL_))).toBe(true);
    expect(isValidSourceDocFileName('hetushu_com.js')).toBe(false);
  });
});

describe('新建源的文本是 JSON 文档', () => {
  it('可被 JSON.parse 且过 schema', () => {
    const text = buildDocText('hetushu_com.json', URL_);
    const parsed = JSON.parse(text);
    expect(v.safeParse(BookSourceDocSchema, parsed).success).toBe(true);
  });

  it('不是 JS：不含 function / const 之类模板痕迹', () => {
    const text = buildDocText('hetushu_com.json', URL_);
    expect(text).not.toMatch(/async function/);
    expect(text).not.toMatch(/^const /m);
  });

  it('uuid 取带扩展名的文件名（与存量无 @uuid 源的命名空间同构）', () => {
    const parsed = JSON.parse(buildDocText('hetushu_com.json', URL_));
    expect(parsed.uuid).toBe('hetushu_com.json');
  });

  it('homepage 是 origin（不带路径）', () => {
    const parsed = JSON.parse(buildDocText('hetushu_com.json', URL_));
    expect(parsed.homepage).toBe('https://www.hetushu.com');
  });
});

describe('落盘前的 schema 校验（用户可在 textarea 手改 JSON）', () => {
  /** 与组件 `save()` 相同的校验步骤 */
  function validate(text: string): { ok: true } | { ok: false; message: string } {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
    const checked = v.safeParse(BookSourceDocSchema, parsed);
    return checked.success ? { ok: true } : { ok: false, message: checked.issues[0].message };
  }

  it('合法文本通过', () => {
    expect(validate(buildDocText('a.json', URL_)).ok).toBe(true);
  });

  it('用户手改成坏 JSON → 被拦下（不落盘）', () => {
    const r = validate('{ "format": "pomreader.booksource", ');
    expect(r.ok).toBe(false);
  });

  it('用户删掉必需规则 → 被拦下', () => {
    const parsed = JSON.parse(buildDocText('a.json', URL_));
    delete parsed.rules.chapterItemPattern;
    expect(validate(JSON.stringify(parsed)).ok).toBe(false);
  });

  it('用户改错 format → 被拦下（不会被写成打不开的源）', () => {
    const parsed = JSON.parse(buildDocText('a.json', URL_));
    parsed.format = 'legado';
    expect(validate(JSON.stringify(parsed)).ok).toBe(false);
  });

  it('用户改错 searchMethod → 被拦下（枚举外的值不静默接受）', () => {
    const parsed = JSON.parse(buildDocText('a.json', URL_));
    parsed.rules.searchMethod = 'PUT';
    expect(validate(JSON.stringify(parsed)).ok).toBe(false);
  });

  it('用户把 searchMethod 改成 POST_RAW 且不动 contentType → 仍合法（缺省在装载时推导）', () => {
    const parsed = JSON.parse(buildDocText('a.json', URL_));
    parsed.rules.searchMethod = 'POST_RAW';
    expect(validate(JSON.stringify(parsed)).ok).toBe(true);
    expect('searchContentType' in parsed.rules).toBe(false);
  });
});
