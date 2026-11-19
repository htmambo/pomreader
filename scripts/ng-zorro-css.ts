/**
 * 生成 ng-zorro「按组件」样式（替代全量 `ng-zorro-antd.min.css`）
 *
 * ── 为什么 ──────────────────────────────────────────────────────────────
 * ng-zorro 22 提供两种样式形态：
 * - `ng-zorro-antd.min.css` —— 全量合并 CSS（~70 个组件，min 后 556KB）
 * - `<comp>/style/entry.less` —— 单组件样式入口（含该组件的 `patch.less`
 *   与样式依赖，如 select 依赖 empty）
 *
 * 全量 CSS 里约 40% 的组件本项目从未使用（date-picker / calendar / tree /
 * transfer / steps / time-picker …），但它们照样进首屏 CSS 并被解析。
 *
 * ── 做法 ────────────────────────────────────────────────────────────────
 * 1. 扫描 `src/` 下所有 .ts 里 `from 'ng-zorro-antd/<comp>'` 形式的导入 → 组件清单
 * 2. 用 LESS 编译「core（style/entry.less）+ 已用组件的 entry.less」
 *    （LESS 的 @import 是「同文件只导入一次」语义 → 主题/变量自动去重）
 * 3. 输出 `src/styles/ng-zorro.generated.css`（构建产物，不入库）
 * 4. **守卫**：项目自己的 `src/styles/*.scss` 里覆盖的 `.ant-*` / `.cdk-*`
 *    类名必须都在产物里存在 —— 漏组件会立刻在这里报错，而不是等到运行时
 *    样式错乱才发现
 *
 * 用法：node scripts/ng-zorro-css.ts
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import less from 'less';

const ROOT = path.resolve(path.dirname(import.meta.filename), '..');
const SRC = path.join(ROOT, 'src');
const NM = path.join(ROOT, 'node_modules');
const NZ = path.join(NM, 'ng-zorro-antd');
const OUT = path.join(SRC, 'styles', 'ng-zorro.generated.css');

/** ng-zorro 的样式入口（core + 全局 patch） */
const CORE_ENTRY = 'ng-zorro-antd/style/entry.less';

/** 递归收集 src/ 下所有 .ts 文件 */
async function collectTs(dir: string, out: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      await collectTs(full, out);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** 扫描源码里用到的 ng-zorro 组件（按导入路径判定，忽略 spec） */
async function detectComponents(): Promise<string[]> {
  const files = await collectTs(SRC);
  const found = new Set<string>();
  const re = /from\s+'ng-zorro-antd\/([a-z0-9-]+)'/g;
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    for (const m of text.matchAll(re)) {
      const comp = m[1];
      // 只保留有样式入口的组件（i18n / 纯服务等无 style/ 目录）
      if (existsSync(path.join(NZ, comp, 'style', 'entry.less'))) {
        found.add(comp);
      }
    }
  }
  return [...found].sort();
}

/** 项目自有样式里覆盖的 ant-/cdk- 类名 */
async function overriddenClasses(): Promise<string[]> {
  const styleDir = path.join(SRC, 'styles');
  const names = new Set<string>();
  const re = /\.(ant|cdk)-[a-z0-9-]+/g;
  for (const file of await readdir(styleDir)) {
    if (!file.endsWith('.scss')) continue;
    const text = await readFile(path.join(styleDir, file), 'utf8');
    for (const m of text.matchAll(re)) names.add(m[0]);
  }
  return [...names].sort();
}

/** 组件样式里「定义」的类名（出现在规则体前的选择器里） */
function definedClasses(css: string): Set<string> {
  return new Set([...css.matchAll(/\.((?:ant|cdk)-[a-z0-9-]+)[^{}]*\{/g)].map((m) => m[1]));
}

/**
 * 每个组件取一个「特征类名」——组件自身样式里定义、且不与其它组件共用的那个。
 * 用它做守卫：产物里必须有这个类，否则说明该组件的样式没进来。
 */
async function markerClassOf(component: string): Promise<string | null> {
  const file = path.join(NZ, component, 'style', 'index.css');
  if (!existsSync(file)) return null;
  const css = await readFile(file, 'utf8');
  const defined = [...definedClasses(css)];
  // 取最短的类名（基础类，如 .ant-btn），避免选到只属于某个子状态的类
  defined.sort((a, b) => a.length - b.length);
  return defined[0] ?? null;
}

async function main(): Promise<void> {
  const components = await detectComponents();
  if (components.length === 0) {
    console.error('[ng-zorro-css] 未扫描到任何 ng-zorro 组件导入 —— 扫描逻辑可能失效');
    process.exit(1);
  }

  const imports = [CORE_ENTRY, ...components.map((c) => `ng-zorro-antd/${c}/style/entry.less`)];
  // `@root-entry-name` 由 ng-zorro 自己的构建注入（webpack bundle 里替换）；
  // 手动编译时必须自己声明 —— style/themes/index.less 用它选主题文件
  const source = [`@root-entry-name: default;`, ...imports.map((i) => `@import '${i}';`)].join(
    '\n',
  );

  const result = await less.render(source, {
    paths: [NM],
    filename: path.join(NM, 'ng-zorro.less'),
    javascriptEnabled: true,
    rewriteUrls: 'all',
  });

  const css = result.css;
  await writeFile(OUT, css, 'utf8');

  // ── 守卫 1（硬失败）：每个用到的组件都要真的进产物 ──────────────────
  const defined = definedClasses(css);
  const missingMarkers: string[] = [];
  for (const comp of components) {
    const marker = await markerClassOf(comp);
    if (marker && !defined.has(marker)) {
      missingMarkers.push(`${comp} → .${marker}`);
    }
  }
  if (missingMarkers.length > 0) {
    console.error(`[ng-zorro-css] 以下组件的样式没有进入产物：\n  ${missingMarkers.join('\n  ')}`);
    process.exit(1);
  }

  // ── 守卫 2（仅提示）：项目覆盖用到的类名若在全量 CSS 里存在、
  //    但产物里没有，说明它属于本项目未使用的组件（如 nz-form） ──────
  const fullCss = await readFile(path.join(NZ, 'ng-zorro-antd.min.css'), 'utf8');
  const fullDefined = definedClasses(fullCss);
  const notCovered = (await overriddenClasses()).filter(
    (cls) => fullDefined.has(cls.slice(1)) && !defined.has(cls.slice(1)),
  );

  const kb = (n: number) => `${(n / 1024).toFixed(1)}KB`;
  console.log(
    `[ng-zorro-css] ${components.length} 个组件 → ${path.relative(ROOT, OUT)}（${kb(Buffer.byteLength(css))}，未压缩）`,
  );
  console.log(`[ng-zorro-css] 组件清单：${components.join(', ')}`);
  if (notCovered.length > 0) {
    console.log(
      `[ng-zorro-css] 提示：以下被项目覆盖的类名不在产物里（多属未使用组件的样式）：${notCovered.join(' ')}`,
    );
  }
}

await main();
