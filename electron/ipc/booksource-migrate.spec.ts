import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  isPureTemplate,
  migrateBookSources,
  readMigrationReportOnce,
  registerBookSourceMigrationHandlers,
  scanLegacyDir,
  type MigrationReport,
} from './booksource-migrate';
import { scanJsonDir, validateBookSourceDocStructure } from './booksource-meta';

/**
 * booksource-migrate spec — 存量 JS 书源 → JSON 启动迁移（方案 §4.2 / §7.2）
 *
 * 迁移四态全覆盖：模板生成源（migrated）/ 含模板外语句的手写源（needs-manual）/
 * legado 骨架源（skeleton）/ 损坏源（必填常量为空 → needs-manual）。
 * 另覆盖：假阳性回归（模板版本漂移旧生成源必须判可迁移）、marker 连带搬迁/删除、
 * 幂等（二次运行无变化 + 同 uuid .json 跳过）、uuid 保持、searchContentType 按 method
 * 回填、旧元组升级、报告写目录外 + 读后删、3 个新 channel。
 */

const FIXTURES = path.join(process.cwd(), 'fixtures', 'booksources');

function readFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf-8');
}

/** legado 骨架源样本（镜像 legado-translator.ts 旧版 makeSkeleton 产物形态，F8） */
function makeSkeletonSource(): string {
  const raw = JSON.stringify(
    { bookSourceName: '骨架样本', bookSourceUrl: 'https://skeleton.invalid', ruleSearch: {} },
    null,
    2,
  );
  return [
    '// @name        骨架样本',
    '// @version     1.0.0',
    '// @author      legado-import',
    '// @url         https://skeleton.invalid',
    '// @enabled     false',
    '// @tags        legado-import',
    '// @uuid        sk-uuid-1',
    '// @type        novel',
    '// @description 由 legado 订阅源导入（未能自动转换）',
    '',
    '// 由 legado 订阅源导入（未能自动转换）。失败原因：',
    '//   ruleSearch.list 含 <js>/{{}}/$.jsonpath，非纯 CSS/regex，无法自动转换',
    '//',
    '// ── 原始 Legado JSON（参考用）───────────────────────────────────────────────',
    `// ${raw.split('\n').join('\n// ')}`,
    '//',
    '// ── 留空待用户手写：编辑此文件实现 search / bookInfo / chapterContent ──────────',
    '',
    'async function search(keyword, page) {',
    "  throw new Error('此源由 legado 导入，需手写 search() — ruleSearch 不可翻译')",
    '}',
    '',
    'async function bookInfo(bookUrl) {',
    "  throw new Error('此源由 legado 导入，需手写 bookInfo() — ruleSearch 不可翻译')",
    '}',
    '',
    'async function chapterList(bookUrl) {',
    "  throw new Error('此源由 legado 导入，需手写 chapterList() — ruleSearch 不可翻译')",
    '}',
    '',
    'async function chapterContent(chapterUrl) {',
    "  throw new Error('此源由 legado 导入，需手写 chapterContent() — ruleSearch 不可翻译')",
    '}',
    '',
  ].join('\n');
}

describe('isPureTemplate（结构白名单判定，方案 §4.2 D8）', () => {
  it('模板生成源（sample-regex.js）应判为纯模板', () => {
    expect(isPureTemplate(readFixture('sample-regex.js'))).toBe(true);
  });

  it('假阳性回归：模板版本漂移的旧生成源（@version 1.0.0 头）仍判可迁移', () => {
    // sample-regex.js 本体即漂移形态（缺 SEARCH_AUTHOR_RULE/SEARCH_CATEGORY_RULE 常量，
    // searchExtraRules 用 typeof 兜底）；再把头部版本改回 1.0.0 模拟更老产物
    const drifted = readFixture('sample-regex.js').replace(
      '// @version     1.2.0',
      '// @version     1.0.0',
    );
    // 断言常量声明确实缺席（须带 const 前缀：模板 searchExtraRules 里有 `SEARCH_AUTHOR_RULE ===` 兜底引用）
    expect(drifted).not.toContain('const SEARCH_AUTHOR_RULE =');
    expect(drifted).not.toContain('const SEARCH_CATEGORY_RULE =');
    expect(isPureTemplate(drifted)).toBe(true);
  });

  it('含模板外语句的手写源（sample-manual.js）应判为非纯模板', () => {
    expect(isPureTemplate(readFixture('sample-manual.js'))).toBe(false);
  });
});

