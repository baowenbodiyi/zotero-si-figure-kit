#!/usr/bin/env bash
# 把构建好的 XPI 装进 Zotero，并**证明运行时真的加载了它**。
#
# 读 conf/kit.conf（先跑 scripts/discover_env.sh）。只支持本脚本熟悉的路径；
# 其它平台会打印"手工安装"的步骤而不是硬猜。
#
# ⚠️ 这里沉淀了三个实测坑，每一条都骗过人：
#   1. `tasklist.exe | grep zotero` 输出不可靠 → 明明在跑却说没跑，
#      于是在 Zotero 运行中换文件，装的其实一直没生效。一律用 `Get-Process`。
#   2. /mnt/c 是 9p 挂载，**覆盖已存在的文件会 Errno 22** → 必须 rm 再写。
#   3. **9p 有写回延迟**：刚 cp 完就启动 Zotero，它会读到旧字节 →
#      出现"文件是新的、跑的是旧的"这种假失败。所以：写完立刻**回读产物里的
#      BUILD_TAG** 核对，等不到标记就**重启一次再判**。
set -uo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
CONF="$HERE/conf/kit.conf"

if [ ! -f "$CONF" ]; then
  echo "❌ 缺 $CONF —— 先跑 bash scripts/discover_env.sh"; exit 1
fi
# shellcheck disable=SC1090
. "$CONF"

XPI="$HERE/work/translate/build/translate-for-zotero.xpi"
TAG="$(grep -oP 'BUILD_TAG = "\K[^"]+' "$HERE/work/translate/src/utils/debugLog.ts" 2>/dev/null || true)"
VER="$(python3 -c "import json;print(json.load(open('$HERE/work/translate/package.json'))['version'])" 2>/dev/null || true)"
[ -f "$XPI" ] || { echo "❌ 缺 $XPI —— 先跑 bash scripts/build_plugin.sh"; exit 1; }

if [ -z "${PROFILE_DIR:-}" ] || [ ! -d "${PROFILE_DIR:-/nonexistent}" ]; then
  cat <<'EOF'
❌ 探测不到 Zotero profile。请手工装：
   1. Zotero → 工具 → 插件 → 右上齿轮 → Install Plugin From File… → 选
        work/translate/build/translate-for-zotero.xpi
   2. 重启 Zotero
   3. 工具 → 开发者 → Run JavaScript，或看数据目录下的 zpt-debug.log，
      确认出现 `[boot] hooks.onStartup done | build=<BUILD_TAG>`
   （不要求脚本化安装：补丁与全部离线测试都不依赖这一步。）
EOF
  exit 1
fi

EXT="zoteropdftranslate@euclpts.com"
DST="$PROFILE_DIR/extensions/$EXT.xpi"
LOG="${DATA_DIR_POSIX:-}/zpt-debug.log"

zotero_pids() {
  [ -n "${PS:-}" ] || return 0
  "$PS" -NoProfile -Command "@(Get-Process zotero -ErrorAction SilentlyContinue).Id -join ' '" 2>/dev/null | tr -d '\r' | xargs
}

echo "== 目标：版本 $VER / build=$TAG =="
echo "   profile : $PROFILE_DIR"
echo "   日志     : $LOG"
echo "   当前 PID : [$(zotero_pids)]"

# ── 1. 关掉 Zotero（必须真关，否则改文件不生效）
echo "关闭 Zotero（强制）…"
"$PS" -NoProfile -Command "Get-Process zotero -ErrorAction SilentlyContinue | Stop-Process -Force" >/dev/null 2>&1 || true
for _ in $(seq 1 30); do [ -z "$(zotero_pids)" ] && break; sleep 1; done
[ -z "$(zotero_pids)" ] || { echo "!! Zotero 没关掉：$(zotero_pids)"; exit 1; }
echo "  已确认退出"

# ── 2. 换 XPI（先删后写 —— 9p 覆盖写会失败）
rm -f "$DST"
cp "$XPI" "$DST"
[ "$(stat -c%s "$DST")" = "$(stat -c%s "$XPI")" ] || { echo "!! XPI 大小不一致"; exit 1; }

# ── 3. 同步 extensions.json（Zotero 已退出，不会被它回写覆盖）
python3 - "$PROFILE_DIR" "$EXT" "$VER" <<'PY'
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
readback() {
  python3 - "$DST" <<'PY' 2>/dev/null || true
import re, sys, zipfile
try:
    z = zipfile.ZipFile(sys.argv[1])
    for n in z.namelist():
        if n.endswith(".js"):
            m = re.findall(rb'BUILD_TAG = "([^"]+)"', z.read(n))
            if m:
                print(m[0].decode()); break
except Exception:
    pass
PY
}
RB="$(readback | tr -d '\r')"
if [ -n "$TAG" ] && [ "$RB" != "$TAG" ]; then
  echo "⚠️  刚写完回读到 [$RB]（应为 $TAG）—— 9p 写回延迟，重写一次"
  sleep 2; rm -f "$DST"; cp "$XPI" "$DST"; sync
  RB="$(readback | tr -d '\r')"
fi
echo "  回读 profile 内 XPI 的构建标记：[${RB:-读不到}]"

# ── 6. 启动 + 等启动标记（等不到就再重启一次）
LOG_START=0; [ -f "$LOG" ] && LOG_START=$(stat -c%s "$LOG")
newlog() {
  local now; now=$(stat -c%s "$LOG" 2>/dev/null || echo 0)
  if [ "$now" -ge "$LOG_START" ]; then tail -c "+$((LOG_START + 1))" "$LOG"; else tail -n 15 "$LOG"; fi
}
wait_tag() {
  for _ in $(seq 1 30); do
    sleep 2
    newlog 2>/dev/null | grep -q "\[boot\] hooks.onStartup done | build=$TAG" && return 0
  done
  return 1
}
start_zotero() {
  LOG_START=$(stat -c%s "$LOG" 2>/dev/null || echo 0)
  if [ -z "${ZOTERO_EXE:-}" ]; then
    echo "  ⚠️ kit.conf 里没有 ZOTERO_EXE，请手工启动 Zotero（然后等标记自己出现）"; return 0
  fi
  if [ -n "${PS:-}" ]; then
    # WSL：把 /mnt/c/... 转成 C:\... 交给 PowerShell 启动
    win_exe="$(printf '%s' "$ZOTERO_EXE" | sed 's|^/mnt/\([a-z]\)|\1:|; s|/|\\|g')"
    "$PS" -NoProfile -Command "Start-Process '$win_exe'" >/dev/null 2>&1
  else
    ( "$ZOTERO_EXE" >/dev/null 2>&1 & )
  fi
}

echo "启动 Zotero…"
start_zotero
if wait_tag; then
  echo "✅ 启动标记已确认：build=$TAG"
  newlog | grep "\[boot\]" | tail -2
else
  echo "  没等到标记，再重启一次（区分「真没装上」与「读到旧缓存」）…"
  "$PS" -NoProfile -Command "Get-Process zotero -ErrorAction SilentlyContinue | Stop-Process -Force" >/dev/null 2>&1 || true
  for _ in $(seq 1 30); do [ -z "$(zotero_pids)" ] && break; sleep 1; done
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
