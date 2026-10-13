#!/usr/bin/env bash
# 把构建好的 XPI 装进 Zotero，并**证明运行时真的加载了它**。
#
# 读 conf/kit.conf（先跑 scripts/discover_env.sh）。探测不到就打印"手工安装"步骤，
# 绝不硬猜 —— 猜错会装到一个不存在的 profile 里，还很像成功。
#
# 平台差异全部由 scripts/lib/host.sh 兜住（wsl / windows / linux / macos）。
#
# ⚠️ 这里沉淀了四个实测坑，每一条都骗过人：
#   1. `tasklist.exe | grep zotero` 输出不可靠 → 明明在跑却说没跑，
#      于是在 Zotero 运行中换文件，装的其实一直没生效。一律用 `Get-Process`。
#   2. /mnt/c 是 9p 挂载，**覆盖已存在的文件会 Errno 22** → 必须 rm 再写。
#   3. **9p 有写回延迟**：刚 cp 完就启动 Zotero，它会读到旧字节 →
#      "文件是新的、跑的是旧的"这种假失败。所以：写完立刻**回读产物里的
#      BUILD_TAG** 核对，等不到标记就**重启一次再判**。
#   4. ⭐ 非 WSL 平台上「查进程」以前恒返回空 → 脚本打印「已确认退出」但
#      Zotero 其实还开着（假确认）。现在 linux/macos 走 `pgrep -x zotero`。
set -uo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib/host.sh
. "$HERE/scripts/lib/host.sh"
CONF="$HERE/conf/kit.conf"

if [ ! -f "$CONF" ]; then
  echo "❌ 缺 $CONF —— 先跑 bash scripts/discover_env.sh"; exit 1
fi
# shellcheck disable=SC1090
. "$CONF"

XPI="$HERE/work/translate/build/translate-for-zotero.xpi"
TAG="$(host_build_tag "$HERE/work/translate/src/utils/debugLog.ts")"
VER="$(host_py -c "import json;print(json.load(open('$HERE/work/translate/package.json'))['version'])" 2>/dev/null || true)"
[ -f "$XPI" ] || { echo "❌ 缺 $XPI —— 先跑 bash scripts/build_plugin.sh"; exit 1; }

manual_install() {
  cat <<EOF
❌ $1

请手工装（任何平台都一样）：
   1. Zotero → 工具 → 插件 → 右上齿轮 → Install Plugin From File… → 选
        $XPI
   2. 重启 Zotero
   3. 看数据目录下的 zpt-debug.log，确认出现
        [boot] hooks.onStartup done | build=$TAG
   （不要求脚本化安装：补丁与全部离线测试都不依赖这一步。）
EOF
}

if [ -z "${PROFILE_DIR:-}" ] || [ ! -d "${PROFILE_DIR:-/nonexistent}" ]; then
  manual_install "探测不到 Zotero profile（conf/kit.conf 里 PROFILE_DIR 为空）"
  exit 1
fi

EXT="zoteropdftranslate@euclpts.com"
DST="$PROFILE_DIR/extensions/$EXT.xpi"
LOG="${DATA_DIR_POSIX:-}/zpt-debug.log"

echo "== 宿主：$HOST_OS =="
echo "== 目标：版本 $VER / build=${TAG:-?} =="
echo "   profile : $PROFILE_DIR"
echo "   日志     : ${LOG:-（未探测到数据目录）}"
echo "   当前 PID : [$(host_zotero_pids)]"

# ── 1. 关掉 Zotero（必须真关，否则改文件不生效，而且它退出时会回写 extensions.json）
echo "关闭 Zotero（强制）…"
if ! host_zotero_stop; then
  echo "!! Zotero 没关掉：$(host_zotero_pids)"
  echo "   （Zotero 在运行时会回写 extensions.json，装不进去）"
  exit 1
fi
echo "  已确认退出（宿主 $HOST_OS 上真的查过进程，不是空的假确认）"

# ── 2. 换 XPI（先删后写 —— 9p 覆盖写会失败）
rm -f "$DST"
cp "$XPI" "$DST"
[ "$(host_size "$DST")" = "$(host_size "$XPI")" ] || { echo "!! XPI 大小不一致"; exit 1; }

