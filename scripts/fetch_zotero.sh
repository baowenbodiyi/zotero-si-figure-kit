#!/usr/bin/env bash
# 下载并校验与插件适配的 Zotero 安装包（默认 9.0.6 / Windows x64）。
#
# 包里已经带了这一份（vendor/zotero/）；这个脚本用于：
#   · 你没要那份 90 MB 的二进制，想现场拉
#   · 想换版本/换平台
#
# 用法： bash scripts/fetch_zotero.sh [版本] [平台]
#   平台： win-x64（默认）| mac | linux-x86_64
#
# 已实测可用的三个地址（2026-10-12，HTTP 200）：
#   https://download.zotero.org/client/release/9.0.6/Zotero-9.0.6_x64_setup.exe          95,241,152 字节
#   https://download.zotero.org/client/release/9.0.6/Zotero-9.0.6.dmg                  178,020,003 字节
#   https://download.zotero.org/client/release/9.0.6/Zotero-9.0.6_linux-x86_64.tar.xz  103,967,044 字节
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
VER="${1:-9.0.6}"
PLAT="${2:-win-x64}"

case "$PLAT" in
  win-x64)  FILE="Zotero-${VER}_x64_setup.exe" ;;
  mac)      FILE="Zotero-${VER}.dmg" ;;
  linux-x86_64) FILE="Zotero-${VER}_linux-x86_64.tar.xz" ;;   # 实测是 .tar.xz（.tar.bz2 会 403）
  *) echo "不认识的平台: $PLAT"; exit 1 ;;
esac
URL="https://download.zotero.org/client/release/${VER}/${FILE}"
OUT="$HERE/vendor/zotero/$FILE"

# 已知版本的哈希（只钉我们验证过的那一个）
declare -A KNOWN=(
  ["9.0.6/Zotero-9.0.6_x64_setup.exe"]="973bfc96a7af8b2949bbfdc46b220366b2b204942ac30d50aef9835eb152d31c"
)
WANT="${KNOWN["$VER/$FILE"]:-}"

mkdir -p "$HERE/vendor/zotero"
if [ -f "$OUT" ] && [ -n "$WANT" ] && \
   [ "$(sha256sum "$OUT" | cut -d' ' -f1)" = "$WANT" ]; then
  echo "已存在且哈希正确，跳过下载：$OUT"; exit 0
fi

echo "下载 $URL"
curl -L --fail --max-time 900 -o "$OUT.part" "$URL"
mv "$OUT.part" "$OUT"
GOT="$(sha256sum "$OUT" | cut -d' ' -f1)"
echo "  大小   $(stat -c%s "$OUT") 字节"
echo "  sha256 $GOT"

if [ -n "$WANT" ]; then
  if [ "$GOT" = "$WANT" ]; then
    echo "  ✅ 哈希与本包登记的一致"
  else
    echo "  ❌ 哈希不符！期望 $WANT"; exit 1
  fi
else
  echo "  ⚠️ 这个版本本包没有登记哈希（首次下载）。"
  echo "     Windows 上请务必自己验签："
  echo "       Get-AuthenticodeSignature '$FILE' | Format-List Status,SignerCertificate"
  echo "     应当看到签名主体是 Corporation for Digital Scholarship。"
fi
echo ""
echo "完成后： 双击安装 → bash scripts/discover_env.sh → bash scripts/install_plugin.sh"
