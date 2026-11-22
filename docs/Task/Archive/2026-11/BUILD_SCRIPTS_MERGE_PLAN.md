# 打包脚本合并：build-mac.sh + build-linux.sh → build-release.sh

**Status**: ✅ Completed（completion time: 2026-11-22）
**Creator**: Mavis (mvs_9c94f4442652498db97344ee50c39e52)

## 任务目标

把 `scripts/build-mac.sh`（200 行）与 `scripts/build-linux.sh`（395 行）合并为单一入口 `scripts/build-release.sh`，消除「同一条打包流水线被实现两遍」的漂移风险。

硬约束：
- **用户既有命令一字不变** —— `npm run dist:mac` / `dist:mac:x64` / `dist:mac:arm64` / `dist:mac:universal` / `dist:mac:all` / `dist:linux` / `dist:linux:manjaro` / `dist:linux:deepin` / `dist:linux:ubuntu` / `dist:linux:generic` / `dist:linux:all` 共 **11 个** `dist:*` 入口全部保留且语义不变（另加未被本任务触及的 `npm run dist`）
- **产物路径与格式不变** —— `release/mac-<arch>/`、`release/linux-<distro>/` 下的文件名与扩展名逐字不变
- **打包行为不变** —— electron-builder 的目标、参数、依赖清单（package.json 内）、校验步骤、退出码语义全部不变；**终端辅助输出的文案与列宽允许统一**（见「显式豁免」一节）
- **不引入 bash 4+ 要求到 macOS 路径** —— macOS 自带 bash 3.2，当前 mac 脚本刻意避开了 bash 4 特性（`declare -A` 等），合并后必须保持

## 现状分析

### 重复度实测（本次会话实测）

| | 行数 | 去重后公共行 | 独有行 |
|---|---|---|---|
| `build-mac.sh` | 200 | 77 | 45 |
| `build-linux.sh` | 395 | 77 | 150 |

mac 脚本约 63% 与 linux 重复，linux 脚本约 19%。**合并后总行数约 500-530 行，净减仅 ~10%** —— 本任务的价值不是减行数，是消除漂移。

### 已发生的漂移（合并的实证理由）

两脚本实现的是同一条 8 步流水线（参数 → 前置检查 → 构建 → 打包循环 → 产物校验 → 结果报表 → 收尾），而同一概念已出现两套写法：

| 概念 | mac 写法 | linux 写法 |
|---|---|---|
| 产物汇总 | 内联循环，硬编码 `*.dmg` / `*.zip` | `summarize_artifacts` 函数，另一套扩展名集 |
| 全失败守卫 | `[ ${#FAILED[@]} -eq ${#ARCHES[@]} ]` | `[ ${#FAILED[@]} -eq $(( ${#DISTROS[@]} * ${#ARCHES[@]} )) ]` |
| 结果表 | `%-12s` 列宽，内联打印 | `%-16s` 列宽 + 独立的 ARTIFACTS 数组 |
| `--arch=` 解析 | 曾有 P0 缺陷（`set --` 把原参数重复入队），已修 | 写出来时已是正确形态 |

改一次「构建步骤」「校验时机」「`--skip-build` 前置检查」这类跨平台通用逻辑，当前要在两个文件里各改一遍 —— 这是合并的真正理由。

### 合并后仍然必须分叉的部分（平台物理差异，非重复）

1. **维度不同**：mac 是 1 维（arch），linux 是 2 维（distro × arch）+ deb 跨发行版复用（`DEB_SRC` 关联数组）
2. **electron-builder 调用形态不同**：`--mac --<arch>` vs `--linux <target...> --<arch>`（target 是空格分隔多值：`pacman` / `deb` / `"tar.gz AppImage"`）
3. **产物扩展名集合不同**：`.dmg/.zip` vs `.pacman/.deb/.tar.gz/.AppImage`
4. **平台独有开关**：`--distro` / `--appimage` 仅 linux；`universal` 仅 mac
5. **平台独有后处理**：linux 的依赖回显（`dpkg-deb -f` / `tar .PKGINFO`）+ 安装方式；mac 的 dmg 分发提示
6. **主机架构探测**：mac 需识别 Rosetta 转译且未知架构 `die`；linux 认 armv7l/ia32 且未知架构透传
7. **bash 版本要求**：linux 分支需 bash 4+（`declare -A`），mac 分支须兼容 bash 3.2

## 子任务列表

