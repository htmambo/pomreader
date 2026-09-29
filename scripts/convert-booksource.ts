#!/usr/bin/env node
/**
 * 原 .js 书源 → 新 JSON 规则（BookSourceDoc）离线转换。
 *
 * 用法：
 *   node scripts/convert-booksource.ts <输入...> [选项]
 *
 *   输入：一个或多个 .js 文件路径，或目录（取目录下一层全部 .js，按文件名排序）。
 *
 * 选项：
 *   --save             保存转换出的 .json（默认仅打印转换结果，不写盘）
 *   --out-dir <目录>   保存目标目录（缺省 = 各源文件同目录；仅在 --save 时生效）
 *   --enable           转换结果 enabled 置 true（缺省 false —— 人工转换先验证再启用，
 *                      与书源编辑器打开 .js 的口径一致；头注释 @enabled 不生效）
 *   --overwrite        目标 .json 已存在时覆盖（缺省跳过并告警）
 *   --compact          打印紧凑 JSON（默认 2 空格缩进）
 *   -h, --help         显示帮助
 *
 * 退出码：0 = 全部转换成功（skeleton 计成功）；1 = 存在 needs-manual / 读取失败 / 参数错误。
 *
 * ⚠️ 单一事实源：转换逻辑复用 electron/ipc/booksource-migrate.ts 的 convertJsContent
 * （启动迁移同款口径：parseHeaderMeta → 模板白名单判定 → 规则抽取 → 结构探针校验）。
 * 该文件的相对 import 无扩展名，Node type stripping 无法直接解析，故本脚本先用
 * esbuild（项目既有依赖）把它 bundle 成单个 .mjs 再 import —— 禁止把转换逻辑
 * 再抄一份进本脚本（仓内已有 rule-parse.ts ↔ booksource-migrate.ts 两份同步副本，
 * 不得出现第三份）。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as url from 'node:url';
import * as esbuild from 'esbuild';

interface ConvertedDoc {
  enabled: boolean;
  [key: string]: unknown;
}

interface JsConversion {
  outcome: 'ok' | 'skeleton' | 'needs-manual';
  uuid: string;
  jsonFileName: string;
  doc?: ConvertedDoc;
  reason?: string;
}

interface MigrateModule {
  convertJsContent(
    content: string,
    fileName: string,
    enabledOverride: boolean | null,
  ): JsConversion;
}

/** tmp + rename 原子写（与 electron/ipc/booksource-meta.ts atomicWrite 同手法，就地 8 行不值得再 bundle 一个模块） */
function atomicWriteFile(target: string, content: string): void {
  const tmp = `${target}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, content, 'utf-8');
    fs.renameSync(tmp, target);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* 清 tmp 失败忽略 */
    }
    throw e;
  }
}

const HELP = `用法：node scripts/convert-booksource.ts <输入...> [选项]
  输入：一个或多个 .js 文件路径，或目录（取目录下一层全部 .js）
  --save             保存转换出的 .json（默认仅打印结果）
  --out-dir <目录>   保存目标目录（缺省 = 源文件同目录）
  --enable           转换结果 enabled 置 true（缺省 false）
  --overwrite        目标 .json 已存在时覆盖
  --compact          打印紧凑 JSON
  -h, --help         显示帮助`;

function fail(message: string): never {
  console.error(`错误: ${message}`);
  process.exit(1);
}

/** 展开输入为去重后的 .js 绝对路径列表 */
function expandInputs(inputs: string[]): string[] {
  const files: string[] = [];
  const seen = new Set<string>();
  for (const input of inputs) {
    const abs = path.resolve(input);
    if (!fs.existsSync(abs)) fail(`输入不存在: ${input}`);
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) {
      const entries = fs
        .readdirSync(abs, { withFileTypes: true })
        .filter((e) => e.isFile() && path.extname(e.name).toLowerCase() === '.js')
        .map((e) => path.join(abs, e.name))
        .sort((a, b) => a.localeCompare(b));
      if (entries.length === 0) console.warn(`警告: 目录无 .js 书源: ${input}`);
      for (const f of entries) {
        if (!seen.has(f)) {
          seen.add(f);
          files.push(f);
        }
      }
    } else if (stat.isFile() && path.extname(abs).toLowerCase() === '.js') {
      if (!seen.has(abs)) {
        seen.add(abs);
        files.push(abs);
      }
    } else {
      fail(`输入不是 .js 文件或目录: ${input}`);
    }
  }
  return files;
}

/** esbuild bundle 迁移模块（绕过无扩展名相对 import），返回 convertJsContent */
async function loadMigrateModule(repoRoot: string): Promise<MigrateModule> {
  const entry = path.join(repoRoot, 'electron', 'ipc', 'booksource-migrate.ts');
  const outfile = path.join(os.tmpdir(), `pom-booksource-migrate-${process.pid}.mjs`);
  try {
    await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      platform: 'node',
      format: 'esm',
      outfile,
      logLevel: 'silent',
    });
  } catch (e) {
    fail(`esbuild bundle 迁移模块失败: ${(e as Error).message}`);
  }
  const mod = (await import(url.pathToFileURL(outfile).href)) as unknown as MigrateModule;
  if (typeof mod.convertJsContent !== 'function') {
    fail('迁移模块缺少 convertJsContent 导出（模块结构已变化？）');
  }
  return mod;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const inputs: string[] = [];
  let save = false;
  let outDir: string | null = null;
  let enable = false;
  let overwrite = false;
  let compact = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-h' || a === '--help') {
      console.log(HELP);
      return;
    } else if (a === '--save') {
      save = true;
    } else if (a === '--out-dir') {
      outDir = args[++i] ?? fail('--out-dir 缺目录参数');
    } else if (a === '--enable') {
      enable = true;
    } else if (a === '--overwrite') {
      overwrite = true;
    } else if (a === '--compact') {
      compact = true;
    } else if (a.startsWith('--')) {
      fail(`未知选项: ${a}\n${HELP}`);
    } else {
      inputs.push(a);
    }
  }
  if (inputs.length === 0) fail(`缺少输入\n${HELP}`);
  if (outDir && !save) console.warn('警告: --out-dir 仅在 --save 时生效');

  const files = expandInputs(inputs);
  if (files.length === 0) fail('没有可转换的 .js 书源');

  const repoRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
  const mod = await loadMigrateModule(repoRoot);

  let ok = 0;
  let skeleton = 0;
  let needsManual = 0;
  let saved = 0;
  let hasFailure = false;

  for (const jsPath of files) {
    const fileName = path.basename(jsPath);
    let content: string;
    try {
      content = fs.readFileSync(jsPath, 'utf-8');
    } catch (e) {
      console.error(`✗ ${fileName}  读取失败: ${(e as Error).message}`);
      needsManual++;
      hasFailure = true;
      continue;
    }

    // enabledOverride：缺省 false（人工转换先验证），--enable 置 true；头注释 @enabled 不生效
    const conv = mod.convertJsContent(content, fileName, enable);
    console.log(`\n═══ ${fileName} → ${conv.jsonFileName} ═══`);

    if (conv.outcome === 'needs-manual') {
      console.log(`✗ 需人工转换: ${conv.reason}`);
      needsManual++;
      hasFailure = true;
      continue;
    }

    const tag = conv.outcome === 'skeleton' ? 'skeleton（rules 占位，legadoRaw 已内嵌）' : 'ok';
    console.log(`✓ 转换成功 [${tag}]  uuid: ${conv.uuid}`);
    const json = JSON.stringify(conv.doc, null, compact ? 0 : 2);
    console.log(json);
    if (conv.outcome === 'skeleton') skeleton++;
    else ok++;

    if (!save) continue;
    const dir = outDir ? path.resolve(outDir) : path.dirname(jsPath);
    const target = path.join(dir, conv.jsonFileName);
    if (fs.existsSync(target) && !overwrite) {
      console.warn(`⚠ 目标已存在，跳过保存（--overwrite 覆盖）: ${target}`);
      continue;
    }
    try {
      fs.mkdirSync(dir, { recursive: true });
      atomicWriteFile(target, json + '\n');
      console.log(`→ 已保存: ${target}`);
      saved++;
    } catch (e) {
      console.error(`✗ 保存失败: ${target}: ${(e as Error).message}`);
      hasFailure = true;
    }
  }

  console.log(
    `\n── 合计 ${files.length} 个：成功 ${ok} + 骨架 ${skeleton}，需人工 ${needsManual}` +
      (save ? `，已保存 ${saved}` : '（未保存；加 --save 写盘）'),
  );
  if (hasFailure) process.exit(1);
}

void main();