# ── 3. 同步 extensions.json（Zotero 已退出，不会被它回写覆盖）
host_py - "$PROFILE_DIR" "$EXT" "$VER" <<'PY'
import json, os, sys, time
prof, ext, ver = sys.argv[1:4]
p = os.path.join(prof, "extensions.json")
d = json.load(open(p, encoding="utf-8"))
hit = next((a for a in d.get("addons", []) if a.get("id") == ext), None)
if hit is None:
    sys.exit("!! extensions.json 里没有 " + ext)
old = hit.get("version")
hit["version"] = ver
hit["updateDate"] = int(time.time() * 1000)
hit.pop("updateURL", None)   # 免得它自己回滚到上游版本
json.dump(d, open(p + ".tmp", "w", encoding="utf-8"), ensure_ascii=False)
os.remove(p)                  # 9p 上覆盖写会失败
os.rename(p + ".tmp", p)
print(f"  extensions.json: {old} -> {ver}")
PY

# ── 4. 清启动缓存
rm -f "$PROFILE_DIR/addonStartup.json.lz4"
rm -rf "$PROFILE_DIR/startupCache"
echo "  启动缓存已清"

# ── 5. 回读断言：从 profile 里那份 XPI 中把 BUILD_TAG 解出来（挡住 9p 缓存）
RB="$(host_xpi_build_tag "$DST" | tr -d '\r')"
if [ -n "$TAG" ] && [ "$RB" != "$TAG" ]; then
  echo "⚠️  刚写完回读到 [$RB]（应为 $TAG）—— 9p 写回延迟，重写一次"
  sleep 2; rm -f "$DST"; cp "$XPI" "$DST"; sync 2>/dev/null || true
  RB="$(host_xpi_build_tag "$DST" | tr -d '\r')"
fi
echo "  回读 profile 内 XPI 的构建标记：[${RB:-读不到}]"
if [ -n "$TAG" ] && [ "$RB" != "$TAG" ]; then
  echo "  ⚠️ 回读仍不符 —— 下面靠启动日志做最终裁决"
fi

# ── 6. 启动 + 等启动标记（等不到就再重启一次）
LOG_START=0; [ -f "$LOG" ] && LOG_START="$(host_size "$LOG")"
newlog() {
  local now; now="$(host_size "$LOG" 2>/dev/null || echo 0)"
  [ -n "$now" ] || now=0
  if [ "$now" -ge "${LOG_START:-0}" ]; then
    host_log_tail_from "$LOG" "$LOG_START"
  else
    tail -n 15 "$LOG"
  fi
}
wait_tag() {
  [ -n "$LOG" ] && [ -f "$LOG" ] || return 1
  for _ in $(seq 1 30); do
    sleep 2
    newlog 2>/dev/null | grep -q "\[boot\] hooks.onStartup done | build=$TAG" && return 0
  done
  return 1
}
start_zotero() {
  LOG_START=0; [ -f "$LOG" ] && LOG_START="$(host_size "$LOG")"
  if [ -z "${ZOTERO_EXE:-}" ]; then
    echo "  ⚠️ kit.conf 里没有 ZOTERO_EXE，请手工启动 Zotero（然后等标记自己出现）"; return 0
  fi
  host_zotero_start "$ZOTERO_EXE"
}

echo "启动 Zotero…"
start_zotero
if [ -n "$LOG" ] && [ -f "$LOG" ] && wait_tag; then
  echo "✅ 启动标记已确认：build=$TAG"
  newlog | grep "\[boot\]" | tail -2
elif [ -z "$LOG" ] || [ ! -f "$LOG" ]; then
  echo "  ⚠️ 读不到日志 $LOG —— 无法自动裁决。请手工确认日志里出现 build=$TAG"
else
  echo "  没等到标记，再重启一次（区分「真没装上」与「读到旧缓存」）…"
  host_zotero_stop || true
  rm -f "$PROFILE_DIR/addonStartup.json.lz4"; rm -rf "$PROFILE_DIR/startupCache"
  start_zotero
  if wait_tag; then
    echo "✅ 第二次启动确认：build=$TAG"
  else
    echo "❌ 两次启动都没出现 build=$TAG —— 插件没加载这份代码（别当成功）"
    echo "   （profile 内 XPI 回读到的标记：${RB:-读不到}）"
    newlog | tail -5
    exit 1
  fi
fi
echo ""
echo "== 装完：版本 $VER，运行中的构建 = $TAG =="
