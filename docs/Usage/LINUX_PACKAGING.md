# Linux 打包（pacman / deb / AppImage / tar.gz）

本项目通过 electron-builder 产出 Linux 安装包，覆盖四个发行版目标：

| 目标 | 格式 | 产物目录 | 安装方式 |
| --- | --- | --- | --- |
| `manjaro` | `.pacman` | `release/linux-manjaro/` | `sudo pacman -U release/linux-manjaro/*.pacman` |
| `deepin` | `.deb` | `release/linux-deepin/` | `sudo apt install ./release/linux-deepin/*.deb` |
| `ubuntu` | `.deb` | `release/linux-ubuntu/` | `sudo apt install ./release/linux-ubuntu/*.deb` |
| `linux` | `.AppImage` + `.tar.gz` | `release/linux-generic/` | 直接运行 `.AppImage`（双击即用） |

## 一键打包

入口脚本 [`scripts/build-linux.sh`](../../scripts/build-linux.sh)（与 macOS 的 `scripts/build-mac.sh` 同构）：

```bash
npm run dist:linux              # 自动识别当前发行版，只打当前架构
npm run dist:linux:manjaro      # pacman 包
npm run dist:linux:deepin       # deb 包
npm run dist:linux:ubuntu       # deb 包
npm run dist:linux:generic      # 通用 tar.gz + AppImage
npm run dist:linux:all          # 以上全部
```

### 不带参数会产出什么

脚本读 `/etc/os-release` 自动识别发行版，**产出的就是当前系统可直接安装/运行的产物**：

| 识别到的系统 | 目标 | 产物 | 是否「装完即用」 |
| --- | --- | --- | --- |
| Manjaro / Arch / EndeavourOS | `manjaro` | `.pacman` | ✅ `pacman -U` 直接装 |
| Ubuntu | `ubuntu` | `.deb` | ✅ `apt install ./` 直接装 |
| Deepin | `deepin` | `.deb` | ✅ `apt install ./` 直接装 |
| Mint / Pop!_OS / Raspberry Pi OS 等 Debian 系 | `ubuntu` | `.deb` | ✅ |
| 其它（Fedora / openSUSE / …） | `linux` | `.AppImage` | ✅ 单文件，双击即跑 |

依赖可解性验证（不落盘，只解析）：

```bash
pacman -U --print release/linux-manjaro/*.pacman   # exit 0 即依赖可满足
dpkg-deb -f release/linux-ubuntu/*.deb Depends      # deb 侧核对
```

### 通用目标为什么默认带 AppImage

`.tar.gz` 只是裸目录（`pomreader-1.0.0/`），**没有桌面项、没有图标、没有 `/usr/bin` 软链**，
属于手动部署用的备用件，不能算「装完即用」。

`.AppImage` 是单文件 ELF 可执行文件，自带 `.desktop`（`Exec=AppRun --no-sandbox %U`）
与全套 hicolor 图标（16/24/32/48/64/128/256/512），双击即跑并自动出现在应用菜单里 ——
这才是任意发行版都通用的「直接可用」形态。

AppImage 需要 FUSE 运行（绝大多数发行版已预装 `fuse3`）；无 FUSE 时可用
`./白虎阅读-1.0.0.AppImage --appimage-extract` 解包后直接运行 `squashfs-root/AppRun`。

脚本参数：

| 参数 | 作用 |
| --- | --- |
| `--distro <name>` | `linux` / `manjaro` / `deepin` / `ubuntu` / `all`，缺省按 `/etc/os-release` 识别 |
| `--arch <name>` | `x64` / `arm64` / `armv7l` / `ia32` / `all`，缺省当前架构 |
| `--appimage` | 为 manjaro / deb 目标**也追加**一份 AppImage（通用 `linux` 目标默认已带） |
| `--skip-build` | 复用已有 `electron/www` + `dist-electron`，只重跑打包 |
| `--keep-going` | 某目标失败后继续跑下一个（默认遇错即停） |


脚本在打包后会自动回显每个包的依赖清单（`.PKGINFO` 的 `depend` / control 的 `Depends`），
便于在分发前自查依赖是否可解。

> **deepin 与 ubuntu 为什么产物相同**：两者同为 Debian 格式，依赖清单用 Debian 原生的
> `|` 替代语法同时覆盖 Ubuntu 24.04+ 的 t64 改名与 Deepin / Debian 的旧包名，
> 故同一份 `.deb` 两边通用。`--distro all` 时 deb 只构建一次，产物复制到两个目录。

