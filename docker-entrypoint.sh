#!/bin/sh
# tgsub 容器入口脚本
#
# 背景：NAS / 群晖 / 威联通等环境下，用 Docker 面板或 compose 创建容器时，
# 绑定挂载的宿主机目录会被自动创建为 root:root。镜像默认以 node(1000) 运行，
# 于是第一次写 /data/.session-secret 就 EACCES，进程崩溃并被 restart 策略反复拉起，
# 表现为「容器一直重启」。
#
# 这里在容器以 root 启动时，先把持久化目录的属主改成 PUID:PGID，
# 再降权运行 node。降权失败（属主改不动 / 改完仍不可写）时退回以 root 运行，
# 保证「能启动」优先于「权限好看」。
#
# 可用环境变量：
#   PUID / PGID   容器内运行用户，默认 1000:1000（对应镜像里的 node 用户）
#   DATA_DIR      数据目录，默认 /data
#   DOWNLOAD_DIR  下载目录，默认 /downloads
#   CHOWN_RECURSE 置 1 时连下载目录里的历史文件也一起改属主（默认只改顶层目录）

set -e

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
DATA_DIR="${DATA_DIR:-/data}"
DOWNLOAD_DIR="${DOWNLOAD_DIR:-/downloads}"
CHOWN_RECURSE="${CHOWN_RECURSE:-0}"

log() {
  echo "[entrypoint] $*"
}

# 修正单个路径的属主；成功返回 0，失败返回 1
chown_path() {
  target="$1"
  recursive="$2"
  [ -e "$target" ] || return 0
  if [ "$recursive" = "1" ]; then
    chown -R "$PUID:$PGID" "$target" 2>/dev/null
  else
    chown "$PUID:$PGID" "$target" 2>/dev/null
  fi
}

# 不是 root：没有 chown 权限，直接启动
# （此时权限问题由应用层给出明确提示，见 server/src/env.ts）
if [ "$(id -u)" != "0" ]; then
  log "当前用户 uid=$(id -u)，跳过属主修正，直接启动"
  exec "$@"
fi

log "以 root 启动，PUID=$PUID PGID=$PGID"

# 核显设备：把 /dev/dri 下设备节点的属组加进运行用户的补充组。
#
# 为什么不在 compose 里写 group_add: "render" —— Docker 的 group_add 是按
# **宿主机 /etc/group 的组名**解析的，而群晖 / 威联通 / 绿联等 NAS 的组文件里
# 通常只有 video、没有 render，一写就报
#   "unable to find group render: no matching entries in group file"
# 容器直接创建失败（不是起不来，是根本建不出来）。
# 改成在容器内读设备节点的真实 gid 再 --groups 带上，任何 NAS 都不用配 group_add。
DEV_GROUPS=""
for dev in /dev/dri/renderD128 /dev/dri/renderD129 /dev/dri/card0; do
  [ -e "$dev" ] || continue
  gid="$(stat -c '%g' "$dev" 2>/dev/null || true)"
  [ -n "$gid" ] || continue
  case ",$DEV_GROUPS," in
    *",$gid,"*) ;;
    *) DEV_GROUPS="${DEV_GROUPS:+$DEV_GROUPS,}$gid" ;;
  esac
  log "检测到核显设备 $dev（属组 gid=$gid），将加入运行用户的补充组"
done

own_ok=1

# 数据目录体积很小（数据库 + session + 封面缓存），递归改属主，
# 这样从「老版本以 root 跑过」升级上来的历史文件也能被降权后的进程读写。
if chown_path "$DATA_DIR" 1; then
  log "已将 $DATA_DIR 及其内容属主设为 $PUID:$PGID"
else
  log "警告：无法修改 $DATA_DIR 的属主（常见于 CIFS/SMB 挂载或只读目录）"
  own_ok=0
fi

# 下载目录可能有几百 GB，递归 chown 会很慢，默认只改顶层目录本身，
# 让后续新建的剧集目录自然归属新用户；历史文件需要时设 CHOWN_RECURSE=1。
if chown_path "$DOWNLOAD_DIR" "$CHOWN_RECURSE"; then
  log "已将 $DOWNLOAD_DIR 属主设为 $PUID:$PGID"
else
  log "警告：无法修改 $DOWNLOAD_DIR 的属主（常见于 CIFS/SMB 挂载或只读目录）"
  own_ok=0
fi

# 降权：仅在属主修正成功、且降权后目录确实可写时才执行
if [ "$own_ok" = "1" ] && command -v setpriv >/dev/null 2>&1; then
  writable=1
  for dir in "$DATA_DIR" "$DOWNLOAD_DIR"; do
    [ -d "$dir" ] || continue
    if ! setpriv --reuid="$PUID" --regid="$PGID" --clear-groups /usr/bin/test -w "$dir" 2>/dev/null; then
      writable=0
      log "警告：降权为 uid=$PUID 后 $dir 仍不可写"
    fi
  done

  if [ "$writable" = "1" ]; then
    log "以 uid=$PUID gid=$PGID 启动"
    # 降权后 HOME 必须指向可写目录，否则部分依赖会往 /root 下写缓存
    HOME=/tmp
    export HOME
    if [ -n "$DEV_GROUPS" ]; then
      exec setpriv --reuid="$PUID" --regid="$PGID" --groups="$DEV_GROUPS" "$@"
    fi
    exec setpriv --reuid="$PUID" --regid="$PGID" --clear-groups "$@"
  fi
fi

log "以 root 启动（如需指定用户，请让宿主机目录属主与 PUID/PGID 一致）"
# 降权失败但仍映射了核显：保持 root 运行至少能用上硬解（root 无视设备权限）
if [ -n "$DEV_GROUPS" ]; then
  log "降权未生效，以 root 运行（核显可用）"
fi
exec "$@"
