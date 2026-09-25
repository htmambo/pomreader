# 扩展开发指南

扩展是书源之外的辅助脚本，用于自定义解析规则、UI 钩子等。

## 1. 文件格式

扩展使用 UserScript 头部约定（与油猴脚本兼容），pomreader 在前 100 行内扫描 `==UserScript==` 块：

```javascript
// ==UserScript==
// @name          去广告
// @namespace     my-ext
// @version       1.0.0
// @description   移除页面广告
// @author        张三
// @match         https://example.com/*
// @match         https://*.example.com/*
// @grant         GM_setValue
// @grant         GM_getValue
// @run-at        document-end
// @category      utility
// ==/UserScript==

(function() { /* ... */ })();
```

支持的 `@key`：

| Key | 说明 |
|---|---|
| `@name` | 扩展显示名 |
| `@namespace` | 命名空间（避免 name 冲突） |
| `@version` | 版本号 |
| `@description` | 描述 |
| `@author` | 作者 |
| `@match` | 匹配的 URL 模式（可多行） |
| `@grant` | 申请的 GM_* 权限（仅元数据登记，v1 未实际暴露） |
| `@run-at` | 注入时机（仅元数据） |
| `@category` | 分类（utility / theme / reader …） |

## 2. v1 限制

v1 阶段扩展能力是**最小可用**：

- 扩展仅作为元数据加载 + `extensionEval(fileName, args[])` 测试入口
- UI hooks（DOM 注入、主题切换、阅读器集成）**推迟到 v2**
- `GM_setValue` / `GM_getValue` 等 `@grant` 仅做元数据登记，未实际暴露 API

设计意图：先把扩展加载管线 + 市场入口打通，证明流程可行；具体功能特性在 v2 按需补全。

## 3. 示例：ad-remover.js（v1 stub）

```javascript
// ==UserScript==
// @name          去广告
// @namespace     pomreader
// @version       0.1.0
// @description   示例扩展（v1 stub：仅导出 evaluate，未实际注入 DOM）
// @author        pomreader
// @match         *://*/*
// @category      utility
// ==/UserScript==

// v1 仅证明扩展可被 extensionEval() 调用；实际过滤推迟到 v2 UI hooks
function evaluate({ chapterContent }) {
  // 期望：返回 {hookCount: 0, transformed: chapterContent}
  return { hookCount: 0, transformed: chapterContent };
}

// 必须显式导出（沙箱仅暴露 return 对象的字段）
;return { evaluate };
```

调用方：

```typescript
// src/app/core/extension/extension.service.ts
const mod = await sandboxService.call<string, 'extensionEval'>(
  'ad-remover.js',
  'extensionEval',
  [{ chapterContent: '...' }],
);
// mod === { hookCount: 0, transformed: '...' }
```

## 4. 安装

扩展文件保存到 `<userData>/extensions/`，文件名 `<name>.js`（与书源 JS 复用同一沙箱与 shim）。

1. 重启应用
2. 打开「扩展管理」页（`/extensions`）可见列表
3. 卡片显示元数据（name / version / author / match 数量）
4. 「运行测试」按钮调 `extensionEval()` 验证返回结构

## 5. 与书源的关系

| 维度 | 书源 | 扩展 |
|---|---|---|
| 头部 | `// @key` | `==UserScript==` 块 |
| 沙箱 | SandboxService（pool=6） | 同一 SandboxService（复用） |
| HTTP 出口 | `legado.http` | `legado.http`（同一 shim，受 SSRF 防护） |
| 函数契约 | `search`/`bookInfo`/`toc`/`content` | `evaluate({chapterContent})`（v1） |
| 触发时机 | 用户搜索 / 入库时 | v2 UI hook 触发（v1 仅测试入口） |
| 存储位置 | `<userData>/booksources/` | `<userData>/extensions/` |

## 6. 故障排查

| 现象 | 可能原因 | 排查方式 |
|---|---|---|
| 列表中不可见 | 文件不在 `<userData>/extensions/` | 检查目录权限 + 重启 |
| 头部未解析 | `==UserScript==` 块位置超出 100 行 | 头部上移 |
| 沙箱执行报错 | 访问了 `fetch` / `window` 等 | 重写为 `legado.http`；检查 `Object.freeze` 错误 |