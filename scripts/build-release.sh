#!/usr/bin/env bash
#
# scripts/build-release.sh — 一键打包发布版（macOS / Linux 单一入口）
#
# 用法：
#   bash scripts/build-release.sh                      # 按 uname -s 自动判定平台
#   bash scripts/build-release.sh --platform mac       # 显式指定 macOS 分支
#   bash scripts/build-release.sh --platform linux     # 显式指定 Linux 分支
#
#   --arch <x64|arm64|universal|all>          # mac 架构（默认：当前机器架构）
#   --arch <x64|arm64|armv7l|ia32|all>        # linux 架构（默认：当前机器架构）
#   --distro <linux|manjaro|deepin|ubuntu|all> # 仅 linux（默认：自动识别当前发行版）
#   --appimage                                # 仅 linux：为 manjaro / deb 目标追加 AppImage
#   --skip-build                              # 复用已有 electron/www + dist-electron，只重跑打包
#   --keep-going                              # 某一目标失败后继续跑下一个（默认遇错即停）
#   -h | --help                               # 打印本用法
#
# 平台判定：
#   macOS → mac 分支，Linux → linux 分支。--platform 只选择分支，不绕过宿主系统检查：
#   在 Linux 上跑 --platform mac 仍会报「macOS 打包只能在 macOS 上跑」。
#
# macOS 产物（各架构独立目录，文件名带 -mac-<arch> 后缀，分发时不会拿错）：
#   release/mac-x64/pomreader-1.0.0-mac-x64.dmg
#   release/mac-arm64/pomreader-1.0.0-mac-arm64.dmg
#   release/mac-universal/pomreader-1.0.0-mac-universal.dmg
#
# Linux 产物（各发行版独立目录，互不覆盖）：
#   release/linux-manjaro/pomreader-1.0.0.pacman
#   release/linux-deepin/pomreader_1.0.0_amd64.deb
#   release/linux-ubuntu/pomreader_1.0.0_amd64.deb
#   release/linux-generic/pomreader-1.0.0.tar.gz
#   release/linux-generic/白虎阅读-1.0.0.AppImage
#
# 说明：
#   - deepin 与 ubuntu 同为 deb 格式。依赖清单用 Debian 原生的「|」替代语法，同时覆盖
#     Ubuntu 24.04+ 的 t64 改名与 Deepin / Debian 的旧包名，故同一份 .deb 两边通用；
#     --distro all 时 deb 只构建一次，产物复制到两个目录。
#   - 通用 linux 目标默认带 AppImage：tar.gz 只是裸目录（无桌面项、无图标、无软链），
#     不算「装完即用」；AppImage 是单文件 ELF，双击即跑并自带桌面项与全套图标。
#   - 依赖清单统一在 package.json（build.pacman.depends / build.deb.depends）维护，
#     取舍规则与依据见 docs/Usage/LINUX_PACKAGING.md。
#   - macOS 未做 Developer ID 签名与公证，接收方首次打开需右键 →「打开」。
#   - Linux 没有 universal（单文件双架构）产物，--arch 逐架构独立打包。
#
# 交叉编译说明：electron-builder 按目标架构拉取对应 Electron 发行版，打包过程不执行
#   目标二进制，所以 Intel 机器可打 arm64、Apple Silicon 可打 x64，无需对应真机；
#   但「双击运行验证」仍需对应架构的机器。

set -euo pipefail

SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
ROOT="$(cd "$(dirname "$SELF")/.." && pwd)"
cd "$ROOT"

OUT_ROOT="release"

# ── 参数与状态 ────────────────────────────────────────────────────────────
PLATFORM=""
PLATFORM_RAW=""
ARCH_SPEC=""
ARCH_NO_VALUE=0
DISTRO_SPEC=""
DISTRO_NO_VALUE=0
APPIMAGE=0
SKIP_BUILD=0
KEEP_GOING=0

ARCHES=()
DISTROS=()

