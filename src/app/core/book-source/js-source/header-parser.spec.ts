import { describe, it, expect } from 'vitest';
import { parseHeaderMeta } from './header-parser';
import { BookSourceMeta } from './source-meta.types';

const FIX = {
  fileName: 'demo.js',
  sourceDir: '/tmp/booksources',
  fileSize: 1024,
  modifiedAt: 1_700_000_000_000,
};

/** 拼接 header + body 字符串；header 每行都打 `//` 前缀 */
function src(lines: string[], body = 'export default {};'): string {
  return [...lines, '', body].join('\n');
}

describe('parseHeaderMeta / 标量字段', () => {
  it('解析所有已知 @key（11 个）', () => {
    const meta = parseHeaderMeta(
      src([
        '// @name 测试书源',
        '// @author 测试作者',
        '// @logo https://example.com/logo.png',
        '// @description 第一行描述',
        '// @url https://example.com/',
        '// @tags 玄幻,修真',
        '// @version 1.0.0',
        '// @updateUrl https://example.com/update.js',
        '// @uuid demo-uuid-001',
        '// @type novel',
        '// @enabled true',
        '// @minDelayMs 500',
        '// @require https://example.com/header.js',
      ]),
      FIX.fileName,
      FIX.sourceDir,
      FIX.fileSize,
      FIX.modifiedAt,
    );
    expect(meta.name).toBe('测试书源');
    expect(meta.author).toBe('测试作者');
    expect(meta.logo).toBe('https://example.com/logo.png');
    expect(meta.description).toBe('第一行描述');
    expect(meta.url).toBe('https://example.com/');
    expect(meta.urls).toEqual(['https://example.com/']);
    expect(meta.tags).toEqual(['玄幻', '修真']);
    expect(meta.version).toBe('1.0.0');
    expect(meta.updateUrl).toBe('https://example.com/update.js');
    expect(meta.uuid).toBe('demo-uuid-001');
    expect(meta.sourceType).toBe('novel');
    expect(meta.enabled).toBe(true);
    expect(meta.minDelayMs).toBe(500);
    expect(meta.requireUrls).toEqual(['https://example.com/header.js']);
  });

  it('@description 多条 → 换行拼接', () => {
    const meta = parseHeaderMeta(
      src(['// @description 第一段', '// @description 第二段', '// @description 第三段']),
      FIX.fileName, FIX.sourceDir, FIX.fileSize, FIX.modifiedAt,
    );
    expect(meta.description).toBe('第一段\n第二段\n第三段');
  });

  it('@description 含换行符原样保留', () => {
    const meta = parseHeaderMeta(
      src(['// @description 段落A\\n段落B']),
      FIX.fileName, FIX.sourceDir, FIX.fileSize, FIX.modifiedAt,
    );
    expect(meta.description).toBe('段落A\\n段落B');
  });

  it('@url 多条 → urls[] 按声明顺序，主 url 取首条', () => {
    const meta = parseHeaderMeta(
      src(['// @url https://a.example.com/', '// @url https://b.example.com/', '// @url https://c.example.com/']),
      FIX.fileName, FIX.sourceDir, FIX.fileSize, FIX.modifiedAt,
    );
    expect(meta.urls).toEqual([
      'https://a.example.com/',
      'https://b.example.com/',
      'https://c.example.com/',
    ]);
    expect(meta.url).toBe('https://a.example.com/');
  });

  it('@name 重复只取首条', () => {
    const meta = parseHeaderMeta(
      src(['// @name 第一名', '// @name 第二名']),
      FIX.fileName, FIX.sourceDir, FIX.fileSize, FIX.modifiedAt,
    );
    expect(meta.name).toBe('第一名');
  });
});

