#!/usr/bin/env bash
# 探测本机环境 → 写出 conf/kit.conf（后续所有脚本都读它）。
#
# ⭐ 设计原则：**不猜路径，去问系统**。原作者机器上的任何具体路径
#    （Windows 用户名、数据目录名）一律不写死 —— 换机器必须照样能跑。
#
# 用法：
#   bash scripts/discover_env.sh              # 自动探测
#   bash scripts/discover_env.sh --show       # 只看结果不落盘
# 探测不到的项会留空并给出「怎么手动填」，不会瞎填一个。
set -uo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
CONF="$HERE/conf/kit.conf"
SHOW_ONLY=0
[ "${1:-}" = "--show" ] && SHOW_ONLY=1

say()  { printf '%s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

# ───────────────────────── 平台判定
UNAME="$(uname -s)"
IS_WSL=0
grep -qi microsoft /proc/version 2>/dev/null && IS_WSL=1
case "$UNAME" in
  Linux)  if [ "$IS_WSL" = 1 ]; then OS="wsl"; else OS="linux"; fi ;;
  Darwin) OS="macos" ;;
  *)      OS="unknown" ;;
esac
say "== 平台：$OS ($UNAME) =="

# ───────────────────────── Windows 侧工具（WSL 里要用完整路径）
PS=""
if [ "$IS_WSL" = 1 ] || [ "$OS" = "linux" ]; then
  for c in /mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe \
           "$(command -v powershell.exe 2>/dev/null || true)"; do
    [ -n "$c" ] && [ -x "$c" ] && PS="$c" && break
  done
fi
[ -n "$PS" ] && say "PowerShell: $PS"

# ───────────────────────── Zotero 程序与 profile
# 候选顺序：环境变量 → 各平台默认位置
find_zotero_dir() {
  [ -n "${ZOTERO_DIR:-}" ] && [ -d "$ZOTERO_DIR" ] && { echo "$ZOTERO_DIR"; return; }
  local c
  for c in \
    "/mnt/c/Program Files/Zotero" \
    "/mnt/c/Program Files (x86)/Zotero" \
    "/usr/lib/zotero" "/usr/share/zotero" "/opt/zotero" \
    "/Applications/Zotero.app/Contents/Resources" \
    "$HOME/.local/share/zotero" ; do
    [ -d "$c" ] && { echo "$c"; return; }
  done
}
ZOTERO_DIR="$(find_zotero_dir)"

find_profiles_root() {
  [ -n "${ZOTERO_PROFILES_ROOT:-}" ] && [ -d "$ZOTERO_PROFILES_ROOT" ] && { echo "$ZOTERO_PROFILES_ROOT"; return; }
  local c
  for c in \
    "$HOME/.zotero/zotero" \
    "$HOME/Library/Application Support/Zotero/Profiles" ; do
    [ -d "$c" ] && { echo "$c"; return; }
  done
  # Windows 侧（WSL）：把 /mnt/c/Users/<任意用户> 都扫一遍，不假定用户名
  if [ -d /mnt/c/Users ]; then
    for u in /mnt/c/Users/*/AppData/Roaming/Zotero/Zotero/Profiles; do
      [ -d "$u" ] && { echo "$u"; return; }
    done
  fi
}
PROFILES_ROOT="$(find_profiles_root)"

# 有 profiles.ini 时按它找默认 profile
PROFILE_DIR="${ZOTERO_PROFILE:-}"
if [ -z "$PROFILE_DIR" ] && [ -n "$PROFILES_ROOT" ]; then
  if [ -f "$PROFILES_ROOT/profiles.ini" ]; then
    rel="$(awk -F= '/^\[Profile/{p=1} p&&/^Path=/{print $2; exit}' "$PROFILES_ROOT/profiles.ini" 2>/dev/null)"
    [ -n "$rel" ] && [ -d "$PROFILES_ROOT/$rel" ] && PROFILE_DIR="$PROFILES_ROOT/$rel"
  fi
fi
# 兜底：取第一个 *.default
if [ -z "$PROFILE_DIR" ] && [ -n "$PROFILES_ROOT" ]; then
  for d in "$PROFILES_ROOT"/*.default "$PROFILES_ROOT"/*/; do
    [ -d "$d" ] && PROFILE_DIR="${d%/}" && break
  done
fi

# ───────────────────────── 数据目录：优先读 prefs.js 里的 dataDir
DATA_DIR="${ZOTERO_DATA:-}"
if [ -z "$DATA_DIR" ] && [ -n "$PROFILE_DIR" ] && [ -f "$PROFILE_DIR/prefs.js" ]; then
  DATA_DIR="$(python3 - "$PROFILE_DIR/prefs.js" <<'PY' 2>/dev/null || true
import re, sys
try:
    s = open(sys.argv[1], encoding="utf8", errors="replace").read()
except Exception:
    sys.exit(0)
m = re.search(r'user_pref\("extensions\.zotero\.dataDir",\s*"((?:[^"\\]|\\.)*)"\)', s)
if m:
    # prefs.js 里是 UTF-8 原始字符串；只反转义 \\ 与 \"
    print(m.group(1).replace('\\\\', '\\').replace('\\"', '"'))
PY
)"
fi
[ -z "$DATA_DIR" ] && [ -n "$PROFILE_DIR" ] && [ -d "$HOME/Zotero" ] && DATA_DIR="$HOME/Zotero"

