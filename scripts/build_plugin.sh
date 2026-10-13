#!/usr/bin/env bash
# 构建插件 XPI（在 work/translate 上：先类型检查，再打包）。
#
# ⚠️ 关键：`zotero-plugin build` 用 esbuild，**不做类型检查** ——
#    所以必须先 `tsc --noEmit`，否则类型错误会静默打进产物。
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib/host.sh
. "$HERE/scripts/lib/host.sh"
SRC="$HERE/work/translate"
[ -d "$SRC/src" ] || { echo "❌ 先跑 bash scripts/prepare_src.sh"; exit 1; }

export XDG_CACHE_HOME="${XDG_CACHE_HOME:-$HERE/.cache}"

echo "== 1/3 类型检查（tsc --noEmit）=="
( cd "$SRC" && npx tsc --noEmit )
echo "  ✅ 类型检查通过"

echo "== 2/3 打包（zotero-plugin build）=="
( cd "$SRC" && npx zotero-plugin build 2>&1 | grep -vE "^npm warn" | tail -3 )

XPI="$SRC/build/translate-for-zotero.xpi"
[ -f "$XPI" ] || { echo "❌ 没产出 $XPI"; exit 1; }

echo "== 3/3 校验产物里真有本次源码的构建标记 =="
# 为什么必须验：曾出现「磁盘上的 XPI 有新代码、AddonManager 也报新版本，
# 但运行时跑的还是旧逻辑」。让产物自己说出 BUILD_TAG，是唯一可靠的判据。
TAG="$(host_build_tag "$SRC/src/utils/debugLog.ts")"
[ -n "$TAG" ] || { echo "❌ 从 $SRC/src/utils/debugLog.ts 读不到 BUILD_TAG"; exit 1; }
VER="$(host_py -c "import json;print(json.load(open('$SRC/package.json'))['version'])")"
host_py - "$XPI" "$TAG" "$VER" <<'PY'
import re, sys, zipfile
xpi, tag, ver = sys.argv[1], sys.argv[2], sys.argv[3]
z = zipfile.ZipFile(xpi)
js = b"".join(z.read(n) for n in z.namelist() if n.endswith(".js"))
m = re.search(rb'"version"\s*:\s*"([^"]+)"', z.read("manifest.json"))
print(f"  产物版本 {m.group(1).decode()} / 期望 {ver}")
assert m.group(1).decode() == ver, "manifest 版本不符"
assert tag.encode() in js, f"产物的 JS 里找不到 BUILD_TAG {tag}"
print(f"  ✅ 产物里确认含 build={tag}")
print(f"  XPI: {xpi}  {__import__('os').path.getsize(xpi)} 字节")
PY
echo ""
echo "下一步： bash scripts/install_plugin.sh"