- ✅ T0：引用面清点（`rg` 全仓）+ bash 特性使用点盘点
- ✅ T1：写本计划文档 + 计划评审（外部评审 Round 1/2 NEEDS_CHANGES 已逐条处置，Round 3 APPROVED，Loop CLOSE）
- ✅ T2：实现 `scripts/build-release.sh`（共享流程 + 平台函数组）
- ✅ T3：删除 `build-mac.sh` / `build-linux.sh` + 改 `package.json` 入口 + 文档同步
- 🔄 T4：验证（基线输出比对已过 + linux 分支真机实跑 + mac 分支桩 dry-run + lint/format/测试）
- ⏳ T5：提交推送 + 归档

## 详细改动内容

### T2 · scripts/build-release.sh

**CLI**：
```
bash scripts/build-release.sh                          # 按 uname -s 自动判定平台
bash scripts/build-release.sh --platform mac|linux     # 显式指定（不绕过宿主 OS 守卫）
--arch <x64|arm64|universal|all>      # mac 取值集
--arch <x64|arm64|armv7l|ia32|all>    # linux 取值集
--distro <linux|manjaro|deepin|ubuntu|all>   # 仅 linux
--appimage                                  # 仅 linux
--skip-build / --keep-going / -h|--help
```

**结构**（共享骨架用函数，平台差异用函数组）：

| 函数 | 归属 | 说明 |
|---|---|---|
| `usage()` | 共享 | 读入口脚本头部注释块 |
| `step/info/warn/ok/die` | 共享 | 彩色输出 |
| `parse_args()` | 共享 | 只做**取值收集**与语法校验，不做平台相关校验 |
| `resolve_platform()` | 共享 | `--platform` 缺省按 `uname -s` 判定 |
| `validate_platform_args()` | 共享 | 平台确定后再校验 `--arch` 取值集 / `--distro` / `--appimage` 适用性 |
| `detect_host_arch()` | 共享（内部分支） | mac 认 Rosetta 且未知架构 `die`；linux 认 armv7l/ia32 且未知架构透传 |
| `build_frontend()` | 共享 | `npm run build` + `npm run build:electron`；`--skip-build` 前置校验 |
| `plan_mac()` / `plan_linux()` | 平台 | 展开成**扁平目标清单**（统一掉 1 维 / 2 维差异） |
| `run_targets()` | 共享 | 遍历扁平清单，逐目标打包、记状态、汇总产物 |
| `build_mac_target()` / `build_linux_target()` | 平台 | electron-builder 调用 + linux 的 deb 复用 |
| `summarize_artifacts()` | 共享 | **统一**两套产物汇总实现 |
| `verify_package()` | 共享 | `npm run verify:package` + 全失败守卫 |
| `print_results()` | 共享 | 统一结果表 |
| `report_mac()` / `report_linux()` | 平台 | 分发提示 / 依赖回显 + 安装方式 |
| `finish()` | 共享 | 收尾（耗时 + 退出码） |

**目标清单的扁平化**：两个平台都展开成同构记录 `key|outdir|builder_args|exts|distro|arch`，共享的 `run_targets()` 因此不需要知道平台差异 —— 这是 1 维 / 2 维差异能被共享骨架吸收的关键。

**扁平清单只是「计划」，不是「状态」**：linux 的 deb 复用是跨目标的有状态依赖（`DEB_SRC[arch]`），该状态**由 linux 平台函数组独占**（`declare -A DEB_SRC` 只在 linux 分支内声明），`build_linux_target()` 在执行时读/写它；共享的 `run_targets()` 只负责「按顺序调用平台构建函数 + 记 ok/fail」，对 deb 复用无感知。

**bash 兼容**：`declare -A DEB_SRC` 只在 linux 分支内声明（macOS bash 3.2 路径不执行该行）。

### T3 · 删除旧脚本 + 同步

- 删除 `scripts/build-mac.sh`、`scripts/build-linux.sh`（按 AGENTS.md §7.1 先 `rg` 验证引用面，已完成）
- `package.json`：**11 个** `dist:*` 入口改为 `bash scripts/build-release.sh --platform <p> [...]`；**`npm run dist` 保持不变**（`npm run build && npm run build:electron && electron-builder && npm run verify:package`）—— 它的产物落在 `release/` 根目录，与新脚本的 `release/<platform>-<target>/` 布局不同，改动会破坏既有发布流程
- `README.md`：项目结构树 + macOS / Linux 打包章节的脚本入口
- `docs/Usage/LINUX_PACKAGING.md`：入口脚本引用
- `docs/Task/README.md`：归档条目加现状注记（不改写历史事实）
- `docs/CONVENTIONS.md` §exceptions：死代码删除留痕

## 行为兼容性对照表（合并前 → 合并后）

逐项对照旧脚本源码，确保「打包行为不变」可被审查验证。

