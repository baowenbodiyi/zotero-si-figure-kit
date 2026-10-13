#!/usr/bin/env bash
# 可选：从上游 clone 出 v2.4.8 源码树（补丁的基线）。
#
# kit 里已经自带一份上游副本（plugins/translate/pristine-v2.4.8），
# 所以**离线也能用**。这个脚本是给"想自己核一遍上游来源"或"想换基线"的人用的。
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${1:-$HERE/plugins/translate/upstream-zotero-pdf-translate}"
TAG="${2:-v2.4.8}"

command -v git >/dev/null || { echo "❌ 没有 git"; exit 1; }

echo "== clone windingwind/zotero-pdf-translate @ $TAG =="
rm -rf "$DEST"
git clone --depth 1 --branch "$TAG" \
  https://github.com/windingwind/zotero-pdf-translate.git "$DEST"

echo ""
echo "拿到 $(git -C "$DEST" rev-parse --short HEAD)  $TAG"
echo "版本号：$(python3 -c "import json;print(json.load(open('$DEST/package.json'))['version'])")"
echo ""
echo "核对补丁能不能打上（不改东西，只 dry-run）："
PATCH="$(ls -1 "$HERE"/plugins/translate/zotero-pdf-translate-*-full.patch | sort -V | tail -1)"
if ( cd "$DEST" && patch -p1 --dry-run < "$PATCH" >/dev/null 2>&1 ); then
  echo "  ✅ 补丁可干净应用"
else
  echo "  ❌ 打不上 —— 上游这个 tag 与你手上的补丁基线不一致"
  ( cd "$DEST" && patch -p1 --dry-run < "$PATCH" 2>&1 | grep -E "FAILED|Reversed|hunk" | head )
fi
echo ""
echo "要用它当基线： bash scripts/apply_patch.sh $DEST"
