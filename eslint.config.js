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
const globals = require('globals');

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
      'src/assets/sandbox.worker.js',
      'src/app/core/book-source/js-source/sandbox.worker.ts', // worker 上下文（DedicatedWorkerGlobalScope）
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
      globals: { ...globals.browser },
    },
    rules: {
      ...eslint.configs.recommended.rules,
      ...tseslint.configs.recommended.rules,
      ...angular.configs.recommended.rules,

      '@angular-eslint/component-selector': [
        'error',
        { type: 'element', prefix: 'app', style: 'kebab-case' },
      ],
      '@angular-eslint/directive-selector': [
        'error',
        { type: 'attribute', prefix: 'app', style: 'camelCase' },
      ],

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

      '@typescript-eslint/no-explicit-any': 'off', // 暂时 off；后续渐进收紧
      '@typescript-eslint/no-non-null-assertion': 'off', // 仓库允许

      'no-console': 'off',
      'no-empty': 'off', // 仓库允许 catch {} 等空块
      'no-control-regex': 'off', // legado-import 解析含控制字符正则
      'no-async-promise-executor': 'off', // safe-net.ts 异步 executor 必要
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
      globals: { ...globals.node },
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
    rules: { ...angularTemplate.configs.recommended.rules },
  },
);