| # | 行为点 | 合并前 | 合并后 | 依据 |
|---|---|---|---|---|
| a | `--arch=` / `--distro=` 等号形态 | mac 用 `ARCH_FLAG` 重入，linux 用 `_arg` 重入 | 统一用 `_arg="${1#*=}"`; shift; `set -- --opt "$_arg" "$@"` 形态（linux 现行写法，已无 mac 曾经的 P0 重复入队缺陷） | 旧 mac 的 P0 已在 `f68e199` 前的历史修复中改正，linux 形态即正确形态 |
| b | 架构取值集与报错文案 | mac: `x64 / arm64 / universal / all`；linux: `x64 / arm64 / armv7l / ia32 / all` | **按平台各取一套，报错文案逐字沿用各自的选项列表** | 平台相关的校验**延后**到 `resolve_platform()` 之后执行（因为 `--platform` 可能出现在 `--arch` 之后），文案由平台函数组生成 |
| c | 平台不适用参数 | mac 无 `--distro` / `--appimage`；linux 无 `--platform` 概念 | `--distro` / `--appimage` 在 mac 上 → **报错退出**（不静默忽略）；`--platform` 取值仅 `mac` / `linux` | 静默忽略会让 `--appimage` 看似生效实则无效，比报错更危险 |
| d | 打包失败语义 | mac：失败即 `die`（立即退出）；linux：`build_target` `return 1`，由调用方按 `--keep-going` 决定 | 统一：平台构建函数失败一律 `return 1`；共享 `run_targets()` 统一执行「默认 `die` 中止 / `--keep-going` 记入 FAILED 后继续」。**linux deb 复用路径内部的 `die`（无可复制 .deb）保持硬中止**（旧行为即使带 `--keep-going` 也中止） | 旧 mac 的 die 语义等价于「keep-going=0 时中止」，统一后不丢任何一种语义 |
| e | 全失败守卫 | mac: `FAILED == ARCHES`；linux: `FAILED == DISTROS × ARCHES` | 统一为 `FAILED == 计划目标总数`（扁平清单长度）。deb 复用目标恒为 ok、且仅在前序 deb 构建成功时才进入复用分支，故「复用目标恒 ok」不会让守卫漏判 | 旧两式的语义都是「本轮所有目标都没成功 → 跳过 verify:package」 |
| f | 输出目录创建时机 | mac：`rm -rf` 后交给 electron-builder 建目录；linux：`rm -rf` + `mkdir -p` | 统一为 `rm -rf` + `mkdir -p` | electron-builder 自身也会创建输出目录；差异仅在「构建失败后是否残留空目录」，无语义影响，产物汇总仍返回 `-` |
| g | 宿主架构探测 | mac：Rosetta 转译识别，未知架构 `die`；linux：未知架构原样透传 | 共享函数内部分支，两套规则**逐字保留** | 两个平台的宿主架构语义确实不同，不是重复 |
| h | 默认架构 | 无 `--arch` 时取宿主架构 | 不变（两平台原本就一致） | — |
| i | deb 复用顺序 | `--distro all` 顺序 manjaro → deepin → ubuntu → linux，deepin 构建、ubuntu 复用 | 扁平清单严格按同一顺序生成 | 顺序变了会改变 deb 的构建方与复用方 |
| j | 产物路径 / 文件名 / 扩展名 | `release/mac-<arch>/`、`release/linux-<distro>/` | 逐字不变 | electron-builder 的 `artifactName` 与目录布局由 package.json + `-c.directories.output` 决定 |
| k | electron-builder 实参 | mac: `--mac --<arch> --publish never -c.directories.output=<dir>`；linux: `--linux <targets...> --<arch> --publish never -c.directories.output=<dir>` | 两条平台分支各自逐字保留 | 扁平清单的 `builder_args` 字段承载差异化实参 |
| l | 打包后校验 | 两平台均在全部目标跑完后执行一次 `npm run verify:package`，全失败时跳过 | 不变 | 校验粒度不变（仍是「取最新一个 app.asar」，非逐目标） |
| m | 退出码 | 成功 0；有失败目标 1；前置检查失败 1 | 不变 | — |
| n | 依赖回显 / 安装方式 / 分发提示 | 仅 linux 有；仅 mac 有 dmg 分发提示 | 保留在 `report_linux()` / `report_mac()` | — |

### 显式豁免（允许发生的变更）

以下变更**不属于**「打包行为不变」的约束范围，属于终端辅助输出，已在本节显式声明：

