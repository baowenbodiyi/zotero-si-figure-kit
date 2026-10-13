#!/usr/bin/env bash
# ⭐ 一键跑完**全部离线验收**（不需要 Zotero，不需要联网）。
#
# 做两件事：
#   1. 用 esbuild 把「要发布的源码」里那几个模块编成 CJS（测的就是要发布的那份）
#   2. 依次跑 4 组测试，最后汇总
#
# 环境变量（都有默认值，通常不用给）：
#   ZPT_SRC       打过补丁的源码树（默认 work/translate）
#   ZPT_BUILD     构建产物目录（默认 $TMPDIR/zpt-verify）
#   ZPT_FIXTURES  fixture 目录（默认 tests/fixtures）
#   ZPT_SI_TEXT / ZPT_MAIN_TEXT / ZPT_CACHE
#                 有真数据时可指向真文件，会多跑"真机"分支
set -uo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"

export ZPT_SRC="${ZPT_SRC:-$HERE/work/translate}"
export ZPT_BUILD="${ZPT_BUILD:-${TMPDIR:-/tmp}/zpt-verify}"
export ZPT_FIXTURES="${ZPT_FIXTURES:-$HERE/tests/fixtures}"
mkdir -p "$ZPT_BUILD"

ESB="$ZPT_SRC/node_modules/.bin/esbuild"
[ -x "$ESB" ] || { echo "❌ 缺 esbuild（$ESB）。先跑 bash scripts/prepare_src.sh && bash scripts/setup_deps.sh"; exit 1; }
[ -d "$ZPT_FIXTURES" ] || { echo "❌ 缺 fixture 目录 $ZPT_FIXTURES"; exit 1; }

echo "== 编译要发布的源码（就是插件里跑的那几个模块）=="
for m in inflate tiff docx siRefs pngEncode debugLog mathRenderer; do
  "$ESB" "$ZPT_SRC/src/utils/$m.ts" \
    --bundle --format=cjs --platform=node \
    --outfile="$ZPT_BUILD/$m.cjs" --log-level=warning || {
      echo "❌ 编译 $m.ts 失败"; exit 1; }
  printf '  ✅ %s.cjs\n' "$m"
done

rc=0
run() {
  echo ""
  echo "────────────────────────────────────────────────────────────"
  echo "▶ $2"
  echo "────────────────────────────────────────────────────────────"
  ( cd "$HERE/tests" && node "$1" ) || rc=1
}

run test_renderspacing.js "1/4 译文渲染（段落间距 / <br> 语义）"
run test_sirefs.js       "2/4 SI 引用解析与图注定位"
run test_pngencode.js    "3/4 PNG 编码器 / base64"
run test_wordsi.js       "4/4 Word 版 SI（docx / TIFF / inflate / 端到端）"

echo ""
echo "════════════════════════════════════════════════════════════"
if [ "$rc" = 0 ]; then
  echo "✅ 全部离线验收通过"
  echo "   （SKIP 的小节表示本机没有那类真数据；kit 自带的 fixture 已覆盖同一代码路径）"
else
  echo "❌ 有测试失败 —— 看上面 ❌ 的明细"
fi
echo "════════════════════════════════════════════════════════════"
exit $rc