> **跨架构**：应用不含 native module（打包产物内 8 个运行时依赖全为纯 JS），
> 跨架构打包不会引入 ABI 不匹配问题；但「运行验证」仍需对应架构的真机。

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

deb 的内置默认清单同样不可用：

```
libgtk-3-0, libnotify4, libnss3, libxss1, libxtst6, xdg-utils,
libatspi2.0-0, libuuid1, libsecret-1-0
```

它缺了 Electron 44 实际链接的 `libasound2` / `libcups2` / `libatk1.0-0`，
又含本项目并未使用的 `libxss1` / `libuuid1` / `libsecret-1-0`。

因此 `package.json` 的 `build.pacman.depends` 与 `build.deb.depends` **显式覆盖**该默认清单
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
| `libappindicator-*` / `libayatana-appindicator` | 应用未创建 `Tray`（deb 的 `Recommends` 亦已清空） |

> `package.json` 是严格 JSON（Node `require()` 与 Prettier 均不接受注释），
> 故本文件是依赖清单的维护说明载体，升级 Electron 时请同步复核本文件。

### Arch 名 → Debian 名对照

`build.pacman.depends` 与 `build.deb.depends` 是同一份依赖清单的两种命名：

| Arch | Debian | 说明 |
| --- | --- | --- |
| `at-spi2-core` | `libatk1.0-0` + `libatk-bridge2.0-0` + `libatspi2.0-0` | Arch 已合并为一个包 |
| `mesa` | `libgbm1` | 只需 libgbm 部分 |
| `cups` | `libcups2` | |
| `alsa-lib` | `libasound2` | |
| `systemd-libs` | `libudev1` | |
| `gtk3` | `libgtk-3-0` | |

### t64：Ubuntu 24.04+ / Debian 13 的 64-bit time_t 改名

Ubuntu 24.04（noble）起，部分库因 64 位 `time_t` 过渡而改名并加 `t64` 后缀。
已核实的 7 个（Ubuntu noble 包索引实证）：

`libasound2t64`、`libatk-bridge2.0-0t64`、`libatk1.0-0t64`、`libatspi2.0-0t64`、
`libcups2t64`、`libglib2.0-0t64`、`libgtk-3-0t64`

**未**改名的（保持旧名即可）：`libpango-1.0-0`、`libcairo2`、`libx11-6`、`libxcb1`、
`libxcomposite1`、`libxcursor1`、`libxdamage1`、`libxext6`、`libxfixes3`、
`libxkbcommon0`、`libxrandr2`、`libnotify4`、`libnss3`、`libnspr4`、`libudev1`、
`libpulse0`、`libdbus-1-3`、`libexpat1`、`hicolor-icon-theme`、`xdg-utils`。

清单用 Debian 原生的**依赖关系替代语法**同时写两个名字：

```
Depends: libgtk-3-0 | libgtk-3-0t64, libasound2 | libasound2t64, ...
```

`|` 表示「二者满足其一即可」，apt/dpkg 会自动挑选目标发行版实际存在的那个。
旧包名不存在时该分支自动失效，无需为不同 Ubuntu 版本维护多份清单。

## 升级 Electron 后如何重建清单

```bash
# 1) 重新构建，得到最新的 linux-unpacked
npm run dist:linux

# 2) 硬依赖（DT_NEEDED）——注意是 pomreader 自身直接链接的，不要看 ldd 全量
readelf -d release/linux-manjaro/linux-unpacked/pomreader | grep NEEDED \
  | sed 's/.*\[\(.*\)\]/\1/' | sort -u

# 3) 运行时 dlopen 的库（不在 DT_NEEDED 里）
strings -a release/linux-manjaro/linux-unpacked/pomreader \
  | grep -oE "lib[a-z0-9_+.-]*\.so\.[0-9]+" | sort -u

# 4) 确认应用是否真的用到 safeStorage / Tray，决定 libsecret、appindicator
grep -rn "safeStorage\|Tray" electron/ --include=*.ts

# 5) 包名映射：Arch 已合并 atk→at-spi2-core、cups-libs→cups；
#    用 pacman -Si <包名> 逐个验证存在性，缺失即安装失败
for p in <包名列表>; do pacman -Si "$p" >/dev/null 2>&1 \
  && echo "OK      $p" || echo "MISSING $p"; done

# 6) 打完包后验证生成的依赖并做一次非 root 解析演练
tar -xf release/linux-manjaro/*.pacman .PKGINFO -O | grep '^depend'
pacman -U --print release/linux-manjaro/*.pacman   # exit 0 即依赖可满足
dpkg-deb -f release/linux-ubuntu/*.deb Depends      # deb 侧同样核对
```