| 豁免项 | 变更 | 理由 |
|---|---|---|
| E-1 | 结果表统一为 linux 的表头样式（`目标 / 状态 / 产物` 三列，`%-16s` 列宽） | mac 原为无表头的两列样式；表格是纯展示层，产物路径与状态判定不受影响 |
| E-2 | `usage()` 文案改为合并后的单入口用法（同时列出两个平台的参数） | 脚本名与入口本就要变（`build-mac.sh` → `build-release.sh`），usage 文本必然变 |
| E-3 | 「所有目标打包均失败」等提示措辞统一 | 同上，纯文案 |
| E-4 | mac 的目标标签仍为纯 arch（如 `x64`），linux 仍为 `distro/arch`（如 `manjaro/x64`） | **不豁免**：刻意保留各平台原有的标签形态，使结果表内容除列宽外不变 |

## 验证矩阵（T4）

### 4.0 合并前基线输出比对（主验证手段）

**做法**：用同一套桩（electron-builder 桩 + mac 的 `uname`/`sysctl` 桩）在合并**前**与合并**后**各跑一次同样的命令，把终端输出归一化后做 diff。

桩与命令组合（已在本轮固化，基线存于 `/tmp/baseline/before.norm.txt`）：

| 场景 | 命令 | 桩 |
|---|---|---|
| mac 全架构 | `PATH=<桩>:$PATH bash scripts/build-release.sh --platform mac --arch all --skip-build` | `uname`→Darwin/x86_64、`sysctl`→0、electron-builder 桩 |
| linux 全发行版 | `bash scripts/build-release.sh --platform linux --distro all --arch x64 --skip-build` | 仅 electron-builder 桩（不加 uname 桩，否则会被 linux 的宿主守卫拦下） |

归一化：把耗时（`总耗时 Ns`、`（Ns 累计）`）与文件体积替换为占位符，滤掉 `npm notice` / node 警告等与本任务无关的噪声行。

**比对判据**：diff 中**只允许**出现下列差异，其余必须逐字一致：

| 允许的差异 | 对应豁免 |
|---|---|
| usage 文案（脚本名从 `build-mac.sh` / `build-linux.sh` 变为 `build-release.sh`，用法合并且列出两个平台参数） | E-2 |
| 结果表的表头与列宽（mac 从「无表头两列」变为「目标/状态/产物 三列 + `%-16s`」） | E-1 |
| 提示措辞（「所有架构打包均失败」→「所有目标打包均失败」等） | E-3 |
| mac 目标标签、linux 目标标签、产物路径与文件名、electron-builder 实参、退出码、依赖回显、安装方式、分发提示 | **不得有任何差异** |

**桩记录的 electron-builder 实参基线**（合并后必须逐字一致）：

```
--mac --x64      --publish never -c.directories.output=release/mac-x64
--mac --arm64    --publish never -c.directories.output=release/mac-arm64
--mac --universal --publish never -c.directories.output=release/mac-universal
--linux pacman   --x64 --publish never -c.directories.output=release/linux-manjaro
--linux deb      --x64 --publish never -c.directories.output=release/linux-deepin
--linux tar.gz AppImage --x64 --publish never -c.directories.output=release/linux-generic
```

其中 **ubuntu 目标不得出现 builder 调用**（复用 deepin 已构建的 deb）——这是 deb 复用语义生效的直接证据。

### 4.1 Linux 分支真机实跑（本机 x86_64 Manjaro）

| 编号 | 命令 / 手段 | 覆盖路径 | 判据 |
|---|---|---|---|
| L1 | `bash scripts/build-release.sh --platform linux --distro manjaro --arch x64` | 发行版识别 → manjaro → pacman 构建 | `release/linux-manjaro/*.pacman` 存在 |
| L2 | `... --distro all --arch x64` | manjaro(pacman) + deepin(deb 构建) + ubuntu(**deb 复用**) + linux(tar.gz+AppImage) | 4 个目录齐全；`release/linux-ubuntu/*.deb` 与 `release/linux-deepin/*.deb` 内容一致（复用证明） |
| L3 | `... --distro manjaro --arch x64 --appimage` | `--appimage` 为 pacman 目标追加 AppImage | manjaro 目录同时含 `.pacman` 与 `.AppImage` |
| L4 | `... --distro ubuntu --arch armv7l` | 交叉架构 + 宿主架构透传分支 | 产出 armv7l 产物 |
| L5 | 临时把 `node_modules/.bin/electron-builder` 换成退出码 1 的桩（`trap` 还原），跑单目标 | 打包失败 → `die` 中止 | 退出码 1，输出含「打包失败」 |
| L6 | 同上 + `--keep-going` | 失败后继续下一个目标 | 失败目标进入 FAILED，结尾有「失败目标」汇总，退出码 1 |
| L7 | 同上 + 多目标全失败 | 全失败守卫 | 触发「跳过产物校验」，**不执行** `verify:package` |
| L8 | L1 之后跑 `... --skip-build` | 跳过构建分支 | 复用 `electron/www` + `dist-electron` 正常打包 |

