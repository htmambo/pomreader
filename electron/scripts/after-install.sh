#!/bin/bash
# electron-builder afterInstall hook for pomreader
#
# 作用一：解决第三方 KDE 图标主题（如 WhiteSur-dark）不读取 hicolor 新增图标的问题。
# 系统装好应用后会自动给所有非 hicolor 主题建 pomreader symlink
# 并重建 cache，让 kickoff / dock / Alt-Tab 立即显示应用图标。
#
# 作用二：补齐 electron-builder 内置 after-install.tpl 的运行时必需项。
# electron-builder 的用户自定义 afterInstall 会「整体替换」内置模板
# （app-builder-lib/out/targets/FpmTarget.js:68 —— getResource(用户脚本, "after-install.tpl")），
# 内置模板原本承担 4 件事，自定义后必须自己补上：
#   1) /usr/bin/<exe> 软链；
#   2) chrome-sandbox 的 SUID 回退（内核禁用 user namespace 时必需）；
#   3) AppArmor profile 安装 —— Ubuntu 24+ 起 apparmor_restrict_unprivileged_userns=1，
#      未装 profile 的 Electron 应用无法创建 user namespace，直接启动失败；
#   4) desktop / MIME 数据库刷新。
#
# 此脚本由 fpm 在 .pacman / .deb 安装时以 root 身份执行。
# 宏 ${executable} / ${sanitizedProductName} 由 electron-builder 在写包时替换。
#
# 入参约定：本钩子**不读取任何位置参数**，且每一步都是幂等的，因此对两套调度签名都安全：
#   - pacman：.INSTALL 里被包成 post_install() { ... }，调用时带版本号；
#   - deb：control 的 postinst 由 dpkg 以 `postinst configure <old_ver>` 调用。
# 卸载侧由 electron-builder 内置的 after-remove.tpl 处理（删软链 + 卸载 AppArmor profile）。
set -e

APP_ID="pomreader"
HICOLOR_PNG="/usr/share/icons/hicolor/128x128/apps/${APP_ID}.png"

log() { echo "[pomreader-hook] $*" >&2; }

# 检测真实安装用户：pacman / dpkg 是 root 跑的，但通常是用户用 sudo 触发的。
# 用户家目录里的主题需要在该用户身份下处理。
INSTALL_USER="${SUDO_USER:-}"
if [ -z "$INSTALL_USER" ] && command -v loginctl >/dev/null; then
  # 优先取「活跃的图形会话」，其次取任意活跃会话 —— loginctl 无参输出的第 2 行
  # 未必是当前桌面会话（多用户 / 多 TTY / SSH 并存时可能是残留会话）
  _session="$(loginctl --no-legend list-sessions 2>/dev/null \
    | awk '$4 == "active" && ($5 == "graphical" || $5 == "x11" || $5 == "wayland") {print $1; exit}')"
  [ -z "$_session" ] && _session="$(loginctl --no-legend list-sessions 2>/dev/null \
    | awk '$4 == "active" {print $1; exit}')"
  if [ -n "$_session" ]; then
    INSTALL_USER="$(loginctl show-session "$_session" -p User -P 2>/dev/null || true)"
  fi
fi
[ -z "$INSTALL_USER" ] && INSTALL_USER="root"

# ── 0) Electron 运行时必需项（等价 electron-builder 内置 after-install.tpl）────
APP_DIR="/opt/${sanitizedProductName}"
APP_BIN="${APP_DIR}/${executable}"

# 0.1) /usr/bin/<exe> 软链 —— 命令行可直接调用
#      （桌面项 Exec 已写绝对路径 /opt/<产品>/<exe>，不依赖该软链）
if [ -x "$APP_BIN" ]; then
  ln -sf "$APP_BIN" "/usr/bin/${executable}" 2>/dev/null || true
fi

# 0.2) chrome-sandbox 权限 —— 内核不支持 user namespace 时必须 SUID
if [ -f "${APP_DIR}/chrome-sandbox" ]; then
  if ! { [ -L /proc/self/ns/user ] && unshare --user true; } 2>/dev/null; then
    chmod 4755 "${APP_DIR}/chrome-sandbox" 2>/dev/null || true
  else
    chmod 0755 "${APP_DIR}/chrome-sandbox" 2>/dev/null || true
  fi
