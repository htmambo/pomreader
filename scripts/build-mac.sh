#!/usr/bin/env bash
#
# scripts/build-mac.sh — 一键打包 macOS 应用，区分 Intel / Apple Silicon / Universal
#
# 用法：
#   bash scripts/build-mac.sh                     # 默认：只打当前机器的架构
#   bash scripts/build-mac.sh --arch x64          # 只打 Intel (amd64)
#   bash scripts/build-mac.sh --arch arm64        # 只打 Apple Silicon (arm64, M1+)
#   bash scripts/build-mac.sh --arch universal    # 只打 universal（单文件双架构，体积约 2 倍）
#   bash scripts/build-mac.sh --arch all          # 三种全打：x64 + arm64 + universal
#   bash scripts/build-mac.sh --skip-build        # 复用已有 electron/www + dist-electron，只重跑打包
#   bash scripts/build-mac.sh --keep-going        # 某一架构失败后继续跑下一个（默认遇错即停）
#
# 不带参数时：按当前机器的真实架构只打一份 —— Apple Silicon 出 arm64，Intel 出 x64。
#   脚本会识别 Rosetta 转译（uname -m 报 x86_64 但 sysctl.proc_translated=1），
#   此时按真实芯片算，即在 Rosetta 终端里跑默认也出 arm64 包。
#
# 产物（各架构独立目录，互不覆盖，文件名带 -mac-<arch> 后缀，分发时不会拿错）：
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
ALL_ARCHES=("x64" "arm64" "universal")
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
    --arch=*)     ARCH_FLAG="${1#*=}"; shift; set -- --arch "$ARCH_FLAG" "$@" ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --keep-going) KEEP_GOING=1; shift ;;
    -h|--help)    usage; exit 0 ;;
    *)            die "未知参数 '$1'（-h 看用法）" ;;
  esac
done

# ── 前置检查 ────────────────────────────────────────────────────────────────
[ "$(uname -s)" = "Darwin" ] || die "macOS 打包只能在 macOS 上跑（当前 $(uname -s)）"
[ -x "node_modules/.bin/electron-builder" ] || die "缺少 electron-builder，先跑 npm install"

PRODUCT_NAME="$(node -p "require('./package.json').build.productName")"
VERSION="$(node -p "require('./package.json').version")"
HOST_ARCH_RAW="$(uname -m)"
HOST_ARCH="$HOST_ARCH_RAW"
# Rosetta 转译进程下 uname -m 报 x86_64，但真实芯片是 Apple Silicon
if [ "$HOST_ARCH" = "x86_64" ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = "1" ]; then
  HOST_ARCH="arm64"
fi
# 归一到 electron-builder 的架构命名（x64 / arm64）
case "$HOST_ARCH" in
  x86_64|amd64) HOST_ELECTRON_ARCH="x64" ;;
  arm64|aarch64) HOST_ELECTRON_ARCH="arm64" ;;
  *) die "无法识别的宿主架构 '$HOST_ARCH'（仅支持 x64 / arm64）" ;;
esac

# 不带 --arch 时只打当前机器的架构（与 build-linux.sh 的默认一致）
[ ${#ARCHES[@]} -gt 0 ] || ARCHES=("$HOST_ELECTRON_ARCH")

step "环境"
info "仓库      $ROOT"
info "应用      $PRODUCT_NAME $VERSION"
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
TARGETS=()          # 架构名
STATES=()           # ok | fail
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
    TARGETS+=("$arch"); STATES+=("ok")
  else
    TARGETS+=("$arch"); STATES+=("fail")
    if [ "$KEEP_GOING" -eq 1 ]; then
      warn "$arch 打包失败，继续下一个架构"
      FAILED+=("$arch")
    else
      die "$arch 打包失败"
    fi
  fi
done

# ── 打包后校验（asar 运行时依赖闭包）────────────────────────────────────
# 必须在打包之后跑：check-package-deps.ts 比对的是 app.asar 的实际内容，
# 打包前跑校验的是上一轮的旧产物，验不到本次结果。
# 全部架构都失败时本轮没有新产物，跳过校验，避免拿上轮残留的 asar 给出假信号。
if [ ${#FAILED[@]} -gt 0 ] && [ ${#FAILED[@]} -eq ${#ARCHES[@]} ]; then
  die "所有架构打包均失败，跳过产物校验"
fi
step "校验打包产物依赖闭包"
npm run verify:package || die "打包产物依赖校验失败"

# ── 产物清单 ──────────────────────────────────────────────────────────────
step "产物清单"
i=0
while [ "$i" -lt ${#TARGETS[@]} ]; do
  arch="${TARGETS[$i]}"
  arch_out="$OUT_ROOT/mac-$arch"
  summary=""
  if [ "${STATES[$i]}" = "ok" ]; then
    shopt -s nullglob
    artifacts=("$arch_out"/*.dmg "$arch_out"/*.zip)
    shopt -u nullglob
    for artifact in "${artifacts[@]}"; do
      summary="${summary:+$summary, }${artifact} ($(du -h "$artifact" | cut -f1))"
    done
  fi
  summary="${summary:--}"
  if [ "${STATES[$i]}" = "ok" ]; then
    printf '  %s✓%s %-12s %s\n' "$C_GREEN" "$C_OFF" "$arch" "$summary"
  else
    printf '  %s✗%s %-12s %s\n' "$C_RED" "$C_OFF" "$arch" "$summary"
  fi
  i=$(( i + 1 ))
done

if [ ${#FAILED[@]} -gt 0 ]; then
  printf '\n%s✗ 失败架构：%s%s\n' "$C_RED" "${FAILED[*]}" "$C_OFF" >&2
  exit 1
fi

printf '\n%s全部完成，总耗时 %ss%s\n' "$C_GREEN$C_BOLD" "$(( SECONDS - START_TS ))" "$C_OFF"
cat <<EOF
${C_DIM}分发提示：未做 Developer ID 签名与公证，接收方首次打开需右键 →「打开」，
或执行：xattr -cr /Applications/白虎阅读.app${C_OFF}
EOF