TARGET_RECORDS=()    # 扁平目标清单："key|outdir|builder_args|exts|distro|arch"
TARGETS=()           # 目标标签
STATES=()            # ok | fail
ARTIFACTS=()         # 产物摘要（文件名 + 体积），失败时为 "-"
FAILED=()

if [ -t 1 ]; then
  C_DIM=$'\033[2m'; C_RED=$'\033[31m'; C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'; C_BLUE=$'\033[34m'; C_BOLD=$'\033[1m'; C_OFF=$'\033[0m'
else
  C_DIM=""; C_RED=""; C_GREEN=""; C_YELLOW=""; C_BLUE=""; C_BOLD=""; C_OFF=""
fi

step() { printf '\n%s▶ %s%s\n' "$C_BLUE$C_BOLD" "$*" "$C_OFF"; }
info() { printf '%s  %s%s\n' "$C_DIM" "$*" "$C_OFF"; }
warn() { printf '%s⚠ %s%s\n' "$C_YELLOW" "$*" "$C_OFF"; }
ok()   { printf '%s✓ %s%s\n' "$C_GREEN" "$*" "$C_OFF"; }
die()  { printf '%s✗ %s%s\n' "$C_RED" "$*" "$C_OFF" >&2; exit 1; }

usage() {
  # 打印文件头注释块（第 1 行 shebang 之后，遇到首个非注释行即停）
  awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' \
    "$SELF" | sed '/^$/d'
}

# ── 平台元数据 ────────────────────────────────────────────────────────────
# 各平台的架构取值集；报错文案与可选值列表逐字沿用各平台旧脚本
platform_arches() {
  case "$1" in
    mac)   printf 'x64 arm64 universal' ;;
    linux) printf 'x64 arm64 armv7l ia32' ;;
  esac
}

# 报错文案用的可选值列表（旧脚本以「 / 」分隔）
platform_arch_choices() {
  case "$1" in
    mac)   printf 'x64 / arm64 / universal' ;;
    linux) printf 'x64 / arm64 / armv7l / ia32' ;;
  esac
}

# 打包格式：manjaro → pacman，deepin / ubuntu → deb，linux → tar.gz + AppImage
# 通用 linux 目标默认带上 AppImage —— tar.gz 只是裸目录（无 desktop 项、无图标、
# 无 /usr/bin 软链），不算「装完即用」；AppImage 是单文件 ELF，双击即跑并自带
# 桌面项与全套 hicolor 图标，任何发行版都直接可用。
distro_target() {
  case "$1" in
    manjaro)         printf 'pacman' ;;
    deepin|ubuntu)   printf 'deb' ;;
    linux)           printf 'tar.gz AppImage' ;;
    *)               die "未知发行版 '$1'" ;;
  esac
}

# 该发行版目标是否产出 deb（用于 deepin / ubuntu 复用同一份 deb）
distro_is_deb() {
  case "$1" in
    deepin|ubuntu) return 0 ;;
    *)             return 1 ;;
  esac
}

# 输出子目录（各发行版互不覆盖）
distro_outdir() {
  case "$1" in
    linux) printf 'linux-generic' ;;
    *)     printf 'linux-%s' "$1" ;;
  esac
}

distro_label() {
  case "$1" in
    manjaro) printf 'Manjaro / Arch 系（.pacman）' ;;
    deepin)  printf 'Deepin（.deb）' ;;
    ubuntu)  printf 'Ubuntu（.deb）' ;;
    linux)   printf '通用 Linux（.tar.gz + .AppImage）' ;;
  esac
}

