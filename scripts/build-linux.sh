#!/usr/bin/env bash
#
# scripts/build-linux.sh — 一键打包 Linux 应用（linux / manjaro / deepin / ubuntu）
#
# 用法：
#   bash scripts/build-linux.sh                     # 自动识别当前发行版，只打当前架构
#   bash scripts/build-linux.sh --distro manjaro    # pacman 包（Arch 系：Manjaro / Arch / EndeavourOS）
#   bash scripts/build-linux.sh --distro deepin     # deb 包（Debian 系：Deepin）
#   bash scripts/build-linux.sh --distro ubuntu     # deb 包（Ubuntu）
#   bash scripts/build-linux.sh --distro linux      # 通用 tar.gz + AppImage
#   bash scripts/build-linux.sh --distro all        # 上述全部
#   bash scripts/build-linux.sh --arch x64          # 指定架构（x64 / arm64 / armv7l / ia32）
#   bash scripts/build-linux.sh --arch all          # 全部架构
#   bash scripts/build-linux.sh --appimage          # 为 manjaro / deb 目标也追加 AppImage
#   bash scripts/build-linux.sh --skip-build        # 复用已有 electron/www + dist-electron，只重跑打包
#   bash scripts/build-linux.sh --keep-going        # 某一目标失败后继续跑下一个
#
# 不带参数时：按 /etc/os-release 自动识别当前发行版，只打当前架构，产出该系统可直接
# 安装的产物 —— Manjaro/Arch 系 → .pacman，Ubuntu/Deepin/Debian 系 → .deb，
# 其它发行版 → .AppImage（单文件，双击即用）。
#
# 产物（各发行版独立目录，互不覆盖）：
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
#   - Linux 没有 universal（单文件双架构）产物，--arch 逐架构独立打包。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

OUT_ROOT="release"
ALL_DISTROS=("manjaro" "deepin" "ubuntu" "linux")
ALL_ARCHES=("x64" "arm64" "armv7l" "ia32")
DISTROS=()
ARCHES=()
SKIP_BUILD=0
KEEP_GOING=0
APPIMAGE=0

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
    "${BASH_SOURCE[0]}" | sed '/^$/d'
}

# ── 发行版 / 架构元数据 ────────────────────────────────────────────────────
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
    id="$(. /etc/os-release 2>/dev/null && printf '%s' "${ID:-}")"
    id_like="$(. /etc/os-release 2>/dev/null && printf '%s' "${ID_LIKE:-}")"
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
while [ $# -gt 0 ]; do
  case "$1" in
    --distro)
      [ $# -ge 2 ] || die "--distro 需要参数（linux / manjaro / deepin / ubuntu / all）"
      case "$2" in
        all)             DISTROS=("${ALL_DISTROS[@]}") ;;
        linux|manjaro|deepin|ubuntu) DISTROS=("$2") ;;
        *) die "未知发行版 '$2'（可选：linux / manjaro / deepin / ubuntu / all）" ;;
      esac
      shift 2
      ;;
    --distro=*)     _arg="${1#*=}"; shift; set -- --distro "$_arg" "$@" ;;
    --arch)
      [ $# -ge 2 ] || die "--arch 需要参数（x64 / arm64 / armv7l / ia32 / all）"
      case "$2" in
        all)            ARCHES=("${ALL_ARCHES[@]}") ;;
        x64|arm64|armv7l|ia32) ARCHES=("$2") ;;
        *) die "未知架构 '$2'（可选：x64 / arm64 / armv7l / ia32 / all）" ;;
      esac
      shift 2
      ;;
    --arch=*)       _arg="${1#*=}"; shift; set -- --arch "$_arg" "$@" ;;
    --appimage)     APPIMAGE=1; shift ;;
    --skip-build)   SKIP_BUILD=1; shift ;;
    --keep-going)   KEEP_GOING=1; shift ;;
    -h|--help)      usage; exit 0 ;;
    *)              die "未知参数 '$1'（-h 看用法）" ;;
  esac
done

