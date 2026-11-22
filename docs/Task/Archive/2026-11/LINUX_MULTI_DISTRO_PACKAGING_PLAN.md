# Linux 多发行版一键打包脚本 — 任务计划

**Status**: ✅ Completed (completion time: 2026-11-22)
**创建时间**: 2026-11-22
**完成时间**: 2026-11-22
**创建者**: 果农（agent 协助）

## 1. 任务目标与背景

用户需求：**「检查 `scripts/build-mac.sh`，并根据它制作 linux / manjaro / deepin / ubuntu 的一键打包脚本」**。

项目当前只有 macOS 的一键打包脚本（`scripts/build-mac.sh`），Linux 侧只有裸的 `npm run dist:linux`
（等价于 `electron-builder --linux`），无法按发行版产出可直接分发的安装包。本任务补齐 Linux 侧的
「一键打包」能力，并对齐 macOS 脚本的交互形态（参数解析、彩色输出、`--skip-build` / `--keep-going`、
分目录产物、产物清单）。

## 2. 问题分析与现状（已核实的事实基线）

### 2.1 现状

| 项 | 事实 |
| --- | --- |
| macOS 脚本 | `scripts/build-mac.sh`（170 行）：`set -euo pipefail`、彩色 helpers、`usage()` 取文件头注释、`--arch/--skip-build/--keep-going`、逐架构独立输出目录、产物清单 + 分发提示 |
| Linux 打包 | `package.json` `build.linux.target = ["tar.gz","pacman"]`；`npm run dist:linux` 直接调 `electron-builder --linux` |
| 依赖清单 | `build.pacman.depends` 27 项 Arch 包名，覆盖 electron-builder 内置的失效默认清单（见 `docs/Usage/LINUX_PACKAGING.md`） |
| 安装钩子 | `build.pacman.afterInstall` → `electron/scripts/after-install.sh`（KDE 图标主题 symlink 修复） |
| 产物守卫 | `npm run verify:package` → `scripts/check-package-deps.ts`，比对 `dist-electron` require 闭包与 asar 内容 |

### 2.2 关键机制核实（读源码 + 实测，非推测）

1. **`|` 替代语法可用**（实测）：`fpm -s dir -t deb --depends "libgtk-3-0 | libgtk-3-0t64"` →
   control 文件 `Depends: libgtk-3-0 | libgtk-3-0t64`。Debian 依赖关系原生支持 `|`，是同时兼容
   Ubuntu 24.04+ t64 改名与 Deepin/Debian 旧包名的标准做法。
2. **electron-builder 内置默认依赖清单不可用**：deb 默认清单缺 `libasound2` / `libcups2` /
   `libatk1.0-0`，且含本项目未使用的 `libxss1` / `libuuid1` / `libsecret-1-0`（与 pacman 清单的
   取舍规则冲突）。必须像 pacman 一样显式覆盖。
3. **自定义 `depends` 是整体替换**（`FpmTarget.js:185-198`），不是合并。
4. **`afterInstall` 会整体替换 electron-builder 内置模板**（`FpmTarget.js:68`）。内置
   `after-install.tpl` 承担 4 件对 deb 关键的事：`/usr/bin/<exe>` 软链、chrome-sandbox SUID 回退、
   desktop/mime 库刷新、**AppArmor profile 安装（Ubuntu 24+ 必需）**。
   → 现状 pacman 包已因此丢失上述 4 项（实测 `release/pomreader-1.0.0.pacman` 内
   `opt/白虎阅读/chrome-sandbox` 权限为 `0755`，包内无 `/usr/bin`）。
5. **AppArmor 是 Ubuntu 24+ 的硬需求**：Ubuntu 24.04 默认 `apparmor_restrict_unprivileged_userns=1`，
   未安装 profile 的 Electron 应用无法创建 user namespace。electron-builder 已在
   `linux-unpacked/resources/apparmor-profile` 内生成 profile。
6. **无 native module**（实测）：asar 内仅 `adm-zip / iconv-lite / pouchdb-browser / safer-buffer /
   spark-md5 / uuid / valibot / vuvuzela`，全部纯 JS → **跨架构打包安全**，无需交叉编译。
7. **`build.linux.maintainer` 已被 deb 继承**（`FpmTarget.js:164` → `meta.maintainer`），
   无需为 deb 单独设置。