# 读取 /etc/os-release 推断发行版；无法判定时退回通用 linux 目标。
# Debian 系（Ubuntu / Mint / Pop!_OS / Deepin / Debian …）统一走 deb 格式，
# 依赖清单用 | 替代语法覆盖 Ubuntu 24.04+ 的 t64 改名，故同一份 .deb 通用。
detect_distro() {
  local id="" id_like=""
  if [ -r /etc/os-release ]; then
    # shellcheck disable=SC1091
    id="$(. /etc/os-release 2>/dev/null && printf '%s' "${ID:-}" || true)"
    id_like="$(. /etc/os-release 2>/dev/null && printf '%s' "${ID_LIKE:-}" || true)"
  fi
  case "$id" in
    manjaro|arch|archarm|endeavouros|garuda) printf 'manjaro' ;;
    deepin)                                  printf 'deepin' ;;
    ubuntu)                                  printf 'ubuntu' ;;
    *) case "$id_like" in
         *arch*)                   printf 'manjaro' ;;
         *ubuntu*|*debian*)         printf 'ubuntu' ;;
         *)                        printf 'linux' ;;
       esac ;;
  esac
}

# ── 参数解析 ──────────────────────────────────────────────────────────────
# 解析期只收集取值，平台相关的校验（架构取值集 / --distro / --appimage 适用性）
# 延后到平台确定之后 —— --platform 可能出现在 --arch 之后。
parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --platform)
        [ $# -ge 2 ] || die "--platform 需要参数（mac / linux）"
        PLATFORM_RAW="$2"
        shift 2
        ;;
      --platform=*) PLATFORM_RAW="${1#*=}"; shift ;;
      --arch)
        if [ $# -ge 2 ]; then ARCH_SPEC="$2"; shift 2; else ARCH_NO_VALUE=1; shift; fi
        ;;
      --arch=*)   ARCH_SPEC="${1#*=}"; shift ;;
      --distro)
        if [ $# -ge 2 ]; then DISTRO_SPEC="$2"; shift 2; else DISTRO_NO_VALUE=1; shift; fi
        ;;
      --distro=*) DISTRO_SPEC="${1#*=}"; shift ;;
      --appimage)   APPIMAGE=1; shift ;;
      --skip-build) SKIP_BUILD=1; shift ;;
      --keep-going) KEEP_GOING=1; shift ;;
      -h|--help)    usage; exit 0 ;;
      *)            die "未知参数 '$1'（-h 看用法）" ;;
    esac
  done
}

# --platform 缺省按 uname -s 判定；该函数会 die，故不用命令替换调用
resolve_platform() {
  local p="$PLATFORM_RAW"
  if [ -z "$p" ]; then
    case "$(uname -s)" in
      Darwin) p="mac" ;;
      Linux)  p="linux" ;;
      *)      die "不支持的操作系统 '$(uname -s)'（仅支持 macOS / Linux）" ;;
    esac
  fi
  case "$p" in
    mac|linux) PLATFORM="$p" ;;
    *)         die "未知平台 '$p'（可选：mac / linux）" ;;
  esac
}

# 平台确定后的取值校验：架构集合按平台区分，报错文案逐字沿用各平台旧脚本
resolve_arches() {
  local all choices a
  all="$(platform_arches "$PLATFORM")"
  choices="$(platform_arch_choices "$PLATFORM")"
  if [ "$ARCH_NO_VALUE" -eq 1 ]; then
    die "--arch 需要参数（$choices / all）"
  fi
  if [ -z "$ARCH_SPEC" ]; then
    ARCHES=("$HOST_ELECTRON_ARCH")
    return
  fi
  if [ "$ARCH_SPEC" = "all" ]; then
    for a in $all; do ARCHES+=("$a"); done
    return
  fi
  for a in $all; do
    if [ "$a" = "$ARCH_SPEC" ]; then ARCHES=("$ARCH_SPEC"); return; fi
  done
  die "未知架构 '$ARCH_SPEC'（可选：$choices / all）"
}