fi

# 0.3) AppArmor profile（Ubuntu 24+ 启动硬需求）
#      先用 --skip-kernel-load 试解析，成功才落地；不识别该 abi 的旧 AppArmor 跳过。
AA_SRC="${APP_DIR}/resources/apparmor-profile"
AA_DST="/etc/apparmor.d/${executable}"
if [ -f "$AA_SRC" ] \
  && command -v apparmor_status >/dev/null 2>&1 \
  && command -v apparmor_parser >/dev/null 2>&1 \
  && apparmor_status --enabled >/dev/null 2>&1; then
  if apparmor_parser --skip-kernel-load --debug "$AA_SRC" >/dev/null 2>&1; then
    cp -f "$AA_SRC" "$AA_DST" 2>/dev/null || true
    # chroot 内做 live apparmor 操作没有意义，跳过
    if ! { [ -x /usr/bin/ischroot ] && /usr/bin/ischroot; } 2>/dev/null; then
      apparmor_parser --replace --write-cache --skip-read-cache "$AA_DST" >/dev/null 2>&1 || true
    fi
    log "apparmor profile installed: $AA_DST"
  else
    log "apparmor profile skipped (unsupported abi)"
  fi
fi

# 0.4) 桌面项 / MIME 数据库刷新
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database /usr/share/applications >/dev/null 2>&1 || true
fi
if command -v update-mime-database >/dev/null 2>&1; then
  update-mime-database /usr/share/mime >/dev/null 2>&1 || true
fi

# 1) 重建 hicolor cache（pacman post_install 应该已做过，这里保险重做一次）
if command -v gtk-update-icon-cache >/dev/null && [ -d /usr/share/icons/hicolor ]; then
  gtk-update-icon-cache -f -t /usr/share/icons/hicolor 2>/dev/null || true
fi

# 2) 系统级主题扫描（除 hicolor）
if [ -f "$HICOLOR_PNG" ] && [ -d /usr/share/icons ]; then
  for theme_dir in /usr/share/icons/*/; do
    [ -d "$theme_dir" ] || continue
    theme="$(basename "$theme_dir")"
    [ "$theme" = "hicolor" ] && continue
    [ -f "${theme_dir}index.theme" ] || continue

    target="${theme_dir}apps/${APP_ID}.png"
    [ -e "$target" ] && continue

    mkdir -p "${theme_dir}apps" 2>/dev/null || continue
    ln -sf "$HICOLOR_PNG" "$target" 2>/dev/null || continue
    log "system theme '$theme' -> symlinked"

    command -v gtk-update-icon-cache >/dev/null && \
      gtk-update-icon-cache -f -t "$theme_dir" 2>/dev/null || true
  done
fi

# 3) 用户级主题扫描（扫描所有有家目录的用户，覆盖多账户场景）
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
      ln -sf "$HICOLOR_PNG" "$target" 2>/dev/null || continue
      log "user theme ($user_home) '$theme' -> symlinked"

      command -v gtk-update-icon-cache >/dev/null && \
        gtk-update-icon-cache -f -t "$theme_dir" 2>/dev/null || true
    done
  done
fi

# 4) 触发 KService 缓存重建（让 kickoff / KIO tags worker 重新扫描）
# 此操作需要以真实用户身份跑（plasma 缓存位于用户家目录）。
# 显式指定 /bin/bash —— 目标用户的登录 shell 可能是 csh/fish，语法不通用。
if [ "$INSTALL_USER" != "root" ] && command -v kbuildsycoca6 >/dev/null; then
  if su -s /bin/bash - "$INSTALL_USER" -c "kbuildsycoca6 --noincremental" >/dev/null 2>&1; then
    log "kbuildsycoca6 reindexed for '$INSTALL_USER'"
  else
    log "kbuildsycoca6 failed for '$INSTALL_USER' (non-fatal)"
  fi
fi

exit 0