8. **t64 改名范围**（查 Ubuntu noble 包索引实证）：`libgtk-3-0t64` / `libatk1.0-0t64` /
   `libatk-bridge2.0-0t64` / `libatspi2.0-0t64` / `libglib2.0-0t64` / `libcups2t64` /
   `libasound2t64` 共 7 个；`libpango-1.0-0` / `libcairo2` / `libx11-6` / `libxcb1` 等**未**改名。
9. **fpm 保留脚本自身 shebang**：生成的控制脚本首行为 `#!/bin/bash`（非 `#!/bin/sh`），
   故 `after-install.sh` 里的 bashism（进程替换）安全。
10. **electron-builder 自带 fpm**（`~/.cache/electron-builder/fpm@2.1.4`），构建 deb **不依赖**
    系统 `fpm` / `dpkg-deb`；`dpkg-deb` 仅用于产物校验（可选）。

## 3. 详细任务拆解与具体改动

| # | 子任务 | 具体改动 | 状态 |
| --- | --- | --- | --- |
| T-1 | 扩展安装钩子 | `electron/scripts/after-install.sh` 增加「Electron 运行时必需项」段：`/usr/bin/${executable}` 软链、chrome-sandbox 权限回退、AppArmor profile 安装、desktop/mime 库刷新。与内置 `after-install.tpl` 语义对齐 | ✅ |
| T-2 | 新增 deb 配置 | `package.json` `build.deb`：`depends`（28 项 Debian 包名，含 7 处 t64 替代）、`packageCategory`、`recommends: []`、`afterInstall` 指向 T-1 的钩子 | ✅ |
| T-3 | 一键打包脚本 | 新增 `scripts/build-linux.sh`：`--distro/--arch/--appimage/--skip-build/--keep-going`，发行版自动识别、逐目标独立输出目录、deb 产物去重、打包结果表 + 安装指引 + 依赖回显 | ✅ |
| T-4 | npm 入口 | `package.json` scripts：`dist:linux` 指向新脚本；新增 `dist:linux:manjaro` / `:deepin` / `:ubuntu` / `:generic` / `:all` | ✅ |
| T-5 | 实测验证 | 实跑 pacman / deb / tar.gz 打包；用 `dpkg-deb -I` 校验 deb 的 `Depends`、`ar` + `tar` 校验 control/postinst；用 `tar -xf` 校验 pacman 的 `.PKGINFO` 与 `.INSTALL`；构造失败路径验证 `--keep-going` 行为 | ✅ |
| T-6 | 文档同步 | `docs/Usage/LINUX_PACKAGING.md` 重写（四目标产物表 / 一键用法 / deb 依赖与 t64 对照 / Arch↔Debian 对照 / afterInstall 替换语义 / AppArmor / SUID 权衡 / 交叉架构验证边界）；`README.md` 打包章节同步；`docs/Task/README.md` 索引登记 | ✅ |

### 3.1 文档改动清单（文件级）

| 文件 | 改动 |
| --- | --- |
| `docs/Usage/LINUX_PACKAGING.md` | 重写：四目标产物表、一键打包用法与参数表、deb 依赖清单与 t64 改名对照、Arch↔Debian 包名对照、`afterInstall` 整体替换内置模板的坑、AppArmor 说明、SUID 权衡、交叉架构验证边界 |
| `README.md` | 「打包与发布」新增「Linux（一键，四个发行版目标）」小节（命令表 + 产物表 + 参数表 + 依赖清单/AppArmor 说明）；「其它平台」小节去掉已改用途的 `dist:linux`；§项目结构 的 scripts 行补两个打包脚本 |
| `docs/Task/README.md` | Active Tasks 索引登记本任务 |
| `docs/Task/Active/LINUX_MULTI_DISTRO_PACKAGING_PLAN.md` | 本文档 |

### 3.2 `build.deb.depends` 完整清单（28 项）

```
libasound2 | libasound2t64          libatk-bridge2.0-0 | libatk-bridge2.0-0t64
libatk1.0-0 | libatk1.0-0t64        libatspi2.0-0 | libatspi2.0-0t64
libcairo2                            libcups2 | libcups2t64
libdbus-1-3                          libexpat1
libgbm1                              libglib2.0-0 | libglib2.0-0t64
libgtk-3-0 | libgtk-3-0t64          libnotify4
libnspr4                             libnss3
libpango-1.0-0                       libpulse0
libudev1                             libx11-6
libxcb1                              libxcomposite1
libxcursor1                          libxdamage1
libxext6                             libxfixes3
libxkbcommon0                        libxrandr2
hicolor-icon-theme                   xdg-utils
```