# --distro / --appimage 仅 linux 可用；在 mac 上误传直接报错（不静默忽略）
resolve_distros() {
  if [ "$PLATFORM" != "linux" ]; then
    if [ "$DISTRO_NO_VALUE" -ne 0 ] || [ -n "$DISTRO_SPEC" ]; then
      die "--distro 仅支持 --platform linux"
    fi
    if [ "$APPIMAGE" -ne 0 ]; then
      die "--appimage 仅支持 --platform linux"
    fi
    return
  fi
  if [ "$DISTRO_NO_VALUE" -eq 1 ]; then
    die "--distro 需要参数（linux / manjaro / deepin / ubuntu / all）"
  fi
  if [ -z "$DISTRO_SPEC" ]; then
    DISTROS=("$(detect_distro)")
    return
  fi
  case "$DISTRO_SPEC" in
    all)                        DISTROS=("manjaro" "deepin" "ubuntu" "linux") ;;
    linux|manjaro|deepin|ubuntu) DISTROS=("$DISTRO_SPEC") ;;
    *) die "未知发行版 '$DISTRO_SPEC'（可选：linux / manjaro / deepin / ubuntu / all）" ;;
  esac
}

# ── 宿主架构探测 ──────────────────────────────────────────────────────────
# mac 需识别 Rosetta 转译且对未知架构 die；linux 认 armv7l / ia32，未知架构原样透传
detect_host_arch() {
  HOST_ARCH_RAW="$(uname -m)"
  HOST_ARCH="$HOST_ARCH_RAW"
  if [ "$PLATFORM" = "mac" ]; then
    # Rosetta 转译进程下 uname -m 报 x86_64，但真实芯片是 Apple Silicon
    if [ "$HOST_ARCH" = "x86_64" ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = "1" ]; then
      HOST_ARCH="arm64"
    fi
    case "$HOST_ARCH" in
      x86_64|amd64) HOST_ELECTRON_ARCH="x64" ;;
      arm64|aarch64) HOST_ELECTRON_ARCH="arm64" ;;
      *) die "无法识别的宿主架构 '$HOST_ARCH'（仅支持 x64 / arm64）" ;;
    esac
  else
    case "$HOST_ARCH_RAW" in
      x86_64|amd64)   HOST_ELECTRON_ARCH="x64" ;;
      arm64|aarch64)  HOST_ELECTRON_ARCH="arm64" ;;
      armv7l|armv7)   HOST_ELECTRON_ARCH="armv7l" ;;
      i386|i686)      HOST_ELECTRON_ARCH="ia32" ;;
      *)              HOST_ELECTRON_ARCH="$HOST_ARCH_RAW" ;;
    esac
  fi
}

# ── 前端 + 主进程构建（所有目标共用，只跑一次）────────────────────────────
build_frontend() {
  if [ "$SKIP_BUILD" -eq 0 ]; then
    step "1/2 构建 Angular 渲染层"
    npm run build

    step "2/2 构建 Electron 主进程"
    npm run build:electron
  else
    step "跳过 ng build / build:electron（--skip-build）"
    [ -d electron/www ] || die "--skip-build 需要已存在的 electron/www（先跑 npm run build）"
    [ -d dist-electron ] || die "--skip-build 需要已存在的 dist-electron（先跑 npm run build:electron）"
  fi
}

# ── 目标展开（扁平清单）────────────────────────────────────────────────────
# 两个平台都展开成同构记录 "key|outdir|builder_args|exts|distro|arch"，
# 共享的 run_targets 因此不需要知道平台差异。
plan_mac() {
  local arch outdir
  for arch in "${ARCHES[@]}"; do
    outdir="$OUT_ROOT/mac-$arch"
    TARGET_RECORDS+=("$arch|$outdir|--mac --$arch --publish never -c.directories.output=$outdir|dmg zip||$arch")
  done
}

