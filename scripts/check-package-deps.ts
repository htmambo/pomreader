#!/usr/bin/env node
/**
 * 打包产物依赖守卫（packaging dependency guard）
 *
 * 背景：
 *   package.json `build.files` 里有一份显式的 node_modules 排除清单
 *   （形如「否定模式 + node_modules + 包名」的排除规则）。electron-builder 对
 *   node_modules 走独立的 FileMatcher（getNodeModuleFileMatcher），
 *   只取 `files` 中的「否定模式」，且路径相对 app 根目录。
 *
 *   这份排除清单把 node_modules 从 145MB 压到 3.3MB —— 只留主进程真正
 *   require 的运行时闭包。风险是：**新增主进程运行时依赖若没同步进清单，
 *   会在打包后静默崩溃**（渲染端不受影响，因为渲染进程 nodeIntegration:false，
 *   渲染端依赖全部打进 bundle）。
 *
 * 本脚本做两件事：
 *   1. 从 dist-electron 下扫出所有 bare require()，算出运行时依赖闭包；
 *   2. 比对打包产物 app.asar 的 node_modules 内容，缺包 → 退出码 1（构建失败）。
 *
 * 用法：
 *   node scripts/check-package-deps.ts [asar路径]
 *   node scripts/check-package-deps.ts            # 自动在 release/** 下找 app.asar
 *
 * 退出码：0 = 全部齐备；1 = 有运行时依赖缺失（需把包加进 package.json build.files 的保留名单）
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';
import { execFileSync } from 'node:child_process';

const REPO_ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const DIST_ELECTRON = path.join(REPO_ROOT, 'dist-electron');

/** Node 内置模块 —— 不来自 node_modules，无需校验 */
const NODE_BUILTINS = new Set([
  'assert',
  'buffer',
  'child_process',
  'cluster',
  'console',
  'constants',
  'crypto',
  'dgram',
  'dns',
  'domain',
  'events',
  'fs',
  'http',
  'http2',
  'https',
  'inspector',
  'module',
  'net',
  'os',
  'path',
  'perf_hooks',
  'process',
  'punycode',
  'querystring',
  'readline',
  'repl',
  'stream',
  'string_decoder',
  'timers',
  'tls',
  'trace_events',
  'tty',
  'url',
  'util',
  'v8',
  'vm',
  'worker_threads',
  'zlib',
]);

/** 由 Electron 运行时提供（打包进 app 的 Electron 二进制里），不从 node_modules 解析。
 *  其 npm 包的依赖（@electron/get、progress、sumchecker…）同理无需进包。 */
const RUNTIME_PROVIDED = new Set(['electron']);

/** 递归收集目录下的 .js 文件
 *  跳过 *.spec.js —— 单测文件被 build.files 排除在包外（!dist-electron 下 spec 文件），
 *  其 require（如 vitest）不属于运行时依赖。 */
function collectJs(dir: string, acc: string[] = []): string[] {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectJs(full, acc);
    else if (entry.name.endsWith('.js') && !entry.name.endsWith('.spec.js')) acc.push(full);
  }
  return acc;
}

/** 扫出源码里的 bare require('pkg') —— 相对路径与 node: 前缀的忽略 */
function findBareRequires(files: string[]): Set<string> {
  const found = new Set<string>();
  const re = /require\(\s*["']([^"']+)["']\s*\)/g;
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const spec = m[1];
      if (spec.startsWith('.') || spec.startsWith('/')) continue;
      if (spec.startsWith('node:')) continue;
      if (NODE_BUILTINS.has(spec)) continue;
      if (RUNTIME_PROVIDED.has(spec)) continue;
      found.add(spec);
    }
  }
  return found;
}

/** 从 node_modules 求运行时依赖传递闭包 */
function resolveClosure(roots: Set<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [...roots];
  while (queue.length > 0) {
    const name = queue.shift() as string;
    if (seen.has(name)) continue;
    const pkgJson = path.join(REPO_ROOT, 'node_modules', name, 'package.json');
    if (!fs.existsSync(pkgJson)) {
      console.error(`✗ 本地 node_modules 中找不到 ${name}（无法解析传递依赖）`);
      continue;
    }
    seen.add(name);
    let json: { dependencies?: Record<string, string> };
    try {
      json = JSON.parse(fs.readFileSync(pkgJson, 'utf8'));
    } catch {
      continue;
    }
    for (const dep of Object.keys(json.dependencies ?? {})) {
      if (!seen.has(dep)) queue.push(dep);
    }
  }
  return seen;
}

/** 在 release/ 下递归查找 app.asar —— 取最近修改的一个（release/ 常有历史架构产物，
 *  按路径排序会选中与本次构建无关的旧产物） */
function findAsar(): string | null {
  const release = path.join(REPO_ROOT, 'release');
  if (!fs.existsSync(release)) return null;
  const hits: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 6) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.name === 'app.asar') hits.push(full);
    }
  };
  walk(release, 0);
  if (hits.length === 0) return null;
  return hits.sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs).pop() ?? null;
}

/** 列出 asar 内 node_modules 的包名（scope 展开为 @scope/name） */
function listAsarPackages(asarPath: string): Set<string> {
  let listing: string;
  try {
    listing = execFileSync('npx', ['--yes', '@electron/asar', 'list', asarPath], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    console.error('✗ 读取 asar 失败（需要 @electron/asar）：', (err as Error).message);
    process.exit(1);
  }
  const pkgs = new Set<string>();
  for (const line of listing.split('\n')) {
    const m = /^\/node_modules\/((?:@[^/]+\/)?[^/]+)\/package\.json$/.exec(line.trim());
    if (m) pkgs.add(m[1]);
  }
  return pkgs;
}

// ---------- 主流程 ----------

const asarArg = process.argv[2];
const asarPath = asarArg ? path.resolve(asarArg) : findAsar();
if (!asarPath || !fs.existsSync(asarPath)) {
  console.error('✗ 未找到 app.asar —— 先跑 `npm run dist`，或显式传入路径');
  process.exit(1);
}

const jsFiles = collectJs(DIST_ELECTRON);
if (jsFiles.length === 0) {
  console.error('✗ dist-electron 为空 —— 先跑 `npm run build:electron`');
  process.exit(1);
}

const bareRequires = findBareRequires(jsFiles);
const closure = resolveClosure(bareRequires);
const asarPkgs = listAsarPackages(asarPath);

console.log(`asar          : ${path.relative(REPO_ROOT, asarPath)}`);
console.log(`主进程直依赖 : ${[...bareRequires].sort().join(', ') || '(无)'}`);
console.log(`运行时闭包   : ${closure.size} 个包 → ${[...closure].sort().join(', ')}`);
console.log(`asar 内包数  : ${asarPkgs.size}`);
console.log('');

const missing = [...closure].filter((p) => !asarPkgs.has(p)).sort();
const asarSize = fs.statSync(asarPath).size;

if (missing.length > 0) {
  console.error(`✗ 打包产物缺少运行时依赖（${missing.length}）：`);
  for (const m of missing) {
    console.error(`    ${m}`);
  }
  console.error('');
  console.error('  处理：把上述包加进 package.json → build.files 的「保留」侧，');
  console.error('  或确认它们不需要（若主进程已不再 require）。');
  process.exit(1);
}

console.log(`✓ 运行时依赖齐备（${closure.size}/${closure.size}）`);
console.log(`✓ asar 体积 ${(asarSize / 1024 / 1024).toFixed(1)} MB`);