`pacman -U --print` 会真实解析依赖但不落盘，适合在无 root 环境下验证；
它对无法满足的依赖会返回 exit 1。

## 安装脚本：`afterInstall` 会整体替换内置模板

`build.pacman.afterInstall` 与 `build.deb.afterInstall` 都指向
`electron/scripts/after-install.sh`。需要特别注意：

> electron-builder 的用户自定义 `afterInstall` **整体替换**其内置模板
> （`app-builder-lib/out/targets/FpmTarget.js:68` ——
> `getResource(用户脚本, "after-install.tpl")`），不是在其后追加。

内置模板原本承担 4 件对 deb 关键的事，因此本项目的钩子必须自己补齐：

| 内置模板职责 | 本项目钩子对应实现 | 缺失后果 |
| --- | --- | --- |
| `/usr/bin/<exe>` 软链 | 0.1 | 命令行无法直接调用 |
| chrome-sandbox 的 SUID 回退 | 0.2 | 内核禁用 user namespace 时无法启动 |
| **AppArmor profile 安装** | 0.3 | **Ubuntu 24+ 启动失败**（见下） |
| desktop / MIME 数据库刷新 | 0.4 | 启动器图标不刷新 |

### AppArmor：Ubuntu 24+ 的启动硬需求

Ubuntu 24.04 起 `kernel.apparmor_restrict_unprivileged_userns=1`，未安装 AppArmor profile 的
Electron 应用无法创建 user namespace，沙箱初始化失败而**直接启动不了**。
electron-builder 已在 `linux-unpacked/resources/apparmor-profile` 生成 profile，
本项目的钩子在安装时把它落到 `/etc/apparmor.d/pomreader` 并重新加载。

卸载时由 electron-builder 内置的 `after-remove.tpl` 卸载该 profile 并删除软链。

### chrome-sandbox 的 SUID 权衡

钩子只在**内核不支持 user namespace** 时才给 `chrome-sandbox` 加 SUID（`chmod 4755`），
支持时保持 `0755`：

```bash
if ! { [ -L /proc/self/ns/user ] && unshare --user true; } 2>/dev/null; then
  chmod 4755 "${APP_DIR}/chrome-sandbox"   # 无 userns → 必须 SUID
else
  chmod 0755 "${APP_DIR}/chrome-sandbox"   # 有 userns → 保持非特权
fi
```

**为什么不无条件 SUID**：SUID 的 `chrome-sandbox` 历史上出过 CVE，是 rootkit 的常见提权面。
按需开启而非默认开启，是 Electron 官方推荐的做法。本项目全部四个目标发行版
（Manjaro / Deepin / Ubuntu）默认都启用了 unprivileged user namespace，故实际安装时
走的是 `0755` 分支，SUID 只在极少数禁用 userns 的加固系统上触发。

### 交叉架构的验证边界

`--arch arm64` / `armv7l` / `ia32` 在 x64 宿主上交叉打包时：

- 打包产物内 **只做元数据验证**（`dpkg-deb -I` / `tar tf` / `.PKGINFO`），
  **不做运行时启动验证**；
- 运行验证需对应架构真机（或 qemu-user-static 模拟环境）；
- 应用侧无 native module（asar 内 8 个运行时依赖全为纯 JS），不存在 ABI 不匹配问题；
  Chromium 二进制本身由 electron-builder 按目标架构下载。

## 安装后的图标修复

`build.pacman.afterInstall` / `build.deb.afterInstall` 指向的钩子会在安装后为所有非 hicolor
图标主题（含用户级 `~/.local/share/icons`）建立 `pomreader.png` symlink 并重建缓存，
绕开第三方 KDE 主题不读取 hicolor 新增图标的问题（Deepin 的 DDE 亦受益）。
该脚本依赖 `hicolor-icon-theme`，故已列入依赖清单。
