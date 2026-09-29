/**
 * 静态守卫：规则播种（`viewChild` → `setRules`）**不得**写成一次性的 `?.` 调用
 *
 * ## 这条守卫挡的是什么
 *
 * 真实故障（书源编辑页，user 报「一直显示规则损坏」）：
 *
 * ```
 * @if (loading()) { <nz-spin/> } @else {
 *   ... <app-rules-panel #panel ...> ...
 * }
 * ```
 *
 * `loadExisting()` 在 `await readDoc()` **之前**就把 `loading` 置 true —— 那一刻
 * `@else` 分支不渲染，`#panel` 不存在，`this.panel()` 是 `undefined`。
 * 于是 `this.panel()?.setRules(doc.rules)` 里的 `?.` 把这次注入**静默吞掉**：
 * 面板稍后被创建时里面全是默认空值，用户一保存就把一份 7 项全空的规则写进盘，
 * 列表页立刻标「规则损坏」。
 *
 * 根因不是 `?.` 写错了，是**注入时机与渲染时机错配**，而 `?.` 把它变成了无声失败。
 * 修法：播种走 `effect`，同时盯 `doc()` 与 `panel()`，两者都就绪才注入，且同一份
 * 文档只播种一次（否则用户在面板里的编辑会被反复冲掉）。
 *
 * ## 为什么用"禁止这个构造"而不是"检查嵌套深度"
 *
 * 试过按"标签必须留在模板顶层"来判，但**修好之后那条仍然是 1**：面板继续放在
 * `@else` 里也没问题，因为 effect 会在它出现之后补种。深度只是风格，不是正确性 ——
 * 拿它当断言会让守卫对正确代码报警，那比没有守卫更糟（会被整体忽略）。
 *
 * 真正的判据是"播种必须是对 `doc`/`panel` 双信号的响应式注入，而不是一次 `?.`"。
 * 播种本身只有一处、且语义特殊（写进子组件的全部规则 signal），所以按构造禁用
 * 不会有假阳性；将来若确有第二种合法播种方式，在下面列表里显式登记并写明理由。
 *
 * ## 为什么不做运行时测试
 *
 * 本仓库 spec 一律直实例化、不用 TestBed（见 `docs/CONVENTIONS.md`），
 * 且 `RulesPanelComponent` 用 `templateUrl` —— vitest 的 JIT 编译解析不了外部模板，
 * 组件级渲染测试在本仓库不可行。静态守卫是当前唯一能落地的防线。
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { maskNonCode } from './__fixtures__/ts-source-mask';

const APP_ROOT = path.resolve(__dirname, '../..');
const SRC = path.join(APP_ROOT, 'src/app');

/** 允许的"非 effect 播种"白名单：组件相对路径 → 理由。留空即不允许。 */
const ALLOWED_ONE_SHOT_SEEDING: Record<string, string> = {};

/** 全仓收集 `*.component.ts` */
function componentFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...componentFiles(full));
    else if (entry.name.endsWith('.component.ts')) out.push(full);
  }
  return out;
}

/**
 * 找出所有 `this.<x>()?.setRules(` 形态的一次性播种调用
 *
 * 必须扫**掩码**（`code` 视角，注释与字符串内容都挖空）：反例就写在注释里 ——
 * 本文件与 `book-source-editor.component.ts` 都把这行代码作为**说明文字**引用，
 * 直接扫原文必然把注释当成真代码，随后这条守卫会因为自己的文档而永远红着。
 */
function oneShotSeedings(src: string): string[] {
  const hits: string[] = [];
  const re = /this\.[A-Za-z_$][\w$]*\(\)\?\.setRules\s*\(/g;
  for (const m of maskNonCode(src).code.matchAll(re)) hits.push(m[0].replace(/\s*\($/, '('));
  return hits;
}

describe('规则播种必须是响应式注入，不是被 `?.` 吞掉的一次性调用', () => {
  const files = componentFiles(SRC);

  it('扫描面非空（否则下面几条会空跑）', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('没有把 setRules 写成 this.x()?.setRules( 的一次性调用', () => {
    const problems: string[] = [];
    for (const f of files) {
      const rel = path.relative(APP_ROOT, f);
      for (const hit of oneShotSeedings(fs.readFileSync(f, 'utf-8'))) {
        if (ALLOWED_ONE_SHOT_SEEDING[rel]) continue;
        problems.push(`${rel}: ${hit} —— 面板此刻可能尚未渲染，?. 会静默吞掉这次播种`);
      }
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('书源编辑页确实用 effect 播种，且同时盯住 doc() 与 panel()', () => {
    const src = fs.readFileSync(
      path.join(SRC, 'pages/book-source/book-source-editor.component.ts'),
      'utf-8',
    );
    // 两个信号都出现在同一个 effect 体里 —— 只盯 doc() 会在面板未就绪时跑空，
    // 只盯 panel() 会在文档未加载时跑空。
    expect(src, '编辑页没有 effect 播种').toMatch(/effect\s*\(\s*\(\s*\)\s*=>/);
    const body = /effect\s*\(\s*\(\s*\)\s*=>\s*\{([\s\S]*?)\n\s*\}\);/.exec(src);
    expect(body, '没能定位 effect 体').not.toBeNull();
    expect(body![1]).toContain('this.doc()');
    expect(body![1]).toContain('this.panel()');
    // 同一份文档只播种一次
    expect(body![1]).toContain('this.seededDoc');
  });

  it('探测器本身有效：构造一个坏样例必须被抓出来', () => {
    const bad = 'class X { private p = viewChild<Y>("panel"); f() { this.p()?.setRules(r); } }';
    expect(oneShotSeedings(bad)).toEqual(['this.p()?.setRules(']);
    // 合法形态：effect 里 getRules/setRules 都不带 ?. 调用
    const good =
      'effect(() => { const d = this.doc(); const p = this.panel(); if (!d || !p) return; p.setRules(d.rules); });';
    expect(oneShotSeedings(good)).toEqual([]);
  });
});
