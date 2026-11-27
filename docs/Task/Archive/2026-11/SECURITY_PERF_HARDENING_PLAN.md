# 安全与性能硬化（2026-11 静态审查整改）

**Status**: ✅ 已完成（完成时间：2026-11-27）
> 对应 fullauto 状态：`.omc/fullauto/security-perf-hardening/state.json`
> 实施计划：`.omc/plans/fullauto-security-perf-hardening-impl.md`

## 任务目标

根据 2026-11-27 对项目的静态审查结论，修复高优先级安全问题并落地低风险性能优化，不改变既有产品行为。

## 问题分析

审查覆盖 Angular 渲染层、Electron 主进程、IPC 边界、构建配置与依赖。核心问题：

1. 主抓取链路 `pom:fetch-html` 跟随重定向但不复检目标地址，可被 302 绕过 SSRF 防护。
2. `isPrivateHost` 对 Node `URL.hostname` 的 IPv6 方括号形式失效，`0.0.0.0`、`fe80::/10`、`fc00::/7` 未覆盖。
3. 远程内容上下文（webview / 隐藏窗口）未设置权限处理器，重定向无导航守卫。
4. `openExternal` 接受任意协议；zip 解压无解压后大小上限。
5. 主题纹理使用根绝对 `/assets`，`file://` 打包态解析到文件系统根导致 404。
6. 章节正文内存缓存无释放策略；动画引擎同步进入首屏；书架卡片无渲染跳过优化。

## 子任务列表

- ✅ T1 `isPrivateHost` 重写（IPv4 段表 + IPv6 + 0.0.0.0）
- ✅ T2 net-guard 单测补 IPv6 / `.localhost` / 6to4 / NAT64
- ✅ T3 fetch-handler 复用 `safeNetRequest`（逐跳 SSRF）
- ✅ T4 fetch-handler 测试适配 + 重定向 SSRF 用例
- ✅ T5 隐藏窗口 / CF 窗口导航守卫（含 window.open 收口）
- ✅ T6 session 权限处理器
- ✅ T7 openExternal 协议白名单
- ✅ T8 zip 解压大小上限（header + 实际长度双检）
- ✅ T9 主窗口 CSP
- ✅ T10 移除 webview `allowpopups`
- ✅ T11 preload `on` 通道白名单
- ✅ T12 `pom-local` realpath 校验
- ✅ T13 DB 窗口导航守卫（精确 db-window.html）
- ✅ T14 主题纹理相对路径
- ✅ T15 章节正文缓存释放
- ✅ T16 动画异步化
- ✅ T17 书架 `content-visibility`
- ✅ T18（复审新增）safe-net 3xx 改走 `redirect` 事件（修复旧死代码）

## 每个子任务的改动内容

见 `.omc/plans/fullauto-security-perf-hardening-impl.md` 的同名任务条目。

## 预期效果和验收标准

- 重定向到内网地址被拒绝，且不发起第二跳请求。
- IPv6 loopback / IPv4-mapped / 0.0.0.0 / link-local / unique-local 全部判为私网。
- 权限请求默认拒绝；外链仅 http/https。
- zip 解压前按 `header.size` 限流。
- 打包产物 CSS 不再出现 `url(/assets/`。
- 离开阅读页释放当前书正文缓存。
- `npm run lint` 0 error、`tsc --noEmit` 通过、`npm test` 全绿、`npm run build` 通过。

## 风险评估和缓解措施

- CSP 可能影响 dev/构建内联 → 保留 `unsafe-inline`，仅禁远程脚本与 eval。
- 抓取错误语义漂移 → 显式映射保持旧返回值。
- 缓存释放增加一次本地读 → 毫秒级，可接受。

## 实施顺序和依赖关系

T1 → T2；T3 → T4；T5 依赖 T1；其余任务相互独立，按文件顺序实施。

## 阶段 0 输出（spec）

- 路径：.omc/fullauto/security-perf-hardening/spec.md
- 包含：## Assumptions Made / ## Decisions Made

## 实施计划

- 路径：.omc/plans/fullauto-security-perf-hardening-impl.md

## QA 记录

- `npm run lint`：0 error
- `npx tsc -p tsconfig.app.json --noEmit`：通过
- `npx tsc -p electron/tsconfig.electron.json --noEmit`：通过
- `npm test`：76 文件 / 1237 用例全绿（新增 net-guard IPv6/6to4/NAT64、fetch 跨跳转 SSRF、releaseBook 用例）
- `npm run build`：exit 0；main chunk 268K → 208K
- `npm run format:check`：通过

## 验证

- 路径：.omc/fullauto/security-perf-hardening/validation.md
- security-reviewer round 1 为 REJECTED（2 HIGH + 1 MEDIUM + 3 LOW），已按条目修复并重跑
- code-reviewer：APPROVED（无 CRITICAL/HIGH）；3 条 MEDIUM/LOW 已处理或记录为残余
- 外部审核 MCP：未参与（coding-bridge 429 月度配额；codex 连接失败）

## 验收结果

- 安全：重定向逐跳 SSRF 校验、IPv6/6to4/NAT64/localhost 分类、window.open 与导航护栏、权限收口、外链协议白名单、zip 大小上限、CSP、preload 通道白名单、pom-local realpath 全部落地。
- 性能：主题纹理在打包态可解析（19 处 `./media/...`，`url(/assets/` 为 0）；main chunk 268K → 208K；章节正文缓存离开阅读页释放；书架视口外跳渲染。
- 质量门：lint 0、双端 tsc 通过、1237 单测全绿、双构建通过、format 通过。
- 未验证：真实 Electron 窗口内的 CSP 运行态、动画懒加载首次交互、万本级书架滚动表现。

## 备注 / 经验

- **Electron `redirect:'manual'` 的 3xx 走 `redirect` 事件，不触发 `response`**：旧 `safe-net` 在 `response` 内判 3xx 是死代码，本次一并修复（这是复审带来的最大额外收益）。
- `loadURL` 不触发 `will-navigate` / `will-redirect`，任何「拦截导航」的防护都必须同时处理 `window-open`。
- CSP 的 `script-src 'unsafe-inline'` 被保留：Angular 构建产物的内联脚本负责把 `media="print"` 的样式表切回生效，移除会破坏样式加载。
- 残余风险：DNS rebinding（`isPrivateHost` 为同步纯函数，未做解析后 IP 校验），已在 validation.md 记录。
