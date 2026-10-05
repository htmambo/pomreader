# Linux 打包（pacman）依赖维护

本项目通过 electron-builder 产出 `release/pomreader-<version>.pacman`，安装方式：

```bash
sudo pacman -U release/pomreader-1.0.0.pacman
```

## 为什么需要显式声明 depends

electron-builder 26 内置的 pacman 默认依赖是一份**硬编码的旧 Electron 时代清单**（见
`node_modules/app-builder-lib/out/targets/FpmTarget.js` 的 `getDefaultDepends`）：

```
c-ares, ffmpeg, gtk3, http-parser, libevent, libvpx, libxslt, libxss,
minizip, nss, re2, snappy, libnotify, libappindicator-gtk3
```

其中至少两个包在 Arch 系官方仓库**已不存在**：

- `http-parser` — 已从官方仓库移除
- `libappindicator-gtk3` — 被 `libayatana-appindicator` 取代

默认清单不会因为 Arch 仓库变动而更新，所以 `pacman -U` 会在解析依赖阶段直接失败：

```
警告：无法解决 "http-parser"，"pomreader" 的一个依赖关系
```

因此 `package.json` 的 `build.pacman.depends` **显式覆盖**该默认清单
（语义为整体替换而非合并，见 `FpmTarget.js:185-198`）。

## 依赖清单的取舍规则

当前清单基于 Electron 44 实测得出，遵循两条规则：

1. **Electron 二进制直接链接（`DT_NEEDED`）或运行时 `dlopen` 的库，其所属包必须显式声明。**
   不能依赖其他包的传递依赖 —— 二进制直接链接的库属于本包的实现细节。
2. **纯传递依赖不重复声明。** 例如 `libXinerama` / `libXi` / `libXrender` / `libwayland-*`
   / `fontconfig` / `freetype` 均由 `libgdk-3.so.0` 引入，已由 `gtk3` 的依赖闭包保证。

明确**不**声明的项及原因：

| 不声明 | 原因 |
| --- | --- |
| `libxss` | Electron 44 二进制中无 `XScrnSaver` 字符串，未使用 |
| `libsecret` | 应用未调用 `safeStorage` |
| `libappindicator-*` / `libayatana-appindicator` | 应用未创建 `Tray` |

> `package.json` 是严格 JSON（Node `require()` 与 Prettier 均不接受注释），
> 故本文件是依赖清单的维护说明载体，升级 Electron 时请同步复核本文件。

## 升级 Electron 后如何重建清单

```bash
# 1) 重新构建，得到最新的 linux-unpacked
npm run dist:linux

# 2) 硬依赖（DT_NEEDED）——注意是 pomreader 自身直接链接的，不要看 ldd 全量
readelf -d release/linux-unpacked/pomreader | grep NEEDED \
  | sed 's/.*\[\(.*\)\]/\1/' | sort -u

# 3) 运行时 dlopen 的库（不在 DT_NEEDED 里）
strings -a release/linux-unpacked/pomreader \
  | grep -oE "lib[a-z0-9_+.-]*\.so\.[0-9]+" | sort -u

# 4) 确认应用是否真的用到 safeStorage / Tray，决定 libsecret、appindicator
grep -rn "safeStorage\|Tray" electron/ --include=*.ts

# 5) 包名映射：Arch 已合并 atk→at-spi2-core、cups-libs→cups；
#    用 pacman -Si <包名> 逐个验证存在性，缺失即安装失败
for p in <包名列表>; do pacman -Si "$p" >/dev/null 2>&1 \
  && echo "OK      $p" || echo "MISSING $p"; done

# 6) 打完包后验证生成的依赖并做一次非 root 解析演练
tar -xJf release/pomreader-1.0.0.pacman .PKGINFO -O | grep '^depend'
pacman -U --print release/pomreader-1.0.0.pacman   # exit 0 即依赖可满足
```

`pacman -U --print` 会真实解析依赖但不落盘，适合在无 root 环境下验证；
它对无法满足的依赖会返回 exit 1。

## 安装后的图标修复

`build.pacman.afterInstall` 指向 `electron/scripts/after-install.sh`，
它会在安装后为所有非 hicolor 图标主题（含用户级 `~/.local/share/icons`）建立
`pomreader.png` symlink 并重建缓存，绕开第三方 KDE 主题不读取 hicolor 新增图标的问题。
该脚本依赖 `hicolor-icon-theme`，故已列入依赖清单。
