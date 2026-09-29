/**
 * 模板里用到的 ng-zorro 组件 / 指令 ↔ 组件 imports 的一致性静态检查
 * （P3 收口，user 报 NG01203 后补）
 *
 * ## 为什么需要这个检查（`ng build` 抓不到）
 *
 * 实测三种情形：
 * · 模板里放一个**不带属性绑定**的未知元素 → `ng build` 报 NG8001 ✅
 * · 放一个**带属性绑定**（`[ngModel]` / `[foo]`）的未知元素 → `ng build` **静默放过** ❌
 *   （同一模板、同一构建命令、同一位置，只因为多了绑定）
 * · 少导入一个模块（如 `NzSwitchModule`）而模板用了 `<nz-switch [ngModel]>` → 同样静默，
 *   只在运行时炸 `NG01203: No value accessor for form control`
 *
 * 也就是说"build 绿"**不能**保证模板里用到的 ng-zorro 组件都导入了模块。
 * 指令同理：`<button nz-button>` 少了 `NzButtonModule` 不报错，只是按钮**看起来是原生按钮**。
 * 本检查把这两类洞一起补上。
 *
 * 覆盖面：内联模板与 `templateUrl` 模板都扫（仓库 28 个组件里 18 个是内联）。
 *
 * ## 元素 / 属性 → 模块映射怎么来的
 *
 * **从 `node_modules/ng-zorro-antd` 现场解析**，不手写清单。手写清单必然会随版本腐化，
 * 而腐化的表现恰恰是"静默漏检"——与本文件要防的 bug 同类。解析链路见 `buildNzMap`。
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  balancedEnd,
  maskNonCode,
  readQuoted,
  type MaskedSource,
} from './__fixtures__/ts-source-mask';

// 本文件在 src/app/ 下，故上溯两级才是仓库根
const APP_ROOT = path.resolve(__dirname, '../..');
const NZ_FESM = path.resolve(APP_ROOT, 'node_modules/ng-zorro-antd/fesm2022');

/**
 * 元素 selector / 属性选择器 → 声明它的模块集合。
 *
 * ## 为什么不能按文件名推模块
 *
 * ng-zorro 的 fesm bundle **不是**一个模块一个文件：`ng-zorro-antd-calendar.mjs` 里
 * 含有 `nz-select` / `nz-radio-group` 的字样，因为 `NzRangePicker` 的内联模板在
 * `dependencies: [{ kind: 'component', type: i2.NzSelectComponent, selector: 'nz-select' }]`
 * 里引用了它们；`ng-zorro-antd-code-editor.mjs` 同理含有 `nz-spin`。
 * 「文件名 → 模块名」的启发式会把这些**依赖声明**误认成组件声明（实测
 * `nz-select` 被判成 `NzCalendarModule`），而且失败形态正是"误报/漏报混乱"。
 *
 * 改为按真实的声明链路解析：
 * 1. `ɵɵngDeclareClassMetadata({ ..., type: Xxx, decorators: [{ type: Component|Directive,
 *    args: [{ selector: '…' }] }] })` → selector ↔ 类
 * 2. `ɵɵngDeclareNgModule({ ..., type: NzXxxModule, declarations: [...] / imports: [...] / exports: [...] })`
 *    → 模块 ↔ 它声明/导出的类
 *
 * 类取两者的交集反查，结果是"要用上它至少得导入哪个模块"的真值。
 * 全程从 `node_modules` 现场解析，不手写清单。
 */
