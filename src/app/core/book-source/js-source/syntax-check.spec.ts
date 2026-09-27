import { describe, expect, it } from 'vitest';
import { checkSourceSyntax } from './syntax-check';
import { generateSourceCode } from '../smart-add/smart-rules';

describe('checkSourceSyntax', () => {
  it('合法源码返回 null', () => {
    expect(checkSourceSyntax('async function search(key) { return [] }')).toBeNull();
  });

  it('空串 / 纯注释也合法（沙箱可加载，只是无导出函数）', () => {
    expect(checkSourceSyntax('')).toBeNull();
    expect(checkSourceSyntax('// @name 测试')).toBeNull();
  });

  it('generateSourceCode 产物必须通过检查（模板与校验同源，防回归）', () => {
    const code = generateSourceCode('https://example.com', {
      siteName: 't',
      searchPath: '/s?q={keyword}',
      searchItemPattern: 'css:a',
      bookTitlePattern: 'css:h1',
      bookAuthorPattern: 'css:.a',
      chapterItemPattern: 'css:a',
      contentPattern: 'css:#c',
    });
    expect(checkSourceSyntax(code)).toBeNull();
  });

  it('语法错误返回错误描述（未闭合括号）', () => {
    const err = checkSourceSyntax('function search(key { return [] }');
    expect(err).not.toBeNull();
    expect(err!.length).toBeGreaterThan(0);
  });

  it('语法错误返回错误描述（未闭合字符串）', () => {
    expect(checkSourceSyntax('const A = "abc')).not.toBeNull();
  });

  it('检查只解析不执行 —— 源码副作用不会触发', () => {
    let called = false;
    (globalThis as Record<string, unknown>).__syntaxCheckProbe = () => {
      called = true;
    };
    expect(checkSourceSyntax('globalThis.__syntaxCheckProbe()')).toBeNull();
    expect(called).toBe(false);
    delete (globalThis as Record<string, unknown>).__syntaxCheckProbe;
  });

  it('顶层 return / 结尾无分号 与沙箱包装行为一致（不报语法错）', () => {
    expect(checkSourceSyntax('const A = 1')).toBeNull();
  });
});