### 4.2 mac 分支静态审查 + 桩 dry-run（在 Linux 上跑通控制流）

| 编号 | 方法 | 覆盖 |
|---|---|---|
| M1 | `bash -n scripts/build-release.sh` | 语法 |
| M2 | `shellcheck -s bash scripts/build-release.sh`（本机有则跑） | 静态缺陷 |
| M3 | `rg -n 'declare -A\|mapfile\|readarray\|\$\{[A-Za-z_]+,,\}\|\$\{[A-Za-z_]+\^\^\}' scripts/build-release.sh` | 断言命中行**全部**位于 linux 分支内 → bash 3.2 兼容 |
| M4 | PATH 桩 dry-run：临时目录放 `uname`（`-s`→`Darwin`、`-m`→`x86_64`）与 `sysctl`（→`0`），electron-builder 桩按 `-c.directories.output=` 造一个假 `.dmg` 后退出 0；`PATH=桩:$PATH bash scripts/build-release.sh --platform mac --arch all` | mac 分支控制流全跑：3 个架构 → 3 个输出目录 → **断言 builder 实参**为 `--mac --x64` / `--mac --arm64` / `--mac --universal` → 结果表 → 收尾提示 |
| M5 | 同桩 + `--arch universal` | universal 单目标 |
| M6 | 同桩 + `--distro manjaro` | 平台不适用参数报错 |
| M7 | 同桩 + `--arch armv7l` | 架构取值集按平台校验（mac 拒 armv7l，报错文案为 mac 的选项列表） |
| M8 | 文档与提交信息标注 | **真机 macOS 打包未实测**：真机 dmg 产出、Rosetta 转译识别、Developer ID 签名/公证提示均未在 macOS 上验证 |

### 4.3 其它

| 编号 | 手段 | 判据 |
|---|---|---|
| V1 | `npm run lint` | 0 error |
| V2 | `npm run format:check` | 通过（package.json 改动需过 Prettier） |
| V3 | `npm test` | 全绿（脚本改动不触碰 TS） |
| V4 | `rg -n "build-mac\|build-linux" --glob '!node_modules' .` | 仅剩归档文档等历史记录命中 |

## 预期效果和验收标准

- **11 个** `npm run dist:*` 命令的行为与产物**逐字不变**（路径、文件名、扩展名、依赖清单、校验步骤、退出码）
- `npm run dist` 完全未被触及
- 新脚本的 `--help` 输出涵盖两个平台的参数
- linux 分支按 4.1 矩阵实跑通过（真实 electron-builder 打包）
- mac 分支按 4.2 矩阵完成静态审查 + 桩 dry-run，**明确标注真机未实测**
- **合并前后终端输出按 §4.0 做 diff：除 E-1~E-3 的显式豁免外逐字一致**，electron-builder 实参与产物路径逐字一致
- `npm run lint` / `npm run format:check` / `npm test` 全绿
- 未实施/未验证的部分如实记录

## 验收结果