与 `build.pacman.depends`（26 项 Arch 包名）一一对应：`at-spi2-core` 在 Debian 系拆成 3 个包
（`libatk1.0-0` / `libatk-bridge2.0-0` / `libatspi2.0-0`），故 26 → 28。

### 3.3 回滚方案

| 场景 | 回滚路径 |
| --- | --- |
| 新钩子在 pacman 上回归 | `git revert` 本次提交 → 重新执行 `npm run dist:linux:manjaro` → 重新分发（约 3 分钟；构建产物可回退到改动前的 `release/linux-manjaro/pomreader-1.0.0.pacman`） |
| deb 依赖清单在某发行版解不开 | 改 `package.json` `build.deb.depends` 单项 → `npm run dist:linux:ubuntu`（约 1 分钟） |
| 脚本本身有缺陷 | `git revert` 或直接回退 `scripts/build-linux.sh`，`npm run dist:linux` 的旧路径（`electron-builder --linux`）仍可用 |

**回滚前提**：所有改动以单次原子提交落地（Conventional Commits + OMC trailer block），
不做分批提交，便于整体 `git revert`。本次会话**未执行 commit** —— 按项目约定，
提交需用户在当前会话明确下达指令后由 agent 执行。

### 3.4 交叉架构的验证边界（明确不做的事）

- 交叉架构产物（arm64 / armv7l / ia32 在 x64 宿主上打包）**只做元数据验证**
  （`dpkg-deb -I` / `tar tf`），**不做运行时启动验证**。
- 运行验证需对应架构真机（或 qemu-user-static 模拟环境），本次未覆盖。
- asar 内 8 个运行时依赖全为纯 JS，无 native module，故不存在 ABI 不匹配问题；
  但 Chromium 二进制本身按目标架构下载，架构正确性由 electron-builder 保证。


## 4. 预期效果与验收标准

### 4.1 预期效果

```bash
bash scripts/build-linux.sh                      # 按当前发行版自动选择
bash scripts/build-linux.sh --distro manjaro     # → release/linux-manjaro/*.pacman
bash scripts/build-linux.sh --distro deepin      # → release/linux-deepin/*.deb
bash scripts/build-linux.sh --distro ubuntu      # → release/linux-ubuntu/*.deb
bash scripts/build-linux.sh --distro linux       # → release/linux-generic/*.tar.gz
bash scripts/build-linux.sh --distro all         # 以上全部
```

### 4.2 验收标准

- AC-1 `bash scripts/build-linux.sh --help` 输出与 mac 脚本同风格的中文用法。
- AC-2 四个发行版目标各自产出独立目录，产物互不覆盖。
- AC-3 deb 的 `Depends` 同时含 t64 与旧包名替代项；`dpkg-deb -I` 可读。
- AC-4 pacman 的 `.PKGINFO` `depend` 行数与 `package.json` `build.pacman.depends` 一致。
- AC-5 deb 的 postinst 含 AppArmor profile 安装逻辑（Ubuntu 24+ 可启动）。
- AC-6 `npm run verify:package` 在脚本中执行且通过。
- AC-7 现有 `npm run dist:mac*` 行为不受影响。
- AC-8 `npm run format:check` 与 `npm run lint` 通过。

## 5. 风险评估与缓解措施

| 风险 | 等级 | 缓解 |
| --- | --- | --- |
| 改 `after-install.sh` 影响既有 pacman 安装 | 中 | 仅**追加**不改既有逻辑；重建 pacman 包并 diff `.INSTALL` 验证无回归 |
| deb 的 `Depends` 在某发行版解不开 | 中 | 用 `|` 替代覆盖 t64 改名；未改名的包用旧名（Debian/Deepin 全系存在） |
| Ubuntu 24+ 无法启动（缺 AppArmor） | 高 | T-1 补齐 profile 安装；AC-5 校验 |
| 跨架构产物运行期崩溃 | 低 | 实测 asar 内无 native module（§2.2-6） |
| AppImage 构建依赖外部下载失败 | 中 | `--appimage` **显式开关**，默认关闭；失败仅告警不致命 |
| `deb` 与 `pacman` 重复构建浪费时间 | 低 | `--distro all` 时 deb 只构建一次，产物复制到 deepin / ubuntu 两个目录 |

## 6. 实施顺序与依赖关系