plan_linux() {
  local distro arch target outdir
  for distro in "${DISTROS[@]}"; do
    for arch in "${ARCHES[@]}"; do
      target="$(distro_target "$distro")"
      # --appimage：为 pacman / deb 目标也追加一个 AppImage 产物（AppImage 跨发行版通用）。
      # 通用 linux 目标默认已带 AppImage。
      if [ "$APPIMAGE" -eq 1 ]; then
        case "$target" in *AppImage*) ;; *) target="$target AppImage" ;; esac
      fi
      outdir="$OUT_ROOT/$(distro_outdir "$distro")"
      case "$outdir" in
        "$OUT_ROOT"/*) ;;
        *) die "内部错误：非法输出目录 '$outdir'" ;;
      esac
      TARGET_RECORDS+=("$distro/$arch|$outdir|--linux $target --$arch --publish never -c.directories.output=$outdir|pacman deb tar.gz AppImage|$distro|$arch")
    done
  done
}

# ── 逐目标打包 ────────────────────────────────────────────────────────────
build_mac_target() {
  local key="$1" outdir="$2" args="$3"
  step "打包 $key → $outdir"
  rm -rf "$outdir"
  mkdir -p "$outdir"

  # args 是空格分隔的 electron-builder 实参（值均为脚本内硬编码字面量，
  # 此处刻意不引用，靠分词拆成多个参数）
  # shellcheck disable=SC2086
  if ./node_modules/.bin/electron-builder $args; then
    ok "$key 打包完成（$(( SECONDS - START_TS ))s 累计）"
    return 0
  fi
  return 1
}

build_linux_target() {
  local key="$1" outdir="$2" args="$3" exts="$4" distro="$5" arch="$6"

  # deepin 与 ubuntu 共用同一份 deb（依赖清单用 | 覆盖 t64 改名），构建一次、复制两处
  if distro_is_deb "$distro" && [ -n "${DEB_SRC[$arch]:-}" ]; then
    step "打包 $key → $outdir（复用已构建的 deb）"
    rm -rf "$outdir"
    mkdir -p "$outdir"
    cp -f "${DEB_SRC[$arch]}"/*.deb "$outdir"/ 2>/dev/null || true
    cp -f "${DEB_SRC[$arch]}"/*.AppImage "$outdir"/ 2>/dev/null || true
    shopt -s nullglob
    local copied=()
    copied=("$outdir"/*.deb)
    shopt -u nullglob
    [ ${#copied[@]} -gt 0 ] || die "复用 deb 失败：${DEB_SRC[$arch]} 中没有可复制的 .deb"
    ok "$key 复用 ${DEB_SRC[$arch]}"
    return 0
  fi

  step "打包 $key → $outdir"
  rm -rf "$outdir"
  mkdir -p "$outdir"

  # shellcheck disable=SC2086
  if ./node_modules/.bin/electron-builder $args; then
    if distro_is_deb "$distro"; then
      DEB_SRC[$arch]="$outdir"
    fi
    ok "$key 打包完成（$(( SECONDS - START_TS ))s 累计）"
    return 0
  fi
  return 1
}

build_target() {
  case "$PLATFORM" in
    mac)   build_mac_target "$@" ;;
    linux) build_linux_target "$@" ;;
  esac
}

run_targets() {
  local rec key outdir args exts distro arch
  for rec in "${TARGET_RECORDS[@]}"; do
    IFS='|' read -r key outdir args exts distro arch <<< "$rec"
    if build_target "$key" "$outdir" "$args" "$exts" "$distro" "$arch"; then
      TARGETS+=("$key"); STATES+=("ok"); ARTIFACTS+=("$(summarize_artifacts "$outdir" "$exts")")
    else
      TARGETS+=("$key"); STATES+=("fail"); ARTIFACTS+=("-")
      if [ "$KEEP_GOING" -eq 1 ]; then
        warn "$key 打包失败，继续下一个目标"
        FAILED+=("$key")
      else
        die "$key 打包失败"
      fi
    fi
  done
}

# ── 产物汇总 ──────────────────────────────────────────────────────────────
# 汇总某输出目录下的产物摘要；exts 是空格分隔的扩展名列表（各平台不同）
summarize_artifacts() {
  local dir="$1" exts="$2"
  local ext file summary=""
  shopt -s nullglob
  local files=()
  for ext in $exts; do
    files+=("$dir"/*."$ext")
  done
  shopt -u nullglob
  for file in "${files[@]}"; do
    summary="${summary:+$summary, }${file} ($(du -h "$file" | cut -f1))"
  done
  [ -n "$summary" ] || summary="-"
  printf '%s' "$summary"
}

# ── 打包后校验 ────────────────────────────────────────────────────────────
# 必须在打包之后跑：check-package-deps.ts 比对的是 app.asar 的实际内容，
# 打包前跑校验的是上一轮的旧产物，验不到本次结果。
# 全部目标都失败时本轮没有新产物，跳过校验，避免拿上轮残留的 asar 给出假信号。
verify_package() {
  if [ ${#FAILED[@]} -gt 0 ] && [ ${#FAILED[@]} -eq ${#TARGET_RECORDS[@]} ]; then
    die "所有目标打包均失败，跳过产物校验"
  fi
  step "校验打包产物依赖闭包"
  npm run verify:package || die "打包产物依赖校验失败"
}

# ── 打包结果 ──────────────────────────────────────────────────────────────
print_results() {
  step "打包结果"
  printf '%s  %-16s %-6s %s%s\n' "$C_DIM" "目标" "状态" "产物" "$C_OFF"
  local i=0
  while [ "$i" -lt ${#TARGETS[@]} ]; do
    if [ "${STATES[$i]}" = "ok" ]; then
      printf '  %-16s %s✓%s      %s\n' "${TARGETS[$i]}" "$C_GREEN" "$C_OFF" "${ARTIFACTS[$i]}"
    else
      printf '  %-16s %s✗%s      %s\n' "${TARGETS[$i]}" "$C_RED" "$C_OFF" "${ARTIFACTS[$i]}"
    fi
    i=$(( i + 1 ))
  done
  if [ ${#TARGETS[@]} -eq 0 ]; then
    warn "没有执行任何打包目标"
  fi
}

# ── 平台后处理 ────────────────────────────────────────────────────────────
# 依赖回显（安装前自查，避免依赖解析阶段才炸）+ 安装方式（仅 linux）
report_details() {
  if [ "$PLATFORM" != "linux" ]; then
    return
  fi
  local distro outdir artifact

  step "依赖回显"
  # 子 shell 隔离：nullglob 的开关状态不外泄到主流程
  (
    for distro in "${DISTROS[@]}"; do
      outdir="$OUT_ROOT/$(distro_outdir "$distro")"
      [ -d "$outdir" ] || continue
      shopt -s nullglob
      for artifact in "$outdir"/*.pacman "$outdir"/*.deb; do
        case "$artifact" in
          *.pacman)
            info "${artifact##*/} — depend:"
            tar -xf "$artifact" .PKGINFO -O 2>/dev/null \
              | sed -n 's/^depend = /    /p' || true
            ;;
          *.deb)
            info "${artifact##*/} — Depends:"
            if command -v dpkg-deb >/dev/null 2>&1; then
              dpkg-deb -f "$artifact" Depends 2>/dev/null \
                | tr ',' '\n' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' | sed 's/^/    /' || true
            else
              info "    （无 dpkg-deb，跳过）"
            fi
            ;;
        esac
      done
      shopt -u nullglob
    done
  )

  step "安装方式"
  for distro in "${DISTROS[@]}"; do
    outdir="$OUT_ROOT/$(distro_outdir "$distro")"
    case "$distro" in
      manjaro)
        printf '%s  Manjaro / Arch 系：%s\n' "$C_DIM" "$C_OFF"
        printf '    sudo pacman -U %s/*.pacman\n' "$outdir"
        ;;
      deepin|ubuntu)
        printf '%s  %s：%s\n' "$C_DIM" "$(distro_label "$distro")" "$C_OFF"
        printf '    sudo apt install ./%s/*.deb\n' "$outdir"
        ;;
      linux)
        printf '%s  通用 Linux：%s\n' "$C_DIM" "$C_OFF"
        printf '    # AppImage —— 单文件，双击即用（推荐）\n'
        printf '    %s/*.AppImage\n' "$outdir"
        printf '    # tar.gz —— 裸目录，需自行放到 /opt 并自建桌面项\n'
        printf '    tar -xzf %s/*.tar.gz -C /opt\n' "$outdir"
        ;;
    esac
  done
}