# ── 前置检查 ──────────────────────────────────────────────────────────────
[ "$(uname -s)" = "Linux" ] || die "Linux 打包只能在 Linux 上跑（当前 $(uname -s)）"
[ -x "node_modules/.bin/electron-builder" ] || die "缺少 electron-builder，先跑 npm install"
[ "${BASH_VERSINFO[0]}" -ge 4 ] || die "需要 bash 4+（当前 ${BASH_VERSION}）"

PRODUCT_NAME="$(node -p "require('./package.json').build.productName")"
VERSION="$(node -p "require('./package.json').version")"
OS_PRETTY=""
if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  OS_PRETTY="$(. /etc/os-release 2>/dev/null && printf '%s' "${PRETTY_NAME:-}")"
fi
HOST_ARCH_RAW="$(uname -m)"
case "$HOST_ARCH_RAW" in
  x86_64|amd64)   HOST_ELECTRON_ARCH="x64" ;;
  arm64|aarch64)  HOST_ELECTRON_ARCH="arm64" ;;
  armv7l|armv7)   HOST_ELECTRON_ARCH="armv7l" ;;
  i386|i686)      HOST_ELECTRON_ARCH="ia32" ;;
  *)              HOST_ELECTRON_ARCH="$HOST_ARCH_RAW" ;;
esac