| 验收标准 | 结果 | 证据 |
|---|---|---|
| AC-1 11 个 `npm run dist:*` 入口接线正确 | ✅ | `package.json` 30-40 行全部指向 `scripts/build-release.sh --platform <p>`；`npm run dist` 一字未动 |
| AC-2 §4.0 合并前后输出 diff 只含显式豁免 | ✅ | 归一化 diff 的实质差异**仅 2 处**：mac 结果表样式（E-1）、linux 成功提示补累计耗时（E-3）；6 条 electron-builder 实参逐字一致；**ubuntu 复用目标无 builder 调用** |
| AC-3 L1/L2 linux 真机实跑 | ✅ | `npm run dist:linux:all` → exit 0（manjaro 69s / deepin 96s / **ubuntu 复用** / generic 280s），四目标目录齐全 |
| AC-4 L2 deb 字节一致 | ✅ | 真机产物 `cmp release/linux-deepin/*.deb release/linux-ubuntu/*.deb` → 一致 |
| AC-5 L3 `--appimage` | ✅ | `npm run dist:linux:manjaro -- --appimage` → exit 0；manjaro 目录同时含 `.pacman` + `.AppImage` |
| AC-6 L4 交叉架构 armv7l | ⚠️ **无法完成 —— 上游限制，非脚本缺陷** | Electron 44.4.5 不发布 linux-armv7l 预编译包（`electron-v44.4.5-linux-armv7l.zip` → HTTP 404；arm64 / x64 → 200）。脚本按预期报「ubuntu/armv7l 打包失败」并 exit 1 —— 与旧脚本同构 |
| AC-7 L5-L7 失败路径 | ✅ | L5 单目标失败 → die + exit 1；L6 `--keep-going` 部分失败 → 继续 + 失败汇总 + exit 1；L7 全失败 → 触发「所有目标打包均失败，跳过产物校验」，`verify:package` **0 次执行**，守卫文案与旧脚本逐字一致 |
| AC-8 M1-M8 mac 分支 | ✅ / ⚠️ | M1 `bash -n` 通过；M3 唯一 bash4 特性（`declare -A`）位于 linux 分支内，mac 路径不执行；M4-M7 桩 dry-run 全通过（3 条 mac builder 实参逐字一致、平台不适用参数报错、架构取值集按平台校验）；**M8 真机 macOS 打包未实测** |
| AC-9 V1-V4 | ✅ | lint 0 error；format:check 通过；单测 76 文件 / 1223 用例全绿；引用面仅余归档文档与留痕条目 |
| AC-10 参数校验文案逐字一致 | ✅ | 架构 / 发行版 / 缺值 / 未知参数的报错文案与旧脚本逐字一致（含「 / 」分隔与各平台取值集） |

### 实施过程中发现并修复的问题

| # | 问题 | 发现方式 | 处置 |
|---|---|---|---|
| F-1 | **扁平目标清单的位置参数错位** —— `build_linux_target` 把 `$4`/`$5` 当成 `distro`/`arch`，实际 `$4` 是扩展名集、`$5` 才是 distro、`$6` 才是 arch；导致 `distro_is_deb` 恒假、**deb 复用分支从未触发**，ubuntu 被重复构建 | §4.0 输出级 diff（桩基线对照） | 改为 `local ... exts="$4" distro="$5" arch="$6"`；复跑后 ubuntu 恢复复用，builder 调用数由 6 次降为 5 次（ubuntu 无调用） |
| F-2 | **架构报错文案分隔符不符** —— 合并版输出「x64 arm64 universal」，旧脚本为「x64 / arm64 / universal」 | 报错文案逐字对照 | 拆出 `platform_arch_choices()`，两平台各出一份「 / 」分隔的文案 |
| F-3 | **`usage()` 从子目录调用时读不到头部注释** —— 旧脚本用相对路径 `${BASH_SOURCE[0]}`，脚本 `cd` 到仓库根后相对路径失效 | 代码走查 | 改用脚本绝对路径 `SELF`（旧脚本在 npm 入口下不可见，属潜在缺陷） |

### 外部评审 2 轮（代码级）

| 轮次 | kind | 判定 | 处置 |
|---|---|---|---|
| Round 1/10 | code | ✅ **APPROVED** | 评审确认 bash 3.2 兼容、deb 复用顺序、失败语义、报错文案四项均正确；提 2 条加固建议：`set -e` 下命令替换补 `|| true` 兜底（`detect_distro` / `OS_PRETTY`）、`report_details` 的 `nullglob` 状态用子 shell 隔离 —— **两条均已采纳并落地** |

## 风险评估和缓解措施

| 风险 | 缓解 |
|---|---|
| **mac 分支无法在 Linux 上实测** —— 合并后改错 mac 侧不会被发现 | 4.2 的 PATH 桩 dry-run 覆盖控制流与 builder 实参构造（不等价于真机打包，但能抓住绝大多数接线错误）；逐条对照「行为兼容性对照表」；真机未实测在文档与提交信息中显式标注 |
| 误改 `npm run dist` 的产物布局 | `dist` 保持原样不动，只改 11 个 `dist:*` |
| macOS bash 3.2 不支持 `declare -A` | 该语法只在 linux 分支内声明；M3 机器校验命中行位置 |
| 扁平目标清单改变了 linux 的 deb 复用顺序 | 保持 `manjaro → deepin → ubuntu → linux` 顺序；L2 实跑断言 deepin/ubuntu 的 .deb 内容一致 |
| electron-builder 参数被误改（未加引号的分词） | 参数值全部来自脚本内硬编码字面量 + 已校验的枚举；沿用现有 `SC2086` 注释与写法；M4 断言实参 |
| 旧脚本路径被外部引用 | 已 `rg` 全仓清点：仅 `package.json`、README、LINUX_PACKAGING.md、任务索引（归档文档属历史记录，不改） |
| 失败路径（`--keep-going` / 全失败守卫）难以触发 | L5-L7 用「临时替换 electron-builder 为失败桩 + `trap` 还原」覆盖 |

