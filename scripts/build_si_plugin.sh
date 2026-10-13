#!/usr/bin/env bash
# 打包「SI 自动获取」插件（suppl-dl@example.com）。
#
# ⚠️ 铁律（当初二分定位出来的）：**manifest 绝不能自己重写** ——
#    重写过的 manifest 会被 Zotero 判为「可能无法与该版本的 Zotero 兼容」而拒装；
#    直接塞进 extensions/ 也会在下次启动时连 XPI 一起被删掉。
#    所以：以**上一版能装成功的 XPI** 为基底，只做两件事：
#      ① 用 JS 覆盖同名文件
#      ② 只改 manifest 里的 version（其它字段一律保持基底原样）
#
# 用法： bash scripts/build_si_plugin.sh [基底XPI] [输出XPI]
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib/host.sh
. "$HERE/scripts/lib/host.sh"
JSDIR="$HERE/plugins/si-fetcher"

BASE="${1:-$(ls -1 "$JSDIR"/zotero-si-fetcher-*.xpi 2>/dev/null | host_latest)}"
OUT="${2:-$JSDIR/zotero-si-fetcher-new.xpi}"
[ -f "$BASE" ] || { echo "找不到基底 XPI: ${BASE:-（无）}"; exit 1; }
[ -d "$JSDIR" ] || { echo "找不到 JS 目录: $JSDIR"; exit 1; }

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
unzip -q "$BASE" -d "$WORK"

for f in bootstrap.js si-cdp.js supplementary.js; do
  if [ -f "$JSDIR/$f" ]; then
    cp "$JSDIR/$f" "$WORK/$f"; echo "  覆盖 $f"
  else
    echo "  缺 $f，跳过（基底里那份保持不变）"
  fi
done

host_py - "$WORK/manifest.json" <<'PYEOF'
import json, sys
p = sys.argv[1]
d = json.load(open(p, encoding="utf-8"))
old = d["version"]
parts = old.split(".")
parts[-1] = str(int(parts[-1]) + 1)
d["version"] = ".".join(parts)
json.dump(d, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
print("  manifest: %s -> %s  (name=%s)" % (old, d["version"], d.get("name")))
PYEOF

rm -f "$OUT"
# WSL 里通常没装 zip -> 用 Python 的 zipfile（顺带保证条目顺序稳定）
host_py - "$WORK" "$OUT" <<'PYEOF'
import os, sys, zipfile
work, out = sys.argv[1], sys.argv[2]
names = sorted(os.path.relpath(os.path.join(r, f), work)
               for r, _d, fs in os.walk(work) for f in fs)
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for n in names:
        z.write(os.path.join(work, n), n.replace(os.sep, "/"))
print("  写入 %d 个文件" % len(names))
PYEOF
echo "打包完成: $OUT ($(host_size "$OUT") bytes)"
echo ""
echo "安装：Zotero -> 工具 -> 插件 -> 齿轮 -> Install Plugin From File... 选上面这个 XPI，然后重启。"
echo "（这个插件不参与离线验收：它要真去出版社页面抓 SI，属于必须联网+有登录态的部分。）"
