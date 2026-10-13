#!/usr/bin/env bash
# 把补丁打到「上游 v2.4.8 源码树」上，产出 work/translate（打过补丁的完整源码）。
#
# 上游源码从哪来（按优先级）：
#   1. $1 指定的目录
#   2. plugins/translate/pristine-v2.4.8/（本 kit 自带的上游副本，可离线）
#   3. ZPT_PRISTINE 环境变量
#
# 完成后会**自洽校验**：work/translate/src 必须与 patch 声明的结果一致。
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"

PATCH="$(ls -1 "$HERE"/plugins/translate/zotero-pdf-translate-*-full.patch 2>/dev/null | sort -V | tail -1)"
[ -n "$PATCH" ] || { echo "❌ 找不到补丁（plugins/translate/*-full.patch）"; exit 1; }

PRISTINE="${1:-${ZPT_PRISTINE:-}}"
[ -n "$PRISTINE" ] || PRISTINE="$HERE/plugins/translate/pristine-v2.4.8"
[ -d "$PRISTINE" ] || {
  echo "❌ 找不到上游源码树：$PRISTINE"
  echo "   先跑 bash scripts/fetch_upstream.sh 去 clone 上游 v2.4.8，"
  echo "   或把已有的 pristine 目录作为 \$1 传进来。"
  exit 1
}

DEST="$HERE/work/translate"
echo "== 打补丁 =="
echo "  上游 : $PRISTINE"
echo "  补丁 : $(basename "$PATCH")"
echo "  输出 : $DEST"

rm -rf "$DEST"
mkdir -p "$(dirname "$DEST")"
cp -a "$PRISTINE" "$DEST"
# 上游树里可能带 node_modules（如果是从别人机器上拷的），别跟着一起复制太久
rm -rf "$DEST/node_modules" "$DEST/build" "$DEST/.git"

( cd "$DEST" && patch -p1 --no-backup-if-mismatch < "$PATCH" >/dev/null )
echo "  补丁应用完成"

# ── 自洽校验：补丁里声明的新文件必须真的在
missing=0
while read -r f; do
  [ -e "$DEST/$f" ] || { echo "  ❌ 补丁说会有 $f，但不存在"; missing=1; }
done < <(grep -oP '^\+\+\+ src/\K.*' "$PATCH" | sed 's/\t.*//' | sort -u)
[ "$missing" = 0 ] && echo "  ✅ 补丁涉及的文件全部就位（$(grep -c '^diff -ruN' "$PATCH") 个）"

# ── 版本自检
VER="$(python3 -c "import json;print(json.load(open('$DEST/package.json'))['version'])")"
TAG="$(grep -oP 'BUILD_TAG = "\K[^"]+' "$DEST/src/utils/debugLog.ts" 2>/dev/null || echo '?')"
echo "  package.json version = $VER   BUILD_TAG = $TAG"
echo ""
echo "下一步： bash scripts/setup_deps.sh   （npm ci）"
echo "然后：   bash scripts/verify_all.sh   （全部离线验收）"