describe('parseHeaderMeta / 回退与默认', () => {
  it('缺 @uuid → 回退 fileName', () => {
    const meta = parseHeaderMeta(src([]), FIX.fileName, FIX.sourceDir, FIX.fileSize, FIX.modifiedAt);
    expect(meta.uuid).toBe('demo.js');
    expect(meta.sourceKey).toBe('demo.js');
  });

  it('缺 @name → 回退 fileName 去 .js 后缀', () => {
    const meta = parseHeaderMeta(src([]), FIX.fileName, FIX.sourceDir, FIX.fileSize, FIX.modifiedAt);
    expect(meta.name).toBe('demo');
  });

  it('缺 @enabled → 默认 true', () => {
    const meta = parseHeaderMeta(src([]), FIX.fileName, FIX.sourceDir, FIX.fileSize, FIX.modifiedAt);
    expect(meta.enabled).toBe(true);
  });

  it('@enabled false / 0 / no → 关闭', () => {
    for (const v of ['false', '0', 'no', 'FALSE']) {
      const meta = parseHeaderMeta(
        src([`// @enabled ${v}`]),
        FIX.fileName, FIX.sourceDir, FIX.fileSize, FIX.modifiedAt,
      );
      expect(meta.enabled).toBe(false);
    }
  });

  it('缺 @type → 默认 novel', () => {
    const meta = parseHeaderMeta(src([]), FIX.fileName, FIX.sourceDir, FIX.fileSize, FIX.modifiedAt);
    expect(meta.sourceType).toBe('novel');
  });

  it('@type 非法 → 降级 novel', () => {
    const meta = parseHeaderMeta(
      src(['// @type audiobook']),
      FIX.fileName, FIX.sourceDir, FIX.fileSize, FIX.modifiedAt,
    );
    expect(meta.sourceType).toBe('novel');
  });

  it('@type 5 种合法值全部通过', () => {
    for (const t of ['novel', 'comic', 'video', 'music', 'webpage']) {
      const meta = parseHeaderMeta(
        src([`// @type ${t}`]),
        FIX.fileName, FIX.sourceDir, FIX.fileSize, FIX.modifiedAt,
      );
      expect(meta.sourceType).toBe(t);
    }
  });
});

describe('parseHeaderMeta / tags 解析', () => {
  it('@tags 中英逗号混合拆分 + 去重保序', () => {
    const meta = parseHeaderMeta(
      src(['// @tags 玄幻，修幻,仙侠，修仙']),
      FIX.fileName, FIX.sourceDir, FIX.fileSize, FIX.modifiedAt,
    );
    expect(meta.tags).toEqual(['玄幻', '修幻', '仙侠', '修仙']);
  });

  it('@tags 大小写敏感（不同大小写视为不同）', () => {
    const meta = parseHeaderMeta(
      src(['// @tags Novel,novel,NOVEL']),
      FIX.fileName, FIX.sourceDir, FIX.fileSize, FIX.modifiedAt,
    );
    expect(meta.tags).toEqual(['Novel', 'novel', 'NOVEL']);
  });

  it('@tags 空段（连续逗号 / 首尾逗号）忽略', () => {
    const meta = parseHeaderMeta(
      src(['// @tags ,,玄幻,，修真,,']),
      FIX.fileName, FIX.sourceDir, FIX.fileSize, FIX.modifiedAt,
    );
    expect(meta.tags).toEqual(['玄幻', '修真']);
  });
});

describe('parseHeaderMeta / enabled 优先级（marker > 头部）', () => {
  it('marker 文件 false → 覆盖头部 @enabled true', () => {
    const meta = parseHeaderMeta(
      src(['// @enabled true']),
      FIX.fileName, FIX.sourceDir, FIX.fileSize, FIX.modifiedAt,
      false,
    );
    expect(meta.enabled).toBe(false);
  });

  it('marker 文件 true → 覆盖头部 @enabled false', () => {
    const meta = parseHeaderMeta(
      src(['// @enabled false']),
      FIX.fileName, FIX.sourceDir, FIX.fileSize, FIX.modifiedAt,
      true,
    );
    expect(meta.enabled).toBe(true);
  });

  it('marker 文件 null/undefined → 走头部 @enabled 或默认', () => {
    const meta1 = parseHeaderMeta(
      src(['// @enabled false']),
      FIX.fileName, FIX.sourceDir, FIX.fileSize, FIX.modifiedAt, null,
    );
    expect(meta1.enabled).toBe(false);
    const meta2 = parseHeaderMeta(
      src([]),
      FIX.fileName, FIX.sourceDir, FIX.fileSize, FIX.modifiedAt, undefined,
    );
    expect(meta2.enabled).toBe(true);
  });
});