```
T-1 (钩子) ─┬─> T-2 (package.json build.deb) ─> T-3 (脚本) ─> T-5 (实测)
             └─> T-4 (npm scripts) ────────────┘         │
                                                          └─> T-6 (文档)
```

T-1 必须先于 T-2（`build.deb.afterInstall` 指向该文件）；T-2/T-4 必须先于 T-3/T-5（脚本依赖配置）。

## 7. External Review Opinion

### Round 1/10 — 需求分析（provider=coding-bridge，kind=requirement）

**VERDICT**: NEEDS_CHANGES

审查提出的 P0/P1 项与本任务事实基线的对应处置：

| 审查意见 | 处置 | 依据 |
| --- | --- | --- |
| P0-1 `\|` 替代语法未实证 | ✅ 已实证 | 实跑 fpm：`Depends: libgtk-3-0 \| libgtk-3-0t64`（§2.2-1） |
| P0-2 `deb.depends` 必须用数组 | ✅ 采纳 | `build.deb.depends` 用数组，每项可含 `\|` |
| P1-1 AppImage 过度设计 | ✅ 采纳 | 降级为 `--appimage` 显式开关，默认关闭 |
| P1-2 `after-install.sh` POSIX 兼容 | ✅ 已消解 | fpm 保留脚本自身 `#!/bin/bash` shebang，bashism 安全（§2.2-9） |
| P1-3 跨架构 native module | ✅ 已消解 | asar 内 8 个依赖全为纯 JS（§2.2-6） |
| P1-4 缺 Linux preflight | ✅ 采纳 | 新增：Linux 平台校验、electron-builder 存在性、Node 版本、发行版识别 |
| P2-1 `--distro all` 重复构建 deb | ✅ 采纳 | deb 构建一次，产物复制到两个发行版目录 |
| P2-2 `verify:package` 粒度 | ✅ 采纳 | 移到构建后执行一次，非逐发行版 |
| P2-3 deb `maintainer` | ✅ 已消解 | `build.linux.maintainer` 已被 deb 继承（§2.2-7） |
| P2-4 文档同步范围 | ✅ 采纳 | T-6 覆盖 LINUX_PACKAGING.md / README / 任务索引 / 本文档 |
| mac 脚本不宜照搬的部分 | ✅ 采纳 | 不实现 `--universal`、不做签名/公证、不做 dmg 产物列举；改用 `--linux` 与发行版维度 |

**新增自查发现（审查未覆盖）**：审查未察觉 `afterInstall` 会**整体替换** electron-builder 内置
`after-install.tpl`，从而使 deb 丢失 AppArmor profile 安装（Ubuntu 24+ 启动硬需求）与
chrome-sandbox SUID 回退（§2.2-4）。本任务 T-1 专门补齐该缺口，并同步修复既有 pacman 包的同一缺口。

### Round 2/10 — 实施方案（provider=coding-bridge，kind=plan）

**VERDICT**: APPROVE WITH CONDITIONS（评审未输出标准 verdict 行，按协议 fail-closed 记为 NOT_APPROVED，
按其条件项逐条处置后复审）

评审提出的 14 项与本任务事实基线的对应处置：

| 评审意见 | 处置 | 依据 |
| --- | --- | --- |
| 🔴 R1 共享 hook 同时服务 pacman 与 deb 的调度签名语义错配 | ✅ 已消解 | 钩子**不读取任何位置参数**且每步幂等，对 `post_install()` 与 `postinst configure <old_ver>` 两套签名均安全；已在钩子头部写明该约定 |
| 🔴 R2 缺回滚方案 | ✅ 已采纳 | 新增「§3.3 回滚方案」，含 hook 回归 / 依赖解不开 / 脚本缺陷三条路径 |
| 🔴 R3 AppArmor 缺 `apparmor_parser` 存在性 guard | ✅ 已具备 | 实现里已有 `command -v apparmor_parser` + `command -v apparmor_status` 双重 guard（评审读的是计划文本，未看到代码） |
| 🔴 R4 `--distro all --arch all` 失败语义不明确、无 summary | ✅ 已采纳 | 新增「打包结果」表：逐 (distro/arch) 列出 状态 ✓/✗ + 产物路径 + 体积；失败目标另在结尾汇总 |
| 🟡 R5 交叉架构仅构建不验证的边界未声明 | ✅ 已采纳 | 「§3.4 交叉架构的验证边界」+ LINUX_PACKAGING.md「交叉架构的验证边界」 |
| 🟡 R6 chrome-sandbox SUID 权衡未文档化 | ✅ 已采纳 | 实现本就「按需 SUID」（仅无 userns 时）；LINUX_PACKAGING.md 新增「chrome-sandbox 的 SUID 权衡」说明 CVE 面与四目标发行版实际走 0755 分支 |
| 🟡 R7 文档改动清单缺失 | ✅ 已采纳 | 「§3.1 文档改动清单（文件级）」 |
| 🟡 R8 未列出 28 项 depends 清单 | ✅ 已采纳 | 「§3.2 `build.deb.depends` 完整清单（28 项）」 |
| 🟡 R9 deepin/ubuntu 同名文件易混淆 | ➖ 不采纳 | 输出目录本身即标签（`release/linux-deepin` vs `release/linux-ubuntu`），且「安装方式」段按发行版分别给出命令；再加标记文件属冗余 |
| 🟡 R10 缺 OS guard | ✅ 已具备 | 脚本前置检查已有 `[ "$(uname -s)" = "Linux" ] || die ...`（评审读的是计划文本） |
| 🟢 R11 版本号递增策略 / R12 sha256 manifest / R13 CI 矩阵 / R14 xvfb 启动级 smoke test | ➖ 本期不做 | 均为独立立项的增量能力，不在「一键打包脚本」范围内；已记入下节「遗留项」 |

