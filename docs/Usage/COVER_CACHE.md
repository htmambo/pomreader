# 封面缓存说明

封面下载后缓存在 `<userData>/covers/`，文件名按 URL 的 SHA-256 哈希前 16 字符命名。

## 缓存策略

- **命中**：二次访问直接从本地读取，无网络请求
- **未命中**：通过主进程 `net.request` 下载，Referer 透传
- **data: URL**：base64 / percent-encoded 解码后写入缓存

主进程入口：`electron/ipc/cover-handler.ts`（coverResolveCache / coverCacheSize / coverCacheClear）。

## 限制

| 限制 | 阈值 | 目的 |
|---|---|---|
| 单文件大小 | ≤ 8 MB | 防内存爆炸 |
| data: URL | ≤ 2 MB | 防 OOM |
| 协议 | 仅 http(s) 允许 | 防 file/javascript/data 注入 |
| 目标地址 | 拒绝内网 IP（10/8、172.16/12、192.168/16、127/8） | 防 SSRF |
| 重定向跟踪 | ≤ 3 跳 | 防死循环 |

## 失败兜底

- 网络失败 / 解析失败 → 生成纯色 SVG `data:` URL（按 URL hash 派生 hue，保证同一 URL 颜色稳定）
- IPC 不可用（浏览器降级模式 `npm start`）→ 走 fallback，避免 UI 阻塞

```typescript
// src/app/core/cover/cover.service.ts
async resolve(req: CoverRequest | string): Promise<string> {
  if (!window.pomAPI?.coverResolveCache) return this.fallbackDataUrl(req.url);
  try {
    const result = await window.pomAPI.coverResolveCache(request);
    return result.localRef;
  } catch (e) {
    return this.fallbackDataUrl(request.url);
  }
}
```

## 批量下载

`resolveAll(urls[])` 默认 6 并发 + 1 次重试（spec FR-3.7）。失败 URL 不入结果 Map，调用方按 missing 处理。

```typescript
const results = await coverService.resolveAll(bookCovers.map(b => b.cover));
for (const [url, localRef] of results) {
  // localRef: 'local://...' 或 'data:image/svg+xml;base64,...'
}
```

## 渲染协议

`<cover-img>` 组件识别 4 种 URL 协议（spec FR-3.4）：

| 协议 | 来源 | 渲染方式 |
|---|---|---|
| `local://...` | 主进程缓存命中 | `convertFileSrc()` → 本地文件 |
| `asset://...` | Angular assets 静态 | `convertFileSrc()` |
| `data:...` | base64 内联 / fallback SVG | 直传 `<img>` |
| `http(s)://...` | 远程 URL | 走 `CoverService.resolve()` |

`<img onerror>` 触发时切换到 fallback 纯色 SVG；首次加载有 CSS skeleton。

## 缓存管理

在「设置 → 封面缓存」页（`/settings/cache`）可：

- 查看当前总字节数（自动 KB / MB / GB 单位换算）
- 「一键清理」按钮 → 二次确认 → 调 `pomAPI.coverCacheClear()` → Toast 显示释放字节数

清理中若有正在下载的封面，会显示提示（不影响清理继续）。

## 故障排查

| 现象 | 可能原因 | 排查方式 |
|---|---|---|
| 缓存目录写失败 | `<userData>` 权限问题 | 检查目录权限 + Electron 日志 |
| 二次访问仍有网络 | `localRef` 未被 `<cover-img>` 识别 | 确认协议前缀 `local://` 未被替换 |
| 内网 URL 被拒 | SSRF 防护 | 改用公网镜像或在设置中加 bypass（v2 计划） |
| fallback 颜色频繁变 | URL hash 未稳定 | 检查 URL 是否含随机参数 |