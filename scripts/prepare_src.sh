#!/usr/bin/env bash
# 准备「打过补丁的完整源码树」→ work/translate
#
# ⭐ 为什么不用 patch(1)：
#    插件是 TypeScript，构建只要有 Node。而 Windows 干净系统**没有 patch、没有 git**
#    （实测：node ✅ / patch ❌ / git ❌），装它们比装 Node 麻烦得多。
#    所以 kit 把补丁结果预先摊成了覆盖层 plugins/translate/patched-<ver>/，
#    本脚本 = 复制 pristine + 盖上覆盖层，**任何平台都不需要 patch**。
#    有 patch(1) 的机器会额外做一次「覆盖层 == 补丁结果」的逐字节比对（防漂移）。
#
# 上游源码从哪来（按优先级）：
#   1. $1 指定的目录
#   2. plugins/translate/pristine-v2.4.8/（kit 自带，可离线）
#   3. ZPT_PRISTINE 环境变量
#
# 用法： bash scripts/prepare_src.sh [pristine 目录]
set -uo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib/host.sh
. "$HERE/scripts/lib/host.sh"

PATCH="$(ls -1 "$HERE"/plugins/translate/zotero-pdf-translate-*-full.patch 2>/dev/null | host_latest)"
OVERLAY="$(ls -d "$HERE"/plugins/translate/patched-*/ 2>/dev/null | host_latest)"
[ -n "$PATCH" ]   || { echo "❌ 找不到补丁（plugins/translate/*-full.patch）"; exit 1; }
[ -n "$OVERLAY" ] || { echo "❌ 找不到覆盖层（plugins/translate/patched-*/）"; exit 1; }
OVERLAY="${OVERLAY%/}"

PRISTINE="${1:-${ZPT_PRISTINE:-}}"
[ -n "$PRISTINE" ] || PRISTINE="$HERE/plugins/translate/pristine-v2.4.8"
[ -d "$PRISTINE" ] || {
  echo "❌ 找不到上游源码树：$PRISTINE"
  echo "   先跑 bash scripts/fetch_upstream.sh 去 clone 上游 v2.4.8，"
  echo "   或把已有的 pristine 目录作为 \$1 传进来。"
  exit 1
}

DEST="$HERE/work/translate"
echo "== 准备源码树（宿主 = ${HOST_OS}）=="
echo "  上游   : $PRISTINE"
echo "  覆盖层 : $(basename "$OVERLAY")"
echo "  补丁   : $(basename "$PATCH")  （仅用于自洽校验）"
echo "  输出   : $DEST"

rm -rf "$DEST"
mkdir -p "$(dirname "$DEST")"
cp -a "$PRISTINE" "$DEST"
# 上游树里可能带 node_modules（如果是从别人机器上拷的），别跟着一起复制太久。
# ⚠️ 只删**构建产物/版本控制目录**。`typings/` 是上游受控的源码（3 个 .d.ts），
#    删了会让 tsc 报几百个 "Cannot find name 'Ztoolkit'" —— 别手贱加进这个列表。
rm -rf "$DEST/node_modules" "$DEST/build" "$DEST/.git" "$DEST/.cache" "$DEST/tsconfig.tsbuildinfo"
# 盖覆盖层（-a 保留时间戳；用 /. 是为了「拷内容」而不是「拷目录本身」）
cp -a "$OVERLAY/." "$DEST/"
echo "  已应用覆盖层（$(find "$OVERLAY" -type f | wc -l | tr -d ' ') 个文件）"

# ── 自洽校验：覆盖层必须真的等于补丁结果（没有 patch(1) 的机器会跳过，不算失败）
echo ""
echo "== 自洽校验 =="
host_py "$HERE/scripts/lib/check_overlay.py" "$PRISTINE" "$PATCH" "$OVERLAY"
CKR=$?
if [ "$CKR" = 1 ]; then
  echo "❌ 覆盖层与补丁漂移 —— 中止（继续下去会构建出与补丁不符的代码）"
  exit 1
fi

# ── 补丁声明的文件必须都就位
missing=0
while read -r f; do
  [ -n "$f" ] || continue
  [ -e "$DEST/$f" ] || { echo "  ❌ 补丁说会有 ${f}，但不存在"; missing=1; }
done <<EOF
$(host_patch_files "$PATCH")
EOF
N_PATCHED="$(host_patch_files "$PATCH" | wc -l | tr -d ' ')"
[ "$missing" = 0 ] && echo "  ✅ 补丁涉及的文件全部就位（$N_PATCHED 个）"
[ "$missing" = 0 ] || exit 1

# ── 版本自检
VER="$(host_py -c "import json;print(json.load(open('$DEST/package.json'))['version'])" 2>/dev/null || echo '?')"
TAG="$(host_build_tag "$DEST/src/utils/debugLog.ts")"
echo "  package.json version = $VER   BUILD_TAG = ${TAG:-?}"
echo ""
echo "下一步： bash scripts/setup_deps.sh   （npm ci）"
echo "然后：   bash scripts/verify_all.sh   （全部离线验收）"