function buildNzMap(): { elements: Map<string, Set<string>>; attrs: Map<string, Set<string>> } {
  const elements = new Map<string, Set<string>>();
  const attrs = new Map<string, Set<string>>();
  if (!fs.existsSync(NZ_FESM)) return { elements, attrs };

  // 类 → 声明它的模块
  const ownerOfClass = new Map<string, Set<string>>();
  // selector → 类集合。留并集而非单值：理论上同名 selector 可能出现在两个包里，
  // 单值会"后者覆盖前者"，把一个合法 owner 悄悄抹掉。
  const classesOfSelector = new Map<string, Set<string>>();
  // 属性名 → 类集合。一个属性可被多个指令认领（`button[nz-button]:not(…)` 同时命中
  // NzButtonComponent / NzTransitionPatchDirective / NzWaveDirective），必须留并集 ——
  // 只留最后一个会把 `nz-button` 判成 `NzWaveModule`，产生一片假阳性。
  const classesOfAttr = new Map<string, Set<string>>();

  const addTo = (map: Map<string, Set<string>>, key: string, cls: string): void => {
    if (!map.has(key)) map.set(key, new Set());
    map.get(key)!.add(cls);
  };

  for (const file of fs.readdirSync(NZ_FESM)) {
    if (!file.startsWith('ng-zorro-antd-') || !file.endsWith('.mjs')) continue;
    const text = fs.readFileSync(path.join(NZ_FESM, file), 'utf-8');
    const masked = maskNonCode(text);

    // ① 模块 → 类集合（`Nz*Component` / `Nz*Directive` 都要）
    for (const body of findCallBodies(masked, 'ɵɵngDeclareNgModule')) {
      const mod = /\btype:\s*([A-Za-z_$][\w$]*)\s*,/.exec(body)?.[1];
      if (!mod || !mod.endsWith('Module')) continue;
      for (const cls of body.matchAll(/\b(Nz\w*(?:Component|Directive))\b/g)) {
        if (!ownerOfClass.has(cls[1]!)) ownerOfClass.set(cls[1]!, new Set());
        ownerOfClass.get(cls[1]!)!.add(mod);
      }
    }

    // ② selector → 类。**组件和指令一视同仁**：ng-zorro 22 起 `NzButtonComponent` 本身是
    //    standalone，selector 就是 `button[nz-button], a[nz-button]`，并不存在独立的
    //    `NzButtonDirective`；只按 `type: Directive` 抽属性会把 `nz-button` 判给
    //    `NzTransitionPatchModule` / `NzWaveModule`，产生一片假阳性。
    //    所以：整条 selector 记进 elements（只有形如 `nz-select` 的才会命中标签），
    //    同时把 selector 里所有 `[attr]` 记进 attrs。
    //    引号取 `['"]` 并用反向引用配对：当前 332 个 metadata selector 实测全为单引号，
    //    但这由 Angular partial 编译器决定，不该写死在断言里。
    //    metadata 头在 `selector:` 之前不含 `}`，故 `[^}]*?` 不会跨块。
    const re =
      /ɵɵngDeclareClassMetadata\(\{[^}]*?type:\s*([A-Za-z_$][\w$]*)\s*,\s*decorators:\s*\[\{\s*type:\s*(?:Component|Directive)\s*,\s*args:\s*\[\{\s*selector:\s*(['"])/g;
    for (const m of masked.code.matchAll(re)) {
      const cls = m[1]!;
      // 引号位置在 code 上定位（保证整条声明真的在代码区），内容从 nocomment 读
      const selector = readQuoted(masked.nocomment, m.index! + m[0].length - 1);
      if (selector === null) continue;
      addTo(classesOfSelector, selector, cls);
      for (const a of selector.matchAll(/\[([\w-]+)\]/g)) addTo(classesOfAttr, a[1]!, cls);
    }
  }

  const invert = (map: Map<string, Set<string>>): Map<string, Set<string>> => {
    const out = new Map<string, Set<string>>();
    for (const [key, classes] of map) {
      if (!out.has(key)) out.set(key, new Set());
      for (const cls of classes) {
        for (const owner of ownerOfClass.get(cls) ?? []) out.get(key)!.add(owner);
      }
      if (out.get(key)!.size === 0) out.delete(key);
    }
    return out;
  };
  return { elements: invert(classesOfSelector), attrs: invert(classesOfAttr) };
}

/**
 * 找出 `name(` 调用的参数体（按内容原样取出，便于其中的标识符可读）。
 *
 * 在**掩码**上定位与配平：bundle 的 license 注释块里可能出现同名文本，
 * 实测当前 0 次，但不写这条就等于把"注释里出现标记"这个坑留给下一个版本。
 */
function findCallBodies(masked: MaskedSource, name: string): string[] {
  const out: string[] = [];
  const re = new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\(', 'g');
  for (const hit of masked.code.matchAll(re)) {
    const open = hit.index! + hit[0].length - 1; // 指向 `(`
    const end = balancedEnd(masked.code, open, '(', ')');
    if (end < 0) continue;
    // 两份掩码与原文等长，同一区间切 nocomment（保留字符串数据）
    out.push(masked.nocomment.slice(open + 1, end));
  }
  return out;
}

interface TemplateComponent {
  tpl: string;
  html: string;
  /** 该文件里所有 `imports: [...]` 的内容拼接（单组件文件即一段；多组件取并集） */
  importsBlock: string;
}

/**
 * 提取源码里所有 `imports: [...]` 字面量的内容并拼起来。
 *
 * 匹配与配平都在**掩码**上做：
 * · 注释掉的一行 `// imports: [NzSwitchModule]` 不会被误认成真导入（原按 `includes` 会）
 * · 字符串里的 `imports: [` 同理
 * 不用 `split('imports: [')[1].split('\n  ],')[0]`：那种写法依赖闭合处的**具体缩进**，
 * Prettier 一改排版就静默取空 —— 正是本文件要防的那类"静默漏检"。
 */
function extractImportsBlock(src: string, masked: MaskedSource): string {
  const parts: string[] = [];
  for (const m of masked.code.matchAll(/\bimports\s*:\s*\[/g)) {
    const open = m.index! + m[0].length - 1;
    const end = balancedEnd(masked.code, open, '[', ']');
    if (end < 0) continue;
    parts.push(src.slice(open + 1, end));
  }
  return parts.join('\n');
}

/**
 * 取内联 `template: '…'` 的正文；没有内联模板返回 null。
 *
 * 独立成纯函数是为了能直接喂合成字符串做自测 —— 覆盖面断言一旦依赖
 * "应用源码里恰好有某个标签"，正常的业务重构就会把守卫弄红。
 *
 * 刻意**不**解析 `${…}` 插值：把整个模板字面量当作不透明内容直到闭引号，
 * 正是这里想要的语义（`${items[0]}` 里的 `[0]` 不该影响任何括号配平）。
 */
function extractInlineTemplate(src: string, masked: MaskedSource): string | null {
  const m = /\btemplate\s*:\s*(['"`])/.exec(masked.code);
  if (!m) return null;
  const quoteAt = m.index + m[0].length - 1;
  const lit = masked.literals.find((l) => l.start === quoteAt);
  if (!lit) return null;
  return src.slice(lit.start + 1, lit.end);
}

/**
 * 收集所有组件的模板 —— `templateUrl` 与内联 `template` **都要收**。
 *
 * 早期版本只收 `templateUrl`，理由写的是"inline 模板由编译器保证"，这是错的：
 * `ng build` 静默放过的是「未知元素 + 属性绑定」，与模板是内联还是外置无关。
 * 仓库里 28 个组件有 18 个是内联模板，只查外置等于放掉 64% 的覆盖面。
 */
function collectComponents(): TemplateComponent[] {
  const out: TemplateComponent[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.component.ts')) {
        const src = fs.readFileSync(full, 'utf-8');
        const masked = maskNonCode(src);
        // 路径不限 `./` 前缀：写死 `./` 时，`templateUrl: '../shared/x.html'` 会让整个
        // 组件被静默跳过（连内联分支都进不去），检查就此失效。
        const url = /templateUrl:\s*['"]/.exec(masked.code);
        if (url) {
          const raw = readQuoted(masked.nocomment, url.index + url[0].length - 1);
          if (raw === null) continue;
          const tpl = path.resolve(dir, raw);
          if (!fs.existsSync(tpl)) continue;
          out.push({
            tpl,
            html: fs.readFileSync(tpl, 'utf-8'),
            importsBlock: extractImportsBlock(src, masked),
          });
          continue;
        }
        const inline = extractInlineTemplate(src, masked);
        if (inline === null) continue;
        out.push({
          tpl: `${full}#template`,
          html: inline,
          importsBlock: extractImportsBlock(src, masked),
        });
      }
    }
  };
  walk(path.join(APP_ROOT, 'src/app'));
  return out;
}

/** `imports` 里是否**按标识符**声明了 `name`（不是子串命中） */
function declares(importsBlock: string, name: string): boolean {
  // 早期用 `importsBlock.includes(name)`：`TestNzSwitchModule` 会被当成导入了
  // `NzSwitchModule`。模块名与组件类名都是纯单词字符，`\b` 足够切分。
  return new RegExp(`\\b${name}\\b`).test(importsBlock);
}

/** 模板里用到的元素标签（跳过 Angular/HTML 内建标签） */
function usedElements(html: string): Set<string> {
  // 先剥 HTML 注释，否则注释掉的示例标记会被当成真用到的元素
  const bare = stripComments(html);
  const skip = new Set([
    'div',
    'span',
    'p',
    'a',
    'button',
    'input',
    'textarea',
    'label',
    'section',
    'pre',
    'details',
    'summary',
    'ul',
    'ol',
    'li',
    'table',
    'tr',
    'td',
    'th',
    'form',
    'h1',
    'h2',
    'h3',
    'h4',
    'strong',
    'em',
    'small',
    'code',
    'img',
    'ng-container',
    'ng-template',
    'ng-content',
    'ngIf',
    'ngFor',
  ]);
  const used = new Set<string>();
  for (const m of bare.matchAll(/<([a-zA-Z][\w-]*)/g)) {
    const tag = m[1]!;
    if (!skip.has(tag)) used.add(tag);
  }
  return used;
}

function stripComments(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, '');
}

/**
 * 模板里用到的属性名（含 `[prop]` 绑定里的名字）。
 *
 * 只扫**标签内部**，不扫文本节点 —— 否则 `nz-button` 这类出现在正文里的词会被误判。
 * 属性值的引号内容整体跳过，避免 `title="a b"` 把 `b` 当成属性。
 *
 * 这里的嵌套量词**不是** ReDoS：`"[^"]*"` / `'[^']*'` / `[^>"']` 三个分支在
 * 首字符上互斥，不存在需要回溯的歧义。实测 53KB 未闭合标签输入耗时 0ms。
 * 唯一残留是"超长且无 `>`"时的 O(n²)，受模板长度约束，暂不处理。
 */
function usedAttributes(html: string): Set<string> {
  const bare = stripComments(html);
  const used = new Set<string>();
  for (const m of bare.matchAll(/<[a-zA-Z][\w-]*((?:"[^"]*"|'[^']*'|[^>"'])*?)\/?>/g)) {
    const attrs = m[1] ?? '';
    // 去掉属性值里的内容，再取名字：裸属性、`[prop]`、`(prop)`、`*prop`、`#prop`
    const names = attrs.replace(/"[^"]*"|'[^']*'/g, ' ');
    for (const a of names.matchAll(/(?:^|\s)[.#*[(]?\s*([A-Za-z_][\w-]*)/g)) used.add(a[1]!);
  }
  return used;
}

describe('模板 ng-zorro 元素/指令 ↔ imports 一致性（补 ng build 抓不到的洞）', () => {
  const { elements: nzElements, attrs: nzAttrs } = buildNzMap();

  it('ng-zorro selector 映射能解析到（否则本检查是空跑）', () => {
    expect(nzElements.size, 'ng-zorro 元素映射为空，检查会失去意义').toBeGreaterThan(50);
    expect(nzAttrs.size, 'ng-zorro 指令属性映射为空，指令检查会失去意义').toBeGreaterThan(20);
    expect([...(nzElements.get('nz-switch') ?? [])]).toEqual(['NzSwitchModule']);
    expect([...(nzElements.get('nz-select') ?? [])]).toEqual(['NzSelectModule']);
    expect([...(nzElements.get('nz-spin') ?? [])]).toEqual(['NzSpinModule']);
    // 曾经把 `nz-select` 误判成 `NzCalendarModule`（文件名启发式），这里钉死。
    // `nz-button` 有多个 owner 是**正确**的：`button[nz-button]:not(...)` 同时命中
    // NzButtonComponent / NzTransitionPatchDirective / NzWaveDirective，用包含而非相等。
    expect(nzAttrs.get('nz-button')?.has('NzButtonModule')).toBe(true);
  });

  it('内联模板提取对合成输入有效（不依赖应用源码里恰好有哪个标签）', () => {
    // 之前这条断言写的是"内联模板里至少有一个 nz-* 元素"，绑死了业务代码：
    // 有人把 <nz-switch> 换成原生 <input> 就会误红。这里改成喂合成源码，
    // 证明提取逻辑本身没坏。
    const src = [
      'const x = 1; // 注释里的 template: `假`',
      '@Component({',
      '  imports: [NzSwitchModule],',
      '  template: `<div nz-button>ok</div>`,',
      '})',
    ].join('\n');
    const masked = maskNonCode(src);
    expect(extractInlineTemplate(src, masked)).toBe('<div nz-button>ok</div>');
    // 注释里那行不能被误认成模板
    expect(
      extractInlineTemplate(
        '// template: `x`\n@Component({})',
        maskNonCode('// template: `x`\n@Component({})'),
      ),
    ).toBeNull();
    // 模板里出现 `imports: [` 字样也不能污染真实 imports 的提取
    const tricky = '@Component({ imports: [NzSwitchModule], template: `<p>imports: [Nope]</p>` })';
    const tm = maskNonCode(tricky);
    expect(extractInlineTemplate(tricky, tm)).toBe('<p>imports: [Nope]</p>');
    expect(extractImportsBlock(tricky, tm)).not.toContain('Nope');
  });

  it('注释里的 imports 不会被误认成真导入', () => {
    const src = [
      '// 之前写错过：// imports: [NzSwitchModule]',
      '@Component({',
      '  /* imports: [NzButtonModule] */',
      '  imports: [NzIconModule],',
      '})',
    ].join('\n');
    const block = extractImportsBlock(src, maskNonCode(src));
    expect(declares(block, 'NzSwitchModule'), '注释里的 NzSwitchModule 被当真了').toBe(false);
    expect(declares(block, 'NzButtonModule'), '块注释里的 NzButtonModule 被当真了').toBe(false);
    expect(declares(block, 'NzIconModule')).toBe(true);
  });

  it('imports 匹配按标识符而非子串', () => {
    expect(declares('TestNzSwitchModule, FakeNzSwitchModule', 'NzSwitchModule')).toBe(false);
    expect(declares('NzSwitchModule, NzIconModule', 'NzSwitchModule')).toBe(true);
  });

  it('掩码器认得模板字面量的 ${…} 插值（插值内是代码，不是字面内容）', () => {
    // 若不认插值，遇到 `` `${a ? 'x' : 'y'}` `` 会在第一个引号处提前截断模板；
    // 若把插值当字面内容整体挖空，`imports` 括号配平又会被插值里的 `[0]` 带偏。
    // 两条都要钉住。
    const src =
      "@Component({\n  imports: [NzSwitchModule],\n  template: `${a ? 'x' : [0, 1]}`,\n})";
    const masked = maskNonCode(src);
    expect(extractInlineTemplate(src, masked)).toBe("${a ? 'x' : [0, 1]}");
    // 插值里的 `[0, 1]` 仍在 code 中可见（它是代码），模板外的 imports 配平不受影响
    expect(extractImportsBlock(src, masked).trim()).toBe('NzSwitchModule');
    // code 掩码里字符串内容已挖空，nocomment 里仍在（读数据靠后者）
    expect(masked.code).toContain('imports: [NzSwitchModule]');
    expect(masked.code).not.toContain('NzSwitchModule,');
  });

  it('覆盖面：内联模板与外置模板都被收进来了', () => {
    // 没有这条，下面几条可能在"模板提取全失败"的状态下空跑。
    // 新增组件 / 改写组件写法导致提取失配时，这里会先红。
    const comps = collectComponents();
    const inline = comps.filter((c) => c.tpl.endsWith('#template'));
    const external = comps.filter((c) => !c.tpl.endsWith('#template'));
    expect(inline.length, '内联模板组件一个都没收进来').toBeGreaterThanOrEqual(10);
    expect(external.length, 'templateUrl 组件一个都没收进来').toBeGreaterThanOrEqual(5);
    // 模板正文为空 = 提取失配 = 静默漏检。唯一例外是**确实**写空模板的占位组件，
    // 已逐个读过源码确认；新增空模板必须显式加进来，而不是让断言放宽。
    const KNOWN_EMPTY = new Set(['src/app/pages/universal-search/search-placeholder.component.ts']);
    const empty = comps
      .filter((c) => c.html.trim().length === 0)
      .map((c) => path.relative(APP_ROOT, c.tpl).replace(/#template$/, ''));
    expect(
      empty.filter((f) => !KNOWN_EMPTY.has(f)),
      '这些组件的模板正文提取为空',
    ).toEqual([]);
  });

  it('没有"模板用了但未导入模块"的 ng-zorro 元素', () => {
    const problems: string[] = [];
    for (const c of collectComponents()) {
      for (const tag of usedElements(c.html)) {
        const mods = nzElements.get(tag);
        if (!mods) continue; // 不是 ng-zorro 组件（app-* 或自定义），另由下一条查
        if (![...mods].some((m) => declares(c.importsBlock, m))) {
          problems.push(
            `${path.relative(APP_ROOT, c.tpl)}: 用了 <${tag}> 但 imports 里没有 ${[...mods].join(' / ')}`,
          );
        }
      }
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('没有"模板用了但未导入模块"的 ng-zorro 指令属性', () => {
    const problems: string[] = [];
    for (const c of collectComponents()) {
      for (const attr of usedAttributes(c.html)) {
        const mods = nzAttrs.get(attr);
        if (!mods) continue;
        if (![...mods].some((m) => declares(c.importsBlock, m))) {
          problems.push(
            `${path.relative(APP_ROOT, c.tpl)}: 用了 [${attr}] 但 imports 里没有 ${[...mods].join(' / ')}`,
          );
        }
      }
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('没有"模板用了但未导入"的 app-* 组件', () => {
    const problems: string[] = [];
    for (const c of collectComponents()) {
      for (const tag of usedElements(c.html)) {
        if (!tag.startsWith('app-')) continue;
        // 类名按 AGENTS.md 的 selector 约定推出：app-rules-panel → RulesPanelComponent
        const cls =
          tag
            .slice('app-'.length)
            .split('-')
            .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
            .join('') + 'Component';
        if (!declares(c.importsBlock, cls)) {
          problems.push(
            `${path.relative(APP_ROOT, c.tpl)}: 用了 <${tag}> 但 imports 里没有 ${cls}`,
          );
        }
      }
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });
});
