// ESLint flat config（v9）+ angular-eslint v18 + typescript-eslint v8
// 策略：
// - src/app/ + electron/ 源码走 typescript-eslint project 模式（精确类型检查）
// - spec 文件单独 config（无 project，仅语法规则）
// - 不约束 typings / 配置 / 构建产物 / worker 上下文
const eslint = require('@eslint/js');
const tseslint = require('typescript-eslint');
const angular = require('@angular-eslint/eslint-plugin');
const angularTemplate = require('@angular-eslint/eslint-plugin-template');
const templateParser = require('@angular-eslint/template-parser');
// angular-eslint 22 起 @angular-eslint/eslint-plugin 不再导出 configs（flat config
// 迁移到聚合包）；recommended 规则集改从 angular-eslint.configs.tsRecommended /
// templateRecommended 取。tsPlugin / templatePlugin 与上面两个 require 是同一对象。
const angularEslint = require('angular-eslint');
const globals = require('globals');

// 提取 tsRecommended 的规则子块（数组 [语言配置, 规则块]，取含 rules 者）
const angularTsRecommendedRules = Object.assign(
  {},
  ...angularEslint.configs.tsRecommended.map((c) => c.rules || {}),
);
const angularTemplateRecommendedRules = Object.assign(
  {},
  ...angularEslint.configs.templateRecommended.map((c) => c.rules || {}),
);

// eslint-disable-next-line @typescript-eslint/no-require-imports
const globalsPatch = {
  // Electron type-only globals (auto-import.ts 用 `Electron.X` 形如 `Electron.CrossProcessCommunicationMessages`)
  // NodeJS 全局（window-state.ts:77）
  // HTMLWebViewElement（universal-search.component.ts webview 引用）
  Electron: 'readonly',
  NodeJS: 'readonly',
  HTMLWebViewElement: 'readonly',
  DedicatedWorkerGlobalScope: 'readonly',
};

const SRC_PROJECT = './tsconfig.app.json';
const ELECTRON_PROJECT = './electron/tsconfig.electron.json';

module.exports = tseslint.config(
  // ===== 全局忽略 =====
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'coverage/**',
      '.angular/cache/**',
      'electron/www/**',
      'dist-electron/**',
      'release/**',
      'src/typings/**',
      '*.config.js',
      '*.config.ts',
    ],
  },

  // ===== src/app/ 源码 =====
  {
    files: ['src/app/**/*.ts'],
    ignores: ['**/*.spec.ts'],
    plugins: {
      '@angular-eslint': angular,
      '@typescript-eslint': tseslint.plugin,
    },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { project: SRC_PROJECT, tsconfigRootDir: __dirname },
      globals: { ...globals.browser, ...globalsPatch },
    },
    rules: {
      ...eslint.configs.recommended.rules,
      ...tseslint.configs.recommended.rules,
      ...angularTsRecommendedRules,

      '@angular-eslint/component-selector': [
        'error',
        { type: 'element', prefix: 'app', style: 'kebab-case' },
      ],
      '@angular-eslint/directive-selector': [
        'error',
        { type: 'attribute', prefix: 'app', style: 'camelCase' },
      ],
      // angular-eslint 20 新增。仓库的 spec 一律用 vitest 直实例化（不用 TestBed），
      // 构造器注入是这些 spec 能 `new Svc(stub)` 的前提；改 inject() 会连带重写测试。
      '@angular-eslint/prefer-inject': 'off',

      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          vars: 'all',
          args: 'after-used',
          ignoreRestSiblings: true,
        },
      ],
      'no-unused-vars': 'off',

      '@typescript-eslint/no-explicit-any': 'warn', // 渐进收紧：先 warn 看分布
      '@typescript-eslint/no-non-null-assertion': 'off', // 仓库允许

      'no-console': 'off',
      'no-empty': 'off', // 仓库允许 catch {} 等空块
      'no-control-regex': 'off', // legado-import 解析含控制字符正则
      'no-async-promise-executor': 'off', // safe-net.ts 异步 executor 必要
      'no-irregular-whitespace': ['error', { skipStrings: true, skipComments: false, skipRegExps: true, skipTemplates: true }],
      // 中日韩全角空格在注释里常见；允许 strings/regex/templates 不规则空白
      'no-redeclare': 'off', // TypeScript interface + namespace 同名是合法合并
      eqeqeq: ['error', 'smart'],
    },
  },

  // ===== electron/ 源码 =====
  {
    files: ['electron/**/*.ts'],
    ignores: ['**/*.spec.ts'],
    plugins: { '@typescript-eslint': tseslint.plugin },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { project: ELECTRON_PROJECT, tsconfigRootDir: __dirname },
      globals: { ...globals.node, ...globalsPatch },
    },
    rules: {
      ...eslint.configs.recommended.rules,
      ...tseslint.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      'no-unused-vars': 'off',
      'no-console': 'off',
      eqeqeq: ['error', 'smart'],
    },
  },

  // ===== spec 文件 =====
  {
    files: ['**/*.spec.ts'],
    plugins: { '@typescript-eslint': tseslint.plugin },
    languageOptions: {
      parser: tseslint.parser,
      globals: {
        ...globals.browser,
        ...globals.node,
        // vitest 全局 API（vitest.config.ts globals: true）
        describe: 'readonly',
        it: 'readonly',
        test: 'readonly',
        expect: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
        vi: 'readonly',
        vitest: 'readonly',
      },
    },
    rules: {
      ...eslint.configs.recommended.rules,
      ...tseslint.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      'no-unused-vars': 'off',
      'no-console': 'off',
    },
  },

  // ===== Angular 模板 =====
  {
    files: ['**/*.html'],
    plugins: { '@angular-eslint/template': angularTemplate },
    languageOptions: { parser: templateParser },
    rules: { ...angularTemplateRecommendedRules },
  },
);