# 分发提示（收尾）
report_hint() {
  if [ "$PLATFORM" = "mac" ]; then
    cat <<EOF
${C_DIM}分发提示：未做 Developer ID 签名与公证，接收方首次打开需右键 →「打开」，
或执行：xattr -cr /Applications/白虎阅读.app${C_OFF}
EOF
  else
    cat <<EOF
${C_DIM}分发提示：包未做签名；Debian 系首次安装若提示依赖不满足，先 sudo apt update。
Ubuntu 24.04+ 已随包安装 AppArmor profile，无需额外操作。${C_OFF}
EOF
  fi
}

# ── 主流程 ────────────────────────────────────────────────────────────────
parse_args "$@"
resolve_platform

# ── 前置检查 ──────────────────────────────────────────────────────────────
if [ "$PLATFORM" = "mac" ]; then
  [ "$(uname -s)" = "Darwin" ] || die "macOS 打包只能在 macOS 上跑（当前 $(uname -s)）"
else
  [ "$(uname -s)" = "Linux" ] || die "Linux 打包只能在 Linux 上跑（当前 $(uname -s)）"
  [ "${BASH_VERSINFO[0]}" -ge 4 ] || die "需要 bash 4+（当前 ${BASH_VERSION}）"
  # deepin 与 ubuntu 共用同一份 deb（构建一次、复制两处）；仅 linux 分支需要 bash 4+
  declare -A DEB_SRC=()