### Round 3/10 — 代码复审（provider=coding-bridge，kind=code）

**VERDICT**: APPROVED

复审确认：Round 2 的 7 项缺陷全部真正修复，未引入新缺陷。逐项复核了修复中最易出错的构造
（`_arg` 的 shift + 前插重解析、`local` 数组在 `set -u` 下的行为、三个并行数组的同步性、
`&&` 链的退出码、`su -s /bin/bash -` 的参数顺序、`|| continue` 的作用域、`*"$ext"` 的引号 glob），
并确认失败路径产出正确的 FAIL 行 + FAILED 数组 + 退出码 1。

## 8. 验收结果

| 验收标准 | 结果 | 证据 |
| --- | --- | --- |
| AC-1 `--help` 输出与 mac 脚本同风格的中文用法 | ✅ | `bash scripts/build-linux.sh --help` |
| AC-2 四个发行版目标各自产出独立目录，产物互不覆盖 | ✅ | `release/linux-{manjaro,deepin,ubuntu,generic}/` |
| AC-3 deb 的 `Depends` 同时含 t64 与旧包名替代项 | ✅ | `dpkg-deb -I` 输出 28 项，含 7 处 `|` |
| AC-4 pacman `.PKGINFO` depend 行数与 `build.pacman.depends` 一致 | ✅ | 26 行，逐项一致 |
| AC-5 deb postinst 含 AppArmor profile 安装逻辑 | ✅ | `ar x` + `tar xf control.tar.xz` 可见 profile 安装段，且 `${executable}`→pomreader、`${sanitizedProductName}`→白虎阅读 已替换 |
| AC-6 `npm run verify:package` 在脚本中执行且通过 | ✅ | 脚本「3/3 校验打包依赖闭包」步骤 |
| AC-7 现有 `npm run dist:mac*` 行为不受影响 | ✅ | 仅修 `--arch=` 解析 P0，其余未动 |
| AC-8 `npm run format:check` 与 `npm run lint` 通过 | ✅ | Prettier 全绿；ESLint 0 errors / 0 warnings |

### 8.1 实测记录

| 场景 | 结果 |
| --- | --- |
| `bash scripts/build-linux.sh --distro all --skip-build` | exit 0，206s，四目标全绿 |
| 失败路径（把 electron-builder 调用替换为 `false` + `--keep-going`） | 四个目标全显示 ✗，结尾打印失败目标列表，exit 1 ✅ |
| 等号形式参数 `--distro=manjaro --arch=x64` | 解析正确 |
| `bash scripts/build-mac.sh --arch=arm64` | 参数解析正确，抵达平台守卫（此前报「未知参数 'arm64'」） |
| 宏替换审计 | `${...}` 仅 {APP_DIR, APP_ID, executable, sanitizedProductName, SUDO_USER:-, theme_dir, user_home}，误替换风险 0 |

### 8.2 附带修复（超出本任务范围但属同一根因）

`scripts/build-mac.sh` 的 `--arch=` 等号形式解析存在**同一 P0 缺陷**
（`set -- --arch "$ARCH_FLAG" "$@"; shift` 会把原参数重复入队）。
用户需求即为「检查 scripts/build-mac.sh」，故一并修复，1 行改动。

