#!/bin/bash
# electron-builder afterInstall hook for pomreader
#
# 解决第三方 KDE 图标主题（如 WhiteSur-dark）不读取 hicolor 新增图标的问题。
# 系统装好应用后会自动给所有非 hicolor 主题建 pomreader symlink
# 并重建 cache，让 kickoff / dock / Alt-Tab 立即显示应用图标。
#
# 此脚本由 fpm 在 .pacman 安装时以 root 身份执行。
set -e

APP_ID="pomreader"
HICOLOR_PNG="/usr/share/icons/hicolor/128x128/apps/${APP_ID}.png"

log() { echo "[pomreader-hook] $*" >&2; }

# 检测真实安装用户：pacman 是 root 跑的，但通常是用户用 sudo 触发的。
# 用户家目录里的主题需要在该用户身份下处理。
INSTALL_USER="${SUDO_USER:-}"
if [ -z "$INSTALL_USER" ] && command -v loginctl >/dev/null; then
  INSTALL_USER="$(loginctl show-session "$(awk 'NR==2{print $1; exit}' <(loginctl))" -p User -P 2>/dev/null || true)"
fi
[ -z "$INSTALL_USER" ] && INSTALL_USER="root"

# 0) 重建 hicolor cache（pacman post_install 应该已做过，这里保险重做一次）
if command -v gtk-update-icon-cache >/dev/null && [ -d /usr/share/icons/hicolor ]; then
  gtk-update-icon-cache -f -t /usr/share/icons/hicolor 2>/dev/null || true
fi

# 1) 系统级主题扫描（除 hicolor）
if [ -f "$HICOLOR_PNG" ] && [ -d /usr/share/icons ]; then
  for theme_dir in /usr/share/icons/*/; do
    [ -d "$theme_dir" ] || continue
    theme="$(basename "$theme_dir")"
    [ "$theme" = "hicolor" ] && continue
    [ -f "${theme_dir}index.theme" ] || continue

    target="${theme_dir}apps/${APP_ID}.png"
    [ -e "$target" ] && continue

    mkdir -p "${theme_dir}apps" 2>/dev/null || continue
    ln -sf "$HICOLOR_PNG" "$target"
    log "system theme '$theme' -> symlinked"

    command -v gtk-update-icon-cache >/dev/null && \
      gtk-update-icon-cache -f -t "$theme_dir" 2>/dev/null || true
  done
fi

# 2) 用户级主题扫描（扫描所有有家目录的用户，覆盖多账户场景）
if [ -f "$HICOLOR_PNG" ]; then
  for user_home in /home/*; do
    icons_root="${user_home}/.local/share/icons"
    [ -d "$icons_root" ] || continue

    for theme_dir in "$icons_root"/*/; do
      [ -d "$theme_dir" ] || continue
      theme="$(basename "$theme_dir")"
      [ "$theme" = "hicolor" ] && continue
      [ -f "${theme_dir}index.theme" ] || continue

      target="${theme_dir}apps/${APP_ID}.png"
      [ -e "$target" ] && continue

      mkdir -p "${theme_dir}apps" 2>/dev/null || continue
      ln -sf "$HICOLOR_PNG" "$target"
      log "user theme ($user_home) '$theme' -> symlinked"

      command -v gtk-update-icon-cache >/dev/null && \
        gtk-update-icon-cache -f -t "$theme_dir" 2>/dev/null || true
    done
  done
fi

# 3) 触发 KService 缓存重建（让 kickoff / KIO tags worker 重新扫描）
# 此操作需要以真实用户身份跑（plasma 缓存位于用户家目录）
if [ "$INSTALL_USER" != "root" ] && command -v kbuildsycoca6 >/dev/null; then
  su - "$INSTALL_USER" -c "kbuildsycoca6 --noincremental 2>/dev/null || true" || true
  log "kbuildsycoca6 reindexed for '$INSTALL_USER'"
fi

exit 0