# WSL 里数据目录常是 Windows 路径 → 转成 /mnt/... 方便脚本读写
DATA_DIR_POSIX="$DATA_DIR"
case "$DATA_DIR" in
  [A-Za-z]:\\*)
    drive="$(printf '%s' "${DATA_DIR%%:*}" | tr 'A-Z' 'a-z')"
    rest="$(printf '%s' "${DATA_DIR#*:}" | tr '\\' '/')"
    DATA_DIR_POSIX="/mnt/$drive$rest"
    ;;
esac

# ───────────────────────── 工具链
NODE="$(command -v node || true)"
NPM="$(command -v npm || true)"
PY="$(command -v python3 || true)"

# ───────────────────────── Zotero 版本（从 application.ini / omni.ja 读）
ZOTERO_VER=""
for c in "$ZOTERO_DIR/application.ini" "$ZOTERO_DIR/app/application.ini" \
         "/mnt/c/Program Files/Zotero/application.ini"; do
  if [ -f "$c" ]; then
    ZOTERO_VER="$(awk -F= '/^\[App\]/{a=1} a&&/^Version=/{print $2; exit}' "$c" | tr -d '\r')"
    [ -n "$ZOTERO_VER" ] && break
  fi
done

# ───────────────────────── 已装插件版本（extensions.json）
PLUGIN_ID="zoteropdftranslate@euclpts.com"
SI_PLUGIN_ID="suppl-dl@example.com"
PLUGIN_VER=""; SI_PLUGIN_VER=""
if [ -n "$PROFILE_DIR" ] && [ -f "$PROFILE_DIR/extensions.json" ]; then
  read -r PLUGIN_VER SI_PLUGIN_VER <<EOF
$(python3 - "$PROFILE_DIR/extensions.json" "$PLUGIN_ID" "$SI_PLUGIN_ID" <<'PY' 2>/dev/null || echo " "
import json, sys
try:
    d = json.load(open(sys.argv[1], encoding="utf8"))
except Exception:
    print(" "); raise SystemExit
want = {a.get("id"): a.get("version", "") for a in d.get("addons", [])}
print(want.get(sys.argv[2], "-"), want.get(sys.argv[3], "-"))
PY
)
EOF
fi

# ───────────────────────── 输出
say ""
say "ZOTERO_DIR      = ${ZOTERO_DIR:-（没找到）}"
say "PROFILES_ROOT   = ${PROFILES_ROOT:-（没找到）}"
say "PROFILE_DIR     = ${PROFILE_DIR:-（没找到）}"
say "DATA_DIR        = ${DATA_DIR:-（没找到）}"
say "DATA_DIR_POSIX  = ${DATA_DIR_POSIX:-（没找到）}"
say "STORAGE_DIR     = ${DATA_DIR_POSIX:+$DATA_DIR_POSIX/storage}"
say "ZOTERO_VERSION  = ${ZOTERO_VER:-（没读到）}"
say "已装翻译插件     = ${PLUGIN_VER:-（未装）}"
say "已装 SI 插件     = ${SI_PLUGIN_VER:-（未装）}"
say "node/npm/python3= ${NODE:-✗} / ${NPM:-✗} / ${PY:-✗}"

if [ "$SHOW_ONLY" = 1 ]; then exit 0; fi

mkdir -p "$(dirname "$CONF")"
cat > "$CONF" <<EOF
# 由 scripts/discover_env.sh 生成（$(date '+%Y-%m-%d %H:%M:%S')）
# 探测不到的项请手动填 —— 脚本只在非空时才用它做安装。
OS=$OS
ZOTERO_DIR=$ZOTERO_DIR
ZOTERO_EXE=
PROFILES_ROOT=$PROFILES_ROOT
PROFILE_DIR=$PROFILE_DIR
DATA_DIR=$DATA_DIR
DATA_DIR_POSIX=$DATA_DIR_POSIX
STORAGE_DIR=${DATA_DIR_POSIX:+$DATA_DIR_POSIX/storage}
PS=$PS
PLUGIN_ID=$PLUGIN_ID
SI_PLUGIN_ID=$SI_PLUGIN_ID
ZOTERO_VERSION=$ZOTERO_VER
EOF

# Windows 上的 exe 路径（安装/重启用）
if [ -n "$ZOTERO_DIR" ] && [ -f "$ZOTERO_DIR/zotero.exe" ]; then
  echo "ZOTERO_EXE=$ZOTERO_DIR/zotero.exe" >> "$CONF"
fi
say ""
say "已写入 $CONF"
say "（这些路径只被「安装/重启 Zotero」这类脚本用到；"
say "  补丁与全部离线测试**不需要**它们 —— 所以在任何机器上都能验。）"