## 8.5 追问回合：「不带参数产出什么？能否直接打成当前系统可用的产物？」

### 结论

| 问题 | 答案 |
| --- | --- |
| 不带参数产出什么？ | 按 `/etc/os-release` 自动识别发行版，只打当前架构。**本机（Manjaro）→ `release/linux-manjaro/pomreader-1.0.0.pacman`**（实测 32s，含前端构建） |
| 能直接打成当前系统可用的产物吗？ | Manjaro/Arch 系 → `.pacman` ✅、Ubuntu/Deepin/Debian 系 → `.deb` ✅、其它发行版 → `.AppImage` ✅。实测 `pacman -U --print` exit 0（26 项依赖在本机全部可解析） |

### 本回合发现并修复的三个问题

1. **通用 `linux` 目标原本不能算「装完即用」** —— `.tar.gz` 只是裸目录
   （实测无 `.desktop`、无图标、无 `/usr/bin` 软链），解压到 `/opt` 后还得自己造桌面项。
   → 通用目标改为**默认同时产出 `.AppImage`**：单文件 ELF，自带 `.desktop`
   （`Exec=AppRun --no-sandbox %U`）与全套 hicolor 图标（16~512 共 8 种尺寸），
   双击即跑并自动出现在应用菜单。AppImage 工具链已本地缓存
   （`~/.cache/electron-builder/appimage-12.0.1`），可离线构建。实测产物
   `白虎阅读-1.0.0.AppImage`（127M）为合法 ELF 可执行文件。
   实现上改为**单次 electron-builder 调用**多 target（`--linux tar.gz AppImage`），
   比原先「两次调用」少一轮打包（165s vs 193s）。

2. **脚本头注释里 deb 的产物名写错了** —— 原写 `pomreader-1.0.0.deb`，
   实际 fpm 产出的是 `pomreader_1.0.0_amd64.deb`（fpm 的 `<name>_<version>_<arch>` 命名）。
   hexdump 逐字节核对后修正（仿写 mac 脚本风格时把错误也带了过来）。

3. **`--appimage` 对 deb 目标实际被跳过** —— 代码里 `! distro_is_deb "$distro"` 直接排除了 deb，
   与帮助文本「为 manjaro / deb 目标也追加 AppImage」矛盾。
   → 去掉排除条件；复用分支同时复制 `.deb` 与 `.AppImage`；复用分支补 `rm -rf "$outdir"`
   避免残留旧产物。

### 本回合新增的验证

| 验证项 | 结果 |
| --- | --- |
| `bash scripts/build-linux.sh`（零参数，全流程） | exit 0，32s，产出 pacman 包 |
| `pacman -U --print release/linux-manjaro/*.pacman` | exit 0 —— 依赖在本机全部可满足 |
| `bash scripts/build-linux.sh --distro linux --skip-build` | exit 0，165s，单次调用同时产出 tar.gz + AppImage |
| AppImage 有效性 | `file` → ELF 64-bit 可执行；`--appimage-extract` 可见 `.desktop` + 8 种尺寸图标 |
| AppImage 内 desktop 项 | `Exec=AppRun --no-sandbox %U` / `Icon=pomreader` / `Categories=Office;` |
| `--distro all --appimage`（最复杂路径） | exit 0，231s；manjaro/deepin/linux 各在自己的目录产出 `.deb`/`.pacman`/`.tar.gz` + `.AppImage`；ubuntu 复用路径同时复制了 `.deb` 与 `.AppImage` |

### 本回合外部复审（Round 4/10，kind=code）

**VERDICT**: APPROVED

逐一验证了 7 个焦点项：故意不加引号的 `$target` 分词（值全为硬编码字面量、无 glob 字符、
`--$arch` 以 `--` 开头不会被 yargs 吞入数组）、`distro_is_deb` 双用途在 `set -e` 下的安全性
（两处均在 `if` 条件位置）、复用路径 `rm -rf "$outdir"` 的目的地/源地不碰撞（guard 先于 rm）、
空 glob 的 `cp` 不产生残留文件、`local copied=()` 在 `set -u` 下的行为、
以及 6 种 AppImage 产出路径的完整性（不存在「请求了但没产出或没列出」的路径）。

另确认 `Exec=AppRun --no-sandbox %U` 是 **electron-builder 生成的默认值**，非本项目可控 ——
属 AppImage 生态的已知妥协，不构成本轮引入的缺陷。