describe('parseHeaderMeta / 边界行为', () => {
  it('@minDelayMs 与 @minDelay 等价', () => {
    const a = parseHeaderMeta(
      src(['// @minDelayMs 800']),
      FIX.fileName, FIX.sourceDir, FIX.fileSize, FIX.modifiedAt,
    );
    const b = parseHeaderMeta(
      src(['// @minDelay 800']),
      FIX.fileName, FIX.sourceDir, FIX.fileSize, FIX.modifiedAt,
    );
    expect(a.minDelayMs).toBe(800);
    expect(b.minDelayMs).toBe(800);
  });

  it('@minDelayMs 非法数字 → 保持默认值 0', () => {
    const meta = parseHeaderMeta(
      src(['// @minDelayMs notanumber']),
      FIX.fileName, FIX.sourceDir, FIX.fileSize, FIX.modifiedAt,
    );
    expect(meta.minDelayMs).toBe(0);
  });

  it('只扫前 100 行（101 行的 @name 被忽略）', () => {
    // 99 填充（index 0-98）+ @author（index 99，恰好在范围内）+ @name（index 100，超范围）
    const filler = Array.from({ length: 99 }, () => '// padding');
    const meta = parseHeaderMeta(
      src([...filler, '// @author 实际作者', '// @name 应被忽略']),
      FIX.fileName, FIX.sourceDir, FIX.fileSize, FIX.modifiedAt,
    );
    expect(meta.name).toBe(FIX.fileName.replace(/\.js$/, ''));
    expect(meta.author).toBe('实际作者');
  });

  it('未知 @key 忽略（不抛错）', () => {
    const meta = parseHeaderMeta(
      src(['// @unknownKey hello', '// @name OK']),
      FIX.fileName, FIX.sourceDir, FIX.fileSize, FIX.modifiedAt,
    );
    expect(meta.name).toBe('OK');
  });

  it('空内容 → 仅默认值（不抛错）', () => {
    const meta = parseHeaderMeta('', FIX.fileName, FIX.sourceDir, 0, 0);
    expect(meta.name).toBe('demo');
    expect(meta.uuid).toBe('demo.js');
    expect(meta.url).toBe('');
    expect(meta.urls).toEqual([]);
    expect(meta.tags).toEqual([]);
    expect(meta.requireUrls).toEqual([]);
    expect(meta.enabled).toBe(true);
    expect(meta.sourceType).toBe('novel');
    expect(meta.version).toBe('');
    expect(meta.minDelayMs).toBe(0);
  });

  it('@url 空值不入 urls[]，主 url 回退空字符串', () => {
    const meta = parseHeaderMeta(
      src(['// @url', '// @url https://a.example.com/']),
      FIX.fileName, FIX.sourceDir, FIX.fileSize, FIX.modifiedAt,
    );
    expect(meta.urls).toEqual(['https://a.example.com/']);
    expect(meta.url).toBe('https://a.example.com/');
  });
});

describe('parseHeaderMeta / 真实 legado 样本（11 个 @key）', () => {
  it('legacy 样本全字段对齐', () => {
    const meta: BookSourceMeta = parseHeaderMeta(
      src([
        '// @name 笔趣阁',
        '// @author 网友A',
        '// @logo https://www.example.com/logo.png',
        '// @description 经典玄幻小说站\\n支持多镜像',
        '// @url https://www.example.com/',
        '// @url https://backup.example.com/',
        '// @tags 玄幻,修真',
        '// @version 2.3.1',
        '// @updateUrl https://www.example.com/update.js',
        '// @uuid biquge-uuid-001',
        '// @type novel',
        '// @enabled true',
        '// @minDelayMs 500',
        '// @require https://www.example.com/header.js',
      ]),
      FIX.fileName,
      FIX.sourceDir,
      FIX.fileSize,
      FIX.modifiedAt,
    );
    expect(meta).toMatchObject({
      sourceKey: 'biquge-uuid-001',
      uuid: 'biquge-uuid-001',
      fileName: FIX.fileName,
      name: '笔趣阁',
      url: 'https://www.example.com/',
      urls: ['https://www.example.com/', 'https://backup.example.com/'],
      author: '网友A',
      logo: 'https://www.example.com/logo.png',
      description: '经典玄幻小说站\\n支持多镜像',
      enabled: true,
      fileSize: FIX.fileSize,
      modifiedAt: FIX.modifiedAt,
      sourceDir: FIX.sourceDir,
      sourceType: 'novel',
      version: '2.3.1',
      updateUrl: 'https://www.example.com/update.js',
      tags: ['玄幻', '修真'],
      minDelayMs: 500,
      requireUrls: ['https://www.example.com/header.js'],
    });
  });
});