## 实施顺序和依赖关系

T0 → T1 → T2 → T3 → T4 → T5。

T2 先于 T3（新脚本存在后再删旧的，避免中间态两个脚本都不对）。T4 在 T3 之后跑（验证的是最终形态）。

## 备注

- 本任务是**结构调整**，不带来任何运行时性能收益，不计入性能优化账。
- 归档文档 `docs/Task/Archive/2026-11/LINUX_MULTI_DISTRO_PACKAGING_PLAN.md` 提及旧脚本名 —— 属历史记录，按项目惯例不改写。

## External Review Opinion

### Round 1/10 — 实施方案（provider=coding-bridge，kind=plan，2026-11-22）

**VERDICT**: ⚠️ **NEEDS_CHANGES**

评审提出的 5 项必改与本任务事实基线的对应处置：

| 审查意见 | 处置 | 依据 |
|---|---|---|
| R1 计划中「10 个 `dist:*` 入口」数量错误，应为 11 | ✅ 已修正 | 6 个 `dist:linux*` + 5 个 `dist:mac*` = 11；硬约束、T3、验收标准三处均已改为 11，并补注 `npm run dist` 独立于该计数 |
| R2 未说明合并后如何保留 mac 的 `die` 与 linux 的 `return 1` 差异，以及全失败守卫的等效逻辑 | ✅ 已补 | 「行为兼容性对照表」d / e 两行 + `run_targets()` 的统一失败语义（平台构建函数一律 `return 1`，共享 runner 决定中止或继续）；linux deb 复用路径内部的硬 `die` 保持不变 |
| R3 未说明扁平清单下 deb 复用的状态判定与传递机制 | ✅ 已补 | 「目标清单的扁平化」段明确：扁平清单只是「计划」，`DEB_SRC[arch]` 由 linux 平台函数组独占、在执行时读写，共享 runner 对此无感知；对照表 i 行固定复用顺序 |
| R4 硬约束「打包行为不变」与统一 `print_results` / `usage()` 自相矛盾 | ✅ 已补 | 新增「显式豁免」一节，显式豁免 E-1~E-4（表格列宽与表头、usage 文案、提示措辞），并明确 E-4 不豁免 —— mac 目标标签仍为纯 arch、linux 仍为 `distro/arch`，使结果表内容除列宽外不变；硬约束相应补充「终端辅助输出的文案与列宽允许统一」 |
| R5 验证策略不够具体（缺实跑矩阵与 mac 静态审查项） | ✅ 已补 | 新增「验证矩阵（T4）」：4.1 给出 L1-L8（含 L2 断言 deepin/ubuntu 的 .deb 内容一致以证明复用、L5-L7 用失败桩覆盖 `--keep-going` 与全失败守卫）；4.2 给出 M1-M8（含 PATH 桩 dry-run 断言 electron-builder 实参、bash 4 特性机器校验）；4.3 给出 V1-V4 |

**评审未覆盖但本任务自察补充的 3 项**（一并纳入实施）：

- (b) 平台相关校验必须**延后**到 `resolve_platform()` 之后 —— `--platform` 可能出现在 `--arch` 之后，解析期无法确定架构取值集
- (f) 合并前 mac 的输出目录由 electron-builder 创建、linux 由脚本 `mkdir -p`；统一为 `rm -rf` + `mkdir -p`，差异仅在构建失败后是否残留空目录，已在对照表 f 行与豁免说明中登记
- (j) mac 分支的真机 dmg 产出、Rosetta 识别、签名/公证提示**无法在 Linux 上验证**，M8 要求在文档与提交信息中显式标注

### Round 2/10 — 实施方案复审（provider=coding-bridge，kind=plan，2026-11-22）

**VERDICT**: ⚠️ **NEEDS_CHANGES**（唯一必改项经实证复核为**误判**，不采纳）

Round 1 的 5 项必改，评审逐条确认「✅ 已得到实质性处置」。

**R3 —— deb 复用路径 glob 被包在双引号内 → 复用路径恒 die → L2 前提不成立**：不采纳，理由如下。

评审引用的源码形态为 `cp -f "${DEB_SRC[$arch]}/*.deb" "$outdir"/`（glob 在引号内），**与仓库实际不符**：

```
$ grep -n 'cp -f' scripts/build-linux.sh
260:    cp -f "${DEB_SRC[$arch]}"/*.deb "$outdir"/ 2>/dev/null || true
261:    cp -f "${DEB_SRC[$arch]}"/*.AppImage "$outdir"/ 2>/dev/null || true
```