## 8.6 追问回合 2：「检查 build-mac 的生成产物，也要 arm/amd/通用，不带参数只出当前系统的」

### 改动

| # | 改动 | 说明 |
| --- | --- | --- |
| M-1 | `build-mac.sh` 默认架构改为**当前机器** | 原默认是 x64 + arm64 两份 dmg；现默认只出当前架构。宿主检测（含 Rosetta 识别）原本在默认赋值**之后**，已把默认赋值移到检测之后 |
| M-2 | `--arch all` 语义扩展为 x64 + arm64 + **universal** | `ALL_ARCHES=("x64" "arm64" "universal")` |
| M-3 | `build-mac.sh` 补 `verify:package` 校验 | 原脚本完全没有这个守卫（Linux 侧有） |
| M-4 | `build-linux.sh` 把 `verify:package` 从**打包前**移到**打包后** | `check-package-deps.ts` 按 `release/**` 取 mtime 最新的 app.asar；打包前跑校验的是上一轮旧产物，永远验不到本次结果。修正后与项目自带 `npm run dist` 的顺序一致（`electron-builder && verify:package`） |
| M-5 | 新增 `dist:mac:all` npm 脚本 | — |

### 产物命名验证（实测 electron-builder 日志）

```
--arch x64       → building target=DMG arch=x64      file=release/mac-x64/pomreader-1.0.0-mac-x64.dmg
--arch arm64     → building target=DMG arch=arm64    file=release/mac-arm64/pomreader-1.0.0-mac-arm64.dmg
--arch universal → release/mac-universal/pomreader-1.0.0-mac-universal.dmg
```

零参数实测：`目标架构 x64` → 只打一个（改动前是 `x64 arm64` 两个）。

`.app` bundle 校验（x64 目标产出）：`Contents/MacOS/白虎阅读` 为 `Mach-O 64-bit x86_64 executable`；
`Info.plist` 含 `CFBundleIdentifier=com.baihu.reader` / `CFBundleIconFile=icon.icns` /
`CFBundleShortVersionString=1.0.0` / `LSMinimumSystemVersion=13.0`；`Contents/Resources/app.asar` 就位。

### macOS 平台守卫的必要性（实测）

| 环节 | 在 Linux 上的结果 |
| --- | --- |
| `.app` bundle 打包 | ✅ 可完成（Electron 运行时按目标架构下载） |
| DMG 制作 | ❌ `sips process failed ENOENT` —— `sips` 是 macOS 专有图像工具 |
| universal 合并 | ❌ `@electron/universal is only supported on darwin platforms` |
| 代码签名 / 公证 | ❌ `skipped macOS application code signing reason=supported only on macOS` |

→ 脚本开头 `[ "$(uname -s)" = "Darwin" ]` 的硬性守卫**必要**，不可放宽。

### 本回合外部复审（Round 5/10，kind=code）

**VERDICT**: NEEDS_CHANGES —— 5 项（P1 状态表 `summary` 的 `-` 占位符泄漏成前缀；P2 全失败时
`verify:package` 会校验上轮残留 asar；P3 多目标只校验最新 asar；P4 循环变量 `dmg` 名不副实；
P5 宿主架构无法识别时未拦截）。

5 项全部处置：
- P1：`summary=""` 初始化 + 循环后 `summary="${summary:--}"` 兜底。**先复现确认**（输出确为
  `-, /tmp/a.dmg (85M)`）再改。
- P2：两个脚本各加「全部失败则跳过校验并 die」守卫。
- P3：在脚本注释中写明「按 mtime 取最新 asar」的已知限制。
- P4：循环变量改名 `artifact`。
- P5：宿主架构 `*)` 分支改为 `die`。

### Round 6/10 — 代码复审（Round 5 的整改复审）

**VERDICT**: APPROVED

逐项确认 5 项修复正确、无新引入问题：`${summary:--}` 无运算符歧义；两个 all-fail 守卫的算术与
`set -euo pipefail` 交互正确；Linux 侧 `${#DISTROS[@]} * ${#ARCHES[@]}` 的计数与「ubuntu 复用
deepin 的 deb 但仍计为一个目标」一致；mac 侧平台守卫先于架构 `die`，非 macOS 不会到达；
守卫与末尾 FAILED 摘要块的退出顺序不冲突。