[ ${#DISTROS[@]} -gt 0 ] || DISTROS=("$(detect_distro)")
[ ${#ARCHES[@]} -gt 0 ] || ARCHES=("$HOST_ELECTRON_ARCH")

step "环境"
info "仓库      $ROOT"
info "应用      $PRODUCT_NAME $VERSION"
info "宿主系统  ${OS_PRETTY:-未知}"
info "主机架构  ${HOST_ARCH_RAW}（打包架构 ${HOST_ELECTRON_ARCH}）"
info "目标发行版 ${DISTROS[*]}"
info "目标架构  ${ARCHES[*]}"
if [ "$APPIMAGE" -eq 1 ]; then
  info "附加产物  AppImage"
fi

# ── 前端 + 主进程构建（所有目标共用，只跑一次）────────────────────────────
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

# ── 逐目标打包 ────────────────────────────────────────────────────────────
# deepin 与 ubuntu 共用同一份 deb（依赖清单用 | 覆盖 t64 改名），构建一次、复制两处
declare -A DEB_SRC=()
TARGETS=()          # "distro/arch"
STATES=()           # ok | fail
ARTIFACTS=()        # 产物摘要（文件名 + 体积），失败时为 "-"
FAILED=()
START_TS=$SECONDS

# 汇总某输出目录下的产物摘要；ext 非空时只取该扩展名
summarize_artifacts() {
  local dir="$1" ext="${2:-}"
  local file summary=""
  shopt -s nullglob
  local files=()
  if [ -n "$ext" ]; then
    files=("$dir"/*."$ext")
  else
    files=("$dir"/*.pacman "$dir"/*.deb "$dir"/*.tar.gz "$dir"/*.AppImage)
  fi
  shopt -u nullglob
  for file in "${files[@]}"; do
    summary="${summary:+$summary, }${file} ($(du -h "$file" | cut -f1))"
  done
  [ -n "$summary" ] || summary="-"
  printf '%s' "$summary"
}

build_target() {
  local distro="$1" arch="$2"
  local target outdir
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

  if distro_is_deb "$distro" && [ -n "${DEB_SRC[$arch]:-}" ]; then
    step "打包 $distro/$arch → $outdir（复用已构建的 deb）"
    rm -rf "$outdir"
    mkdir -p "$outdir"
    cp -f "${DEB_SRC[$arch]}"/*.deb "$outdir"/ 2>/dev/null || true
    cp -f "${DEB_SRC[$arch]}"/*.AppImage "$outdir"/ 2>/dev/null || true
    shopt -s nullglob
    local copied=()
    copied=("$outdir"/*.deb)
    shopt -u nullglob
    [ ${#copied[@]} -gt 0 ] || die "复用 deb 失败：${DEB_SRC[$arch]} 中没有可复制的 .deb"
    ok "$distro/$arch 复用 ${DEB_SRC[$arch]}"
    TARGETS+=("$distro/$arch"); STATES+=("ok"); ARTIFACTS+=("$(summarize_artifacts "$outdir")")
    return 0
  fi

  step "打包 $distro/$arch → $outdir"
  rm -rf "$outdir"
  mkdir -p "$outdir"

  # target 是空格分隔的 electron-builder target 列表（值均为脚本内硬编码字面量，
  # 此处刻意不引用，靠分词拆成多个 --linux 取值）
  # shellcheck disable=SC2086
  if ./node_modules/.bin/electron-builder \
        --linux $target \
        "--$arch" \
        --publish never \
        -c.directories.output="$outdir"; then
    if distro_is_deb "$distro"; then
      DEB_SRC[$arch]="$outdir"
    fi
    ok "$distro/$arch 打包完成"
    TARGETS+=("$distro/$arch"); STATES+=("ok"); ARTIFACTS+=("$(summarize_artifacts "$outdir")")
  else
    TARGETS+=("$distro/$arch"); STATES+=("fail"); ARTIFACTS+=("-")
    return 1
  fi
}

for distro in "${DISTROS[@]}"; do
  for arch in "${ARCHES[@]}"; do
    if build_target "$distro" "$arch"; then
      :
    else
      if [ "$KEEP_GOING" -eq 1 ]; then
        warn "$distro/$arch 打包失败，继续下一个目标"
        FAILED+=("$distro/$arch")
      else
        die "$distro/$arch 打包失败"
      fi
    fi
  done
done

# ── 打包后校验（asar 运行时依赖闭包）────────────────────────────────────
# 必须在打包之后跑：check-package-deps.ts 比对的是 app.asar 的实际内容，
# 打包前跑校验的是上一轮的旧产物，验不到本次结果。
# 全部目标都失败时本轮没有新产物，跳过校验，避免拿上轮残留的 asar 给出假信号。
# 已知限制：多目标场景下该脚本按 mtime 取最新的一个 app.asar 校验，
# 而非逐目标校验；各目标 asar 内容一致（同一份 dist-electron + electron/www），故等价。
if [ ${#FAILED[@]} -gt 0 ] && [ ${#FAILED[@]} -eq $(( ${#DISTROS[@]} * ${#ARCHES[@]} )) ]; then
  die "所有目标打包均失败，跳过产物校验"
fi
step "校验打包产物依赖闭包"
npm run verify:package || die "打包产物依赖校验失败"

# ── 打包结果 ──────────────────────────────────────────────────────────────
step "打包结果"
printf '%s  %-16s %-6s %s%s\n' "$C_DIM" "目标" "状态" "产物" "$C_OFF"
i=0
while [ "$i" -lt ${#TARGETS[@]} ]; do
  if [ "${STATES[$i]}" = "ok" ]; then
    printf '  %-16s %s✓%s      %s\n' "${TARGETS[$i]}" "$C_GREEN" "$C_OFF" "${ARTIFACTS[$i]}"
  else
    printf '  %-16s %s✗%s      %s\n' "${TARGETS[$i]}" "$C_RED" "$C_OFF" "${ARTIFACTS[$i]}"
  fi
  i=$(( i + 1 ))
done
[ ${#TARGETS[@]} -gt 0 ] || warn "没有执行任何打包目标"

# ── 依赖回显（安装前自查，避免依赖解析阶段才炸）─────────────────────────────
step "依赖回显"
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

# ── 安装方式 ──────────────────────────────────────────────────────────────
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

if [ ${#FAILED[@]} -gt 0 ]; then
  printf '\n%s✗ 失败目标：%s%s\n' "$C_RED" "${FAILED[*]}" "$C_OFF" >&2
  exit 1
fi

printf '\n%s全部完成，总耗时 %ss%s\n' "$C_GREEN$C_BOLD" "$(( SECONDS - START_TS ))" "$C_OFF"
cat <<EOF
${C_DIM}分发提示：包未做签名；Debian 系首次安装若提示依赖不满足，先 sudo apt update。
Ubuntu 24.04+ 已随包安装 AppArmor profile，无需额外操作。${C_OFF}
EOF