describe('migrateBookSources（迁移四态，§7.2）', () => {
  let tmpUserData: string;
  let srcDir: string;
  let legacyDir: string;

  const writeSource = (fileName: string, content: string): void => {
    fs.writeFileSync(path.join(srcDir, fileName), content);
  };
  const readJson = (fileName: string): Record<string, any> =>
    JSON.parse(fs.readFileSync(path.join(srcDir, fileName), 'utf-8'));

  beforeEach(() => {
    tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'booksource-migrate-test-'));
    srcDir = path.join(tmpUserData, 'booksources');
    legacyDir = path.join(tmpUserData, 'booksources_legacy');
    fs.mkdirSync(srcDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpUserData, { recursive: true, force: true });
  });

  it('模板生成源 → migrated：产 .json、移 .js 入 legacy、doc 字段完整且过结构校验', () => {
    writeSource('sample-regex.js', readFixture('sample-regex.js'));

    const report = migrateBookSources(tmpUserData);
    expect(report.totals).toEqual({
      total: 1,
      migrated: 1,
      skeleton: 0,
      needsManual: 0,
      skipped: 0,
    });

    const doc = readJson('sample-regex.json');
    expect(doc.format).toBe('pomreader.booksource');
    expect(doc.schemaVersion).toBe(1);
    expect(doc.name).toBe('样本正则站');
    expect(doc.homepage).toBe('https://sample-regex.invalid');
    expect(doc.urls).toEqual(['https://sample-regex.invalid']);
    expect(doc.enabled).toBe(true);
    expect(doc.rules.searchItemPattern).toBe('<a href="(/book/\\d+)">([^<]+)</a>');
    expect(doc.rules.searchMethod).toBe('GET');
    expect(validateBookSourceDocStructure(doc)).toBeNull();

    // .js 移入 legacy；booksources/ 不再含 .js
    expect(fs.existsSync(path.join(srcDir, 'sample-regex.js'))).toBe(false);
    expect(fs.existsSync(path.join(legacyDir, 'sample-regex.js'))).toBe(true);
    // scanJsonDir 能扫到且不带 rulesInvalid
    const list = scanJsonDir(srcDir);
    expect(list).toHaveLength(1);
    expect(list[0].rulesInvalid).toBeUndefined();
  });

  it('手写源（含模板外语句）→ needs-manual：不产 JSON，.js + marker 连带搬入 legacy', () => {
    writeSource('sample-manual.js', readFixture('sample-manual.js'));
    fs.writeFileSync(path.join(srcDir, 'sample-manual.js.enabled'), '');

    const report = migrateBookSources(tmpUserData);
    expect(report.totals.needsManual).toBe(1);
    const entry = report.entries[0];
    expect(entry.outcome).toBe('needs-manual');
    expect(entry.reason).toContain('含模板外语句');

    expect(fs.existsSync(path.join(srcDir, 'sample-manual.json'))).toBe(false);
    expect(fs.existsSync(path.join(srcDir, 'sample-manual.js'))).toBe(false);
    expect(fs.existsSync(path.join(srcDir, 'sample-manual.js.enabled'))).toBe(false);
    expect(fs.existsSync(path.join(legacyDir, 'sample-manual.js'))).toBe(true);
    // marker 连带搬到 legacy 同名（foo.js.enabled），不留无主 marker
    expect(fs.existsSync(path.join(legacyDir, 'sample-manual.js.enabled'))).toBe(true);
  });

  it('legado 骨架源 → skeleton：enabled:false + legadoRaw + 占位 rules，过结构校验', () => {
    writeSource('sk.js', makeSkeletonSource());

    const report = migrateBookSources(tmpUserData);
    expect(report.totals).toEqual({
      total: 1,
      migrated: 0,
      skeleton: 1,
      needsManual: 0,
      skipped: 0,
    });

    const doc = readJson('sk.json');
    expect(doc.enabled).toBe(false);
    expect(doc.uuid).toBe('sk-uuid-1'); // 沿用头部 @uuid（D6）
    expect(doc.legadoRaw).toContain('"bookSourceName": "骨架样本"');
    expect(JSON.parse(doc.legadoRaw).bookSourceUrl).toBe('https://skeleton.invalid');
    expect(doc.rules.contentPattern).toBe('css:body'); // 无害占位
    expect(doc.description).toContain('骨架');
    expect(validateBookSourceDocStructure(doc)).toBeNull();
    expect(fs.existsSync(path.join(legacyDir, 'sk.js'))).toBe(true);
  });

  it('损坏源（必填常量 CONTENT_RULE 为空串）→ needs-manual', () => {
    const broken = readFixture('sample-regex.js').replace(
      /^const CONTENT_RULE = .*$/m,
      'const CONTENT_RULE = ""',
    );
    writeSource('broken.js', broken);

    const report = migrateBookSources(tmpUserData);
    expect(report.totals.needsManual).toBe(1);
    expect(report.entries[0].reason).toContain('必填规则');
    expect(fs.existsSync(path.join(srcDir, 'broken.json'))).toBe(false);
    expect(fs.existsSync(path.join(legacyDir, 'broken.js'))).toBe(true);
  });

  it('缺 @url 头（meta.urls 为空）→ needs-manual', () => {
    const noUrl = readFixture('sample-regex.js').replace(/^\/\/ @url .*$/m, '');
    writeSource('no-url.js', noUrl);

    const report = migrateBookSources(tmpUserData);
    expect(report.totals.needsManual).toBe(1);
    expect(report.entries[0].reason).toContain('meta.urls 为空');
  });

  it('成功路径：marker 覆盖并入 doc.enabled 后删除（不搬到 legacy）', () => {
    // @enabled true 头 + .disabled marker → marker 优先，enabled=false
    writeSource('marked.js', readFixture('sample-regex.js'));
    fs.writeFileSync(path.join(srcDir, 'marked.js.disabled'), '');

    const report = migrateBookSources(tmpUserData);
    expect(report.totals.migrated).toBe(1);
    const doc = readJson('marked.json');
    expect(doc.enabled).toBe(false);
    expect(fs.existsSync(path.join(srcDir, 'marked.js.disabled'))).toBe(false);
    expect(fs.existsSync(path.join(legacyDir, 'marked.js.disabled'))).toBe(false);
    expect(fs.existsSync(path.join(legacyDir, 'marked.js'))).toBe(true);
  });

  it('uuid 保持：有 @uuid 沿用；无 @uuid 回退带扩展名文件名（D6 硬验收前提）', () => {
    const withUuid = `// @uuid        my-custom-uuid\n${readFixture('sample-regex.js')}`;
    writeSource('with-uuid.js', withUuid);
    writeSource('sample-regex.js', readFixture('sample-regex.js')); // fixture 无 @uuid

    migrateBookSources(tmpUserData);
    expect(readJson('with-uuid.json').uuid).toBe('my-custom-uuid');
    // 回退为**带扩展名**的历史文件名（与 booksource-meta.ts:142 同构，不得剥 .js）
    expect(readJson('sample-regex.json').uuid).toBe('sample-regex.js');
  });

  it('searchContentType 缺省按 method 回填：POST_RAW → application/json，POST → form-urlencoded', () => {
    const base = readFixture('sample-post-raw.js');
    // 删掉 SEARCH_CONTENT_TYPE 常量行，验证按 method 回填（§4.2）
    const noCt = base.replace(/^const SEARCH_CONTENT_TYPE = .*$/m, '');
    writeSource('raw.js', noCt);
    const post = noCt.replace('const SEARCH_METHOD = "POST_RAW"', 'const SEARCH_METHOD = "POST"');
    writeSource('post.js', post);

    const report = migrateBookSources(tmpUserData);
    expect(report.totals.migrated).toBe(2);
    expect(readJson('raw.json').rules.searchContentType).toBe('application/json');
    expect(readJson('post.json').rules.searchContentType).toBe('application/x-www-form-urlencoded');
    // HEADERS 常量提取（F7）
    expect(readJson('raw.json').headers).toEqual({ 'X-Client': 'pomreader-diff-test' });
  });

  it('旧元组形态 SEARCH_BODY_PARAMS 升级为对象数组（F15）', () => {
    const tuple = readFixture('sample-regex.js').replace(
      'const SEARCH_BODY_PARAMS = []',
      'const SEARCH_BODY_PARAMS = [["q","{keyword}"],["p","{page}"]]',
    );
    writeSource('tuple.js', tuple);

    const report = migrateBookSources(tmpUserData);
    expect(report.totals.migrated).toBe(1);
    expect(readJson('tuple.json').rules.searchBodyParams).toEqual([
      { key: 'q', value: '{keyword}' },
      { key: 'p', value: '{page}' },
    ]);
  });

  it('幂等：二次运行不产生变化（已处理文件移出扫描集，自然幂等）', () => {
    writeSource('sample-regex.js', readFixture('sample-regex.js'));
    writeSource('sample-manual.js', readFixture('sample-manual.js'));
    const first = migrateBookSources(tmpUserData);
    expect(first.totals.total).toBe(2);

    const second = migrateBookSources(tmpUserData);
    expect(second.totals.total).toBe(0);
    // 目录内容不变（booksources/ 只剩 .json，legacy/ 两个 .js）
    expect(fs.readdirSync(srcDir)).toEqual(['sample-regex.json']);
    expect(fs.readdirSync(legacyDir).sort()).toEqual(['sample-manual.js', 'sample-regex.js']);
  });

  it('幂等：.json 已存在且 uuid 相同 → 跳过整个文件（不动 .js 也不覆盖 .json）', () => {
    writeSource('keep.js', readFixture('sample-regex.js'));
    // 预置同 uuid（keep.js 无 @uuid → 回退 'keep.js'）的 .json，带自定义标记
    fs.writeFileSync(
      path.join(srcDir, 'keep.json'),
      JSON.stringify({ format: 'pomreader.booksource', uuid: 'keep.js', custom: 'user-edited' }),
    );

    const report = migrateBookSources(tmpUserData);
    expect(report.totals).toEqual({
      total: 1,
      migrated: 0,
      skeleton: 0,
      needsManual: 0,
      skipped: 1,
    });
    // .js 不动、.json 不覆盖
    expect(fs.existsSync(path.join(srcDir, 'keep.js'))).toBe(true);
    expect(readJson('keep.json').custom).toBe('user-edited');
    expect(fs.existsSync(legacyDir)).toBe(false);
  });

  it('.json 已存在但 uuid 不一致 → needs-manual（保留现有 JSON，.js + marker 搬 legacy）', () => {
    writeSource('conflict.js', readFixture('sample-regex.js'));
    fs.writeFileSync(
      path.join(srcDir, 'conflict.json'),
      JSON.stringify({ format: 'pomreader.booksource', uuid: 'someone-else' }),
    );

    const report = migrateBookSources(tmpUserData);
    expect(report.totals.needsManual).toBe(1);
    expect(report.entries[0].reason).toContain('uuid 不一致');
    expect(readJson('conflict.json').uuid).toBe('someone-else'); // 未被覆盖
    expect(fs.existsSync(path.join(legacyDir, 'conflict.js'))).toBe(true);
  });

  it('报告写在 booksources/ 之外（不被 scanJsonDir 扫成幽灵源，R14），读后删', () => {
    writeSource('sample-regex.js', readFixture('sample-regex.js'));
    migrateBookSources(tmpUserData);

    const reportPath = path.join(tmpUserData, 'booksource-migration-report.json');
    expect(fs.existsSync(reportPath)).toBe(true);
    expect(fs.existsSync(path.join(srcDir, 'booksource-migration-report.json'))).toBe(false);
    // scanJsonDir 只见书源
    expect(scanJsonDir(srcDir).map((m) => m.fileName)).toEqual(['sample-regex.json']);

    const report = readMigrationReportOnce(tmpUserData);
    expect(report?.totals.migrated).toBe(1);
    expect(report?.entries[0].fileName).toBe('sample-regex.js');
    expect(fs.existsSync(reportPath)).toBe(false); // 读后删
    expect(readMigrationReportOnce(tmpUserData)).toBeNull(); // 无报告返回 null
  });

  it('无 .js 时不写报告（全新安装不产噪音）', () => {
    const report = migrateBookSources(tmpUserData);
    expect(report.totals.total).toBe(0);
    expect(fs.existsSync(path.join(tmpUserData, 'booksource-migration-report.json'))).toBe(false);
  });

  it('scanLegacyDir：enabled 由 marker 得出，needs-manual 条目带原因，已转换条目无 reason', () => {
    writeSource('sample-manual.js', readFixture('sample-manual.js'));
    fs.writeFileSync(path.join(srcDir, 'sample-manual.js.disabled'), '');
    writeSource('sample-regex.js', readFixture('sample-regex.js'));
    migrateBookSources(tmpUserData);

    const legacy = scanLegacyDir(tmpUserData);
    expect(legacy.map((l) => l.fileName).sort()).toEqual(['sample-manual.js', 'sample-regex.js']);
    const manual = legacy.find((l) => l.fileName === 'sample-manual.js')!;
    expect(manual.enabled).toBe(false); // legacy 内 .disabled marker
    expect(manual.reason).toContain('含模板外语句');
    const ok = legacy.find((l) => l.fileName === 'sample-regex.js')!;
    expect(ok.enabled).toBe(true); // 无 marker → 头部 @enabled true
    expect(ok.reason).toBeUndefined();
  });
});