## 9. 经验总结
1. **electron-builder 的 `afterInstall` 是「整体替换」而非「追加」** —— 这是本任务最大的隐性坑。
   项目原本的 pacman 钩子已经因此丢失了 `/usr/bin` 软链、chrome-sandbox SUID 回退与
   AppArmor profile 安装。后者对 Ubuntu 24.04 是**启动硬需求**
   （`apparmor_restrict_unprivileged_userns=1`），不做则应用装得上、起不来。
   → 凡是自定义 `afterInstall`，必须逐条对照内置 `after-install.tpl` 补齐。
2. **Debian 的 `|` 依赖替代语法是跨 Ubuntu 版本分发 deb 的正解** —— 不必为 Ubuntu 24.04+
   与旧版分别维护依赖清单；一个 `.deb` 同时覆盖 Deepin / Ubuntu / Debian。
3. **依赖清单要按「谁在链接」推导，而不是照抄 electron-builder 默认值** ——
   默认清单既缺项（`libasound2` / `libcups2` / `libatk1.0-0`）又多项
   （`libxss1` / `libuuid1` / `libsecret-1-0`），且不含任何发行版特有信息。
4. **「检查 X 并仿写 Y」的任务里，X 自身往往也有缺陷** —— `build-mac.sh` 的参数解析 bug
   是本次唯一的意外收获；只仿写不检查会把 bug 复制到新脚本。
5. **审查产出的 P0 必须复现后再修** —— 本次先写了最小复现脚本确认 `--arch=` 形式确实崩溃，
   再改；否则容易「修了但没修对」。

## 10. 遗留项（本期不做，已确认独立立项）

见 §7.1 后的「遗留项」表（L-1 ~ L-5）。


## 7.1 Round 1/10 代码审查（provider=coding-bridge，kind=code）

**VERDICT**: NEEDS_CHANGES

| 审查意见 | 处置 | 依据 |
| --- | --- | --- |
| 🔴 P0-1 `--distro=` / `--arch=` 等号形式无法解析 | ✅ 已修 | 实测复现：`set -- --distro "$v" "$@"` 会把原参数重复入队，导致下一轮 `$1` 变成裸值 → `未知参数`。改为 `_arg="${1#*=}"; shift; set -- --distro "$_arg" "$@"`。**同一 bug 在既有 `scripts/build-mac.sh` 中也存在，一并修复**（用户需求即为「检查 build-mac.sh」） |
| P1-2 deb 复用时 `cp` 静默失败仍报成功 | ✅ 已修 | 复制后用 nullglob 校验目标目录确有 `.deb`，否则 `die` |
| P1-3 `loginctl` 取第 2 行作为 session 不可靠 | ✅ 已修 | 改为优先取 active + graphical/x11/wayland 会话，其次取任意 active 会话 |
| P1-4 `kbuildsycoca6` 失败仍打印成功日志 | ✅ 已修 | `su` 成功才打印 reindexed，失败打印 failed (non-fatal) |
| P1-5 `su -` 用目标用户登录 shell，csh/fish 语法不通用 | ✅ 已修 | 显式 `su -s /bin/bash -`（脚本 shebang 即 bash，四目标发行版必装） |
| P2-6 `shopt -s nullglob` 未恢复 | ✅ 已修 | 每段 glob 后 `shopt -u nullglob` |
| P2-7 `ID_LIKE=*debian*` 退回 tar.gz 而非 deb | ✅ 已修 | Debian 系（含 Mint / Pop!_OS）统一走 deb 路径；`detect_distro` 注释写明该映射 |
| 关注点 1 shell 正确性 / 关注点 3 deb 去重 / 关注点 4 `rm -rf` 安全 / 关注点 5 `set -e` 交互 / 关注点 6 宏替换风险 / 关注点 7 Debian 特有项 | ✅ 确认无缺陷 | 逐条复核通过；宏审计 0 违规（全部 `${...}` 或含下划线或是两个已知宏） |

## 8. 遗留项（本期不做，已确认独立立项）

| 项 | 内容 |
| --- | --- |
| L-1 | CI 多发行版 docker matrix（GitHub Actions） |
| L-2 | 每个产物目录生成 `MANIFEST.sha256`，便于发布对账 |
| L-3 | 安装后启动级 smoke test（xvfb-run 实启窗口），取代当前的元数据级验证 |
| L-4 | 跨架构产物在真机 / qemu-user-static 下的运行验证 |
| L-5 | 版本号递增策略与 git short-sha 注入 |


## 8. 验收结果与经验总结

（任务完成后回填）
