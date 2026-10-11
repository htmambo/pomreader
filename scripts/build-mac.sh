#!/usr/bin/env bash
#
# scripts/build-mac.sh — 一键打包 macOS 应用，区分 Intel / Apple Silicon
#
# 用法：
#   bash scripts/build-mac.sh                     # 默认：x64 + arm64 两份 dmg
#   bash scripts/build-mac.sh --arch x64          # 只打 Intel
#   bash scripts/build-mac.sh --arch arm64        # 只打 Apple Silicon (M1+)
#   bash scripts/build-mac.sh --arch universal    # 只打 universal（单文件双架构，体积约 2 倍）
#   bash scripts/build-mac.sh --skip-build        # 复用已有 electron/www + dist-electron，只重跑打包
#   bash scripts/build-mac.sh --keep-going        # 某一架构失败后继续跑另一个（默认遇错即停）
#
# 产物（各架构独立目录，互不覆盖）：
#   release/mac-x64/pomreader-1.0.0-mac-x64.dmg
#   release/mac-arm64/pomreader-1.0.0-mac-arm64.dmg
#   release/mac-universal/pomreader-1.0.0-mac-universal.dmg
#
# 交叉编译说明：electron-builder 按目标架构拉取对应 Electron 发行版，
#   打包过程不执行目标二进制，所以 Intel 机器可打 arm64、Apple Silicon 可打 x64，
#   无需对应真机；但「双击运行验证」仍需对应架构的机器。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

OUT_ROOT="release"
ALL_ARCHES=("x64" "arm64")
ARCHES=()
SKIP_BUILD=0
KEEP_GOING=0

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

while [ $# -gt 0 ]; do
  case "$1" in
    --arch)
      [ $# -ge 2 ] || die "--arch 需要参数（x64 / arm64 / universal / all）"
      case "$2" in
        all)       ARCHES=("${ALL_ARCHES[@]}") ;;
        x64)       ARCHES=("x64") ;;
        arm64)     ARCHES=("arm64") ;;
        universal) ARCHES=("universal") ;;
        *) die "未知架构 '$2'（可选：x64 / arm64 / universal / all）" ;;
      esac
      shift 2
      ;;
    --arch=*)     ARCH_FLAG="${1#*=}"; set -- --arch "$ARCH_FLAG" "$@"; shift ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --keep-going) KEEP_GOING=1; shift ;;
    -h|--help)    usage; exit 0 ;;
    *)            die "未知参数 '$1'（-h 看用法）" ;;
  esac
done

[ ${#ARCHES[@]} -gt 0 ] || ARCHES=("${ALL_ARCHES[@]}")

# ── 前置检查 ────────────────────────────────────────────────────────────────
[ "$(uname -s)" = "Darwin" ] || die "macOS 打包只能在 macOS 上跑（当前 $(uname -s)）"
[ -x "node_modules/.bin/electron-builder" ] || die "缺少 electron-builder，先跑 npm install"

PRODUCT_NAME="$(node -p "require('./package.json').build.productName")"
VERSION="$(node -p "require('./package.json').version")"
HOST_ARCH="$(uname -m)"

step "环境"
info "仓库      $ROOT"
info "应用      $PRODUCT_NAME $VERSION"
info "主机架构  $HOST_ARCH"
info "目标架构  ${ARCHES[*]}"

for arch in "${ARCHES[@]}"; do
  if [ "$arch" != "$HOST_ARCH" ] && [ "$arch" != "universal" ]; then
    warn "$arch 与主机 $HOST_ARCH 不同，走交叉编译（可行；运行验证需对应架构真机）"
  fi
done

# ── 前端 + 主进程构建（多架构共用，只跑一次）────────────────────────────
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

# ── 逐架构打包 ────────────────────────────────────────────────────────────
FAILED=()
START_TS=$SECONDS

for arch in "${ARCHES[@]}"; do
  arch_out="$OUT_ROOT/mac-$arch"
  step "打包 $arch → $arch_out"
  rm -rf "$arch_out"

  if ./node_modules/.bin/electron-builder \
        --mac "--$arch" \
        --publish never \
        -c.directories.output="$arch_out"; then
    ok "$arch 打包完成（$(( SECONDS - START_TS ))s 累计）"
  else
    if [ "$KEEP_GOING" -eq 1 ]; then
      warn "$arch 打包失败，继续下一个架构"
      FAILED+=("$arch")
    else
      die "$arch 打包失败"
    fi
  fi
done

# ── 产物清单 ──────────────────────────────────────────────────────────────
step "产物清单"
FOUND=0
for arch in "${ARCHES[@]}"; do
  shopt -s nullglob
  for dmg in "$OUT_ROOT/mac-$arch"/*.dmg; do
    FOUND=1
    size="$(du -h "$dmg" | cut -f1)"
    bin_arch="$(basename "$dmg" .dmg | sed -e 's/.*-mac-//')"
    ok "$dmg  (${size}, mac-${bin_arch})"
  done
done
[ "$FOUND" -eq 1 ] || warn "没有产出 .dmg（见上方 electron-builder 日志）"

if [ ${#FAILED[@]} -gt 0 ]; then
  printf '\n%s✗ 失败架构：%s%s\n' "$C_RED" "${FAILED[*]}" "$C_OFF" >&2
  exit 1
fi

printf '\n%s全部完成，总耗时 %ss%s\n' "$C_GREEN$C_BOLD" "$(( SECONDS - START_TS ))" "$C_OFF"
cat <<EOF
${C_DIM}分发提示：未做 Developer ID 签名与公证，接收方首次打开需右键 →「打开」，
或执行：xattr -cr /Applications/白虎阅读.app${C_OFF}
EOF