fi
[ -x "node_modules/.bin/electron-builder" ] || die "缺少 electron-builder，先跑 npm install"

PRODUCT_NAME="$(node -p "require('./package.json').build.productName")"
VERSION="$(node -p "require('./package.json').version")"
OS_PRETTY=""
if [ "$PLATFORM" = "linux" ] && [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  OS_PRETTY="$(. /etc/os-release 2>/dev/null && printf '%s' "${PRETTY_NAME:-}" || true)"
fi

detect_host_arch
resolve_arches
resolve_distros

step "环境"
info "仓库      $ROOT"
info "应用      $PRODUCT_NAME $VERSION"
if [ "$PLATFORM" = "linux" ]; then
  info "宿主系统  ${OS_PRETTY:-未知}"
  info "主机架构  ${HOST_ARCH_RAW}（打包架构 ${HOST_ELECTRON_ARCH}）"
  info "目标发行版 ${DISTROS[*]}"
  info "目标架构  ${ARCHES[*]}"
  if [ "$APPIMAGE" -eq 1 ]; then
    info "附加产物  AppImage"
  fi
else
  if [ "$HOST_ARCH" = "$HOST_ARCH_RAW" ]; then
    info "主机架构  ${HOST_ARCH_RAW}（打包架构 ${HOST_ELECTRON_ARCH}）"
  else
    info "主机架构  ${HOST_ARCH_RAW}（Rosetta 转译，实际 ${HOST_ARCH} / 打包架构 ${HOST_ELECTRON_ARCH}）"
  fi
  info "目标架构  ${ARCHES[*]}"
  for arch in "${ARCHES[@]}"; do
    if [ "$arch" != "$HOST_ELECTRON_ARCH" ] && [ "$arch" != "universal" ]; then
      warn "$arch 与主机 $HOST_ARCH 不同，走交叉编译（可行；运行验证需对应架构真机）"
    fi
  done
fi

build_frontend

# ── 逐目标打包 ────────────────────────────────────────────────────────────
if [ "$PLATFORM" = "mac" ]; then
  plan_mac
else
  plan_linux
fi
START_TS=$SECONDS
run_targets

verify_package
print_results
report_details

if [ ${#FAILED[@]} -gt 0 ]; then
  printf '\n%s✗ 失败目标：%s%s\n' "$C_RED" "${FAILED[*]}" "$C_OFF" >&2
  exit 1
fi

printf '\n%s全部完成，总耗时 %ss%s\n' "$C_GREEN$C_BOLD" "$(( SECONDS - START_TS ))" "$C_OFF"
report_hint
