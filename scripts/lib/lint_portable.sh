#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# scripts/lib/lint_portable.sh —— 可移植性 lint
#
#   为什么需要它：这套 kit 要在 4 种宿主上跑
#     wsl / linux / macos（BSD userland + bash 3.2）/ windows（Git-Bash、PowerShell）
#   而「Linux 上跑得好好的写法」到了 macOS 会直接语法错。这类问题不该靠记性。
#
#   用法： bash scripts/lib/lint_portable.sh          （在 kit 根目录）
#   退出码： 0 = 干净，1 = 有问题
# ═══════════════════════════════════════════════════════════════════════════
set -uo pipefail
HERE="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$HERE" || exit 2

FAIL=0
note() { printf '  ❌ %s\n' "$*"; FAIL=1; }

# ── 1. bash 3.2（macOS 自带）不支持 / BSD 工具没有的写法 ───────────────────
# host.sh 是「兼容层」本身，里面出现这些名字是正常的（探测/注释），跳过它。
check_shell_bad() {
  local pat="$1" why="$2" f hits
  for f in scripts/*.sh scripts/lib/*.sh; do
    # host.sh 是兼容层本身；lint 自己写满这些样例字符串，都不该被扫
    case "$f" in scripts/lib/host.sh|scripts/lib/lint_portable.sh) continue ;; esac
    # 先剥掉行尾注释再匹配 —— 否则注释里提到 "python3" 之类的词会假阳性。
    # 只剥「空白 + #」这种形态，引号里的 # 不受影响。
    hits="$(sed -e 's/^[[:space:]]*#.*$//' -e 's/[[:space:]]#.*$//' "$f" 2>/dev/null | grep -nE "$pat")"
    if [ -n "$hits" ]; then
      while IFS= read -r line; do note "$f:$line    ← $why"; done <<EOF
$hits
EOF
    fi
  done
}

check_shell_bad 'declare[[:space:]]+-A|(^|[^A-Za-z_])mapfile([^A-Za-z_]|$)|readarray' \
  'bash 4+ 专属，macOS 自带 bash 3.2 会语法报错'
check_shell_bad '\$\{[A-Za-z_][A-Za-z0-9_]*,,|\$\{[A-Za-z_][A-Za-z0-9_]*\^\^' \
  '大小写转换是 bash 4+，macOS 没有'
check_shell_bad 'grep[[:space:]]+-[A-Za-z]*P' \
  'grep -P 是 GNU 专属，BSD/macOS 没编进去'
check_shell_bad 'stat[[:space:]]+-c|stat[[:space:]]+-f' \
  'stat 参数 GNU/BSD 不一致 —— 用 host_size'
check_shell_bad '(^|[^A-Za-z_])sha256sum([^A-Za-z_]|$)' \
  'macOS 没有 sha256sum（叫 shasum -a 256）—— 用 host_sha256'
check_shell_bad '(^|[^A-Za-z0-9_/])python3([[:space:]]|$)' \
  'Windows 通常只有 python —— 用 host_py'
check_shell_bad 'sort[[:space:]]+-V' \
  'BSD sort 未必有 -V —— 用 host_latest'
check_shell_bad 'readlink[[:space:]]+-f' 'macOS 的 readlink 没有 -f'
check_shell_bad 'date[[:space:]]+-d'      'macOS 的 date 没有 -d（是 -v）'
check_shell_bad 'xargs[[:space:]]+-r'     'macOS 的 xargs 没有 -r'
# GNU 形式 `sed -i 'x' f` 在 macOS 上会炸；可移植写法是 `sed -i '' 'x' f`
# 或 `sed -i.bak 'x' f`。所以只报「-i 后面跟的不是空后缀」的情况。
check_shell_bad "sed[[:space:]]+-i[[:space:]]+([^'\"]|'[^']|\"[^\"])" \
  "BSD sed 的 -i 要空后缀：写成 sed -i '' ... 或 sed -i.bak ..."

# ── 2. .ps1 必须 UTF-8 with BOM（否则 Windows PowerShell 5.1 按 ANSI 读，中文变乱码）─
for f in scripts/windows-native/*.ps1; do
  [ -f "$f" ] || continue
  if ! head -c3 "$f" | od -An -tx1 | grep -q 'ef bb bf'; then
    note "$f 缺 UTF-8 BOM（Windows PowerShell 5.1 会按 ANSI 解析）"
  fi
done

# ── 3. 脚本必须可执行（被判为不可执行时，文档里的路径就点不动）──────────────
for f in scripts/*.sh scripts/lib/*.sh; do
  [ -f "$f" ] || continue
  [ -x "$f" ] || note "$f 没有可执行位（chmod +x）"
done

echo ""
if [ "$FAIL" = 0 ]; then
  echo "✅ 可移植性 lint 通过（wsl / linux / macos / windows 的写法约束）"
else
  echo "❌ 可移植性 lint 发现问题 —— 见上面 ❌（每条都写了该换用什么）"
fi
exit "$FAIL"