describe('迁移 channel（§3.4 新增 3 个）', () => {
  type HandlerFn = (event: unknown, ...args: unknown[]) => unknown;

  let tmpUserData: string;
  let handlers: Map<string, HandlerFn>;

  const call = (channel: string, ...args: unknown[]): Promise<unknown> =>
    Promise.resolve(handlers.get(channel)!({}, ...args));

  beforeEach(() => {
    tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'booksource-migrate-ipc-test-'));
    fs.mkdirSync(path.join(tmpUserData, 'booksources'), { recursive: true });
    const map = new Map<string, HandlerFn>();
    registerBookSourceMigrationHandlers(
      { handle: (ch: string, fn: HandlerFn) => map.set(ch, fn) } as any,
      tmpUserData,
    );
    handlers = map;
  });

  afterEach(() => {
    fs.rmSync(tmpUserData, { recursive: true, force: true });
  });

  it('应注册 pom:booksource-convert / migration-report / legacy-list', () => {
    for (const ch of [
      'pom:booksource-convert',
      'pom:booksource-migration-report',
      'pom:booksource-legacy-list',
    ]) {
      expect(handlers.has(ch), ch).toBe(true);
    }
  });

  it('convert 手动重触发迁移并返回报告；migration-report 读后删；legacy-list 常驻扫描', async () => {
    fs.writeFileSync(
      path.join(tmpUserData, 'booksources', 'sample-manual.js'),
      readFixture('sample-manual.js'),
    );

    const report = (await call('pom:booksource-convert')) as MigrationReport;
    expect(report.totals.needsManual).toBe(1);
    expect(report.legacyDir).toBe(path.join(tmpUserData, 'booksources_legacy'));

    // 报告已由 convert 直接返回；migration-report 读文件版（读后删）
    const once = (await call('pom:booksource-migration-report')) as MigrationReport | null;
    expect(once?.totals.needsManual).toBe(1);
    expect(await call('pom:booksource-migration-report')).toBeNull();

    const legacy = (await call('pom:booksource-legacy-list')) as {
      fileName: string;
      enabled: boolean;
      reason?: string;
    }[];
    expect(legacy).toHaveLength(1);
    expect(legacy[0].fileName).toBe('sample-manual.js');
    expect(legacy[0].reason).toContain('含模板外语句');
  });
});