- glob 位于**引号之外**，bash 会对其做路径名展开；引号内只有目录部分 `${DEB_SRC[$arch]}`
- 工作区与 HEAD 完全一致（`git hash-object scripts/build-linux.sh` == `git rev-parse HEAD:scripts/build-linux.sh` == `2db3cfc0c600d28cbc635fca76084d04dc27d28d`），排除「工作区被临时改过」的可能
- `git log --follow -- scripts/build-linux.sh` 仅有 `4b31cdb`（脚本创建提交）一次命中，`git log -p` 显示该行**自创建起即为此形态**，不存在「后来被改坏」的历史

**实证验证**：把 `node_modules/.bin/electron-builder` 临时替换为桩（`trap` 还原），在本机真机跑现有脚本 `bash scripts/build-linux.sh --distro all --arch x64 --skip-build`：

- 退出码 **0**，未触发「复用 deb 失败」
- `release/linux-ubuntu/pomreader_1.0.0_amd64.deb` 存在，且与 `release/linux-deepin/` 下的 .deb **逐字节一致**（`cmp` 通过）→ 复用路径真实可用
- 桩日志中 linux 侧只有 3 次 builder 调用（pacman / deb / tar.gz+AppImage），**ubuntu 步骤未调用 builder** → 复用语义确认生效

**结论**：R3 不成立。L2 的断言前提在合并前的现有脚本上即成立，验收标准无需修改，也不存在需要修的 bug。

**处置**：不采纳 R3，不改对照表与 L2。转而把「合并前基线输出」固化为验收手段 —— 新增 §4.0（合并前/后输出级 diff），使等价性由**输出比对**证明，而非仅靠逐条断言。该手段同时覆盖了评审关心的「L2 前提是否成立」，且已用现有脚本跑通基线采集（存于 `/tmp/baseline/before.norm.txt`）。

### Round 3/10 — 实施方案复审（provider=coding-bridge，kind=plan，2026-11-22）

**VERDICT**: ✅ **APPROVED**

评审结论三点：

1. **R3 事实判定：确认误判** —— 评审自述 Round 2 的引述「系转述失真」，并逐条采信 grep / `git hash-object` / `git log --follow` / 实证运行四条证据，确认「当前 deb 复用路径可用，L2 前提成立」，不采纳 R3 的处置成立
2. **§4.0 基线输出比对：充分的等价证明手段** —— 评审认为把「行为不变」从逐条断言升级为输出级 diff 是本计划最实质的加固；并确认 §4.0（桩）与 4.1（真机 L1-L8）、4.2（M1-M8）三者分工互补、目标不同不冲突
3. **计划整体一致性：无阻塞性不一致** —— 硬约束、对照表 a-n、豁免 E-1~E-4、验证矩阵、验收标准、风险表之间的交叉引用一致（§4.0 基线实参表 ↔ 对照表 k 行；退出码语义 ↔ 对照表 m 行；deb 复用顺序 ↔ §4.0「ubuntu 不调 builder」）

评审唯一提醒（非阻塞）：基线存于 `/tmp/baseline/before.norm.txt`，T4 时若已被清除可用计划中写死的命令与桩重建。

**Review Loop 状态：CLOSE（Round 3/10 APPROVED，未触发 10 轮上限）**

### Round 1/10 — 代码复审（provider=coding-bridge，kind=code，2026-11-22）

**VERDICT**: ✅ **APPROVED**

评审逐项确认：bash 3.2 兼容（`declare -A` 仅在 linux 分支、bash 3.2 不在解析期报错）、deb 复用顺序（manjaro→deepin→ubuntu→linux，deepin 构建、ubuntu 复用）、失败语义（平台构建函数返回 1，runner 按 `--keep-going` 分流）、报错文案（两平台取值集逐字一致）四项均正确；扁平清单的 `IFS='|'` 字段映射判定为**正确**（`args` 含空格但不含 `|`，`exts`/`distro`/`arch` 依次落位）。

评审提 2 条加固建议，**均已采纳落地**：

| 建议 | 处置 |
|---|---|
| `set -e` 下 `. /etc/os-release` 的命令替换补 `|| true` 兜底（`detect_distro` 两处 + 主流程 `OS_PRETTY` 一处） | ✅ 已改 |
| `report_details` 的 `nullglob` 开关用子 shell 隔离，避免状态外泄 | ✅ 已改（子 shell 内只读不写，无 `die`，安全） |

**Review Loop 状态：CLOSE（Round 1/10 APPROVED，未触发 10 轮上限）**
