#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# scripts/lib/host.sh —— 宿主适配层
#
#   被其它脚本 `. "$HERE/scripts/lib/host.sh"` 引入。
#   目的：把「哪台机器 / 哪种系统」的差异全部关在这一个文件里，
#         让上层脚本只有一条代码路径。
#
# 覆盖 4 种宿主：
#   wsl       Windows + WSL（本项目作者的环境；/mnt/c 是 9p）
#   windows   Windows 原生（Git-Bash / MSYS2，或者你干脆用 windows-native/*.ps1）
#   linux     普通 Linux
#   macos     macOS（BSDV userland：没有 grep -P / stat -c，bash 还是 3.2）
#
# ⚠️ bash 3.2 还有一个专属坑：**`$VAR` 后面紧跟非 ASCII 字符时，
#    它会把这些字节当成变量名的一部分** → 报 "HOST_OS\xef...: unbound variable"。
#    实测在 macOS CI 上就是这样挂的（本地 bash 5.2 永远复现不出来）。
#    所以变量后面只要接中文标点，一律写 **${VAR}**。
#
# ⚠️ 本文件必须 **bash 3.2 兼容**（macOS 自带的就是 3.2）：
#    不许用 declare -A / mapfile / ${v,,} / &> / [[ ]]
# ═══════════════════════════════════════════════════════════════════════════

# ────────────────────────────────────────────── 探测（只跑一次）
if [ -z "${HOST_OS:-}" ]; then
  _host_uname="$(uname -s 2>/dev/null || echo unknown)"
  case "$_host_uname" in
    MINGW*|MSYS*|CYGWIN*) HOST_OS="windows" ;;
    Darwin)               HOST_OS="macos" ;;
    Linux)
      if grep -qi microsoft /proc/version 2>/dev/null; then HOST_OS="wsl"; else HOST_OS="linux"; fi
      ;;
    *) HOST_OS="unknown" ;;
  esac
  # 在 WSL 里也有可能跑的是 Windows 的 bash.exe —— 上面 MINGW 分支已覆盖
fi

# 有没有 GNU 风格的工具（决定能不能用 grep -P / stat -c）
if [ -z "${HOST_GNU:-}" ]; then
  if stat -c%s /dev/null >/dev/null 2>&1; then HOST_GNU=1; else HOST_GNU=0; fi
fi

# ────────────────────────────────────────────── PowerShell（只有 Windows 系有）
# WSL 和原生 Windows 都用它来「关/开 Zotero」和读进程。
# ⚠️ 实测坑：`tasklist | grep zotero` 输出不可靠（Zotero 在跑却说没跑），
#    所以一律走 PowerShell 的 Get-Process。
if [ -z "${HOST_PS_DONE:-}" ]; then
  HOST_PS=""
  case "$HOST_OS" in
    wsl|windows)
      for _c in \
        "${PS:-}" \
        /mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe \
        "$(command -v powershell.exe 2>/dev/null || true)" \
        "$(command -v pwsh 2>/dev/null || true)" \
        "$(command -v pwsh.exe 2>/dev/null || true)"; do
        if [ -n "$_c" ] && [ -x "$_c" ]; then HOST_PS="$_c"; break; fi
      done
      ;;
  esac
  HOST_PS_DONE=1
fi

# ────────────────────────────────────────────── Python 解释器
# Windows 上通常 **没有 python3**，只有 `python`（或 py launcher）。
# 脚本里一律用 host_py 调用，别直接写 python3。
if [ -z "${HOST_PY_DONE:-}" ]; then
  HOST_PY=""
  for _c in python3 python; do
    if command -v "$_c" >/dev/null 2>&1; then HOST_PY="$(command -v "$_c")"; break; fi
  done
  [ -n "$HOST_PY" ] || { command -v py >/dev/null 2>&1 && HOST_PY="py"; }
  HOST_PY_DONE=1
fi
host_py() {
  [ -n "$HOST_PY" ] || { echo "❌ 找不到 Python（python3 / python）" >&2; return 127; }
  "$HOST_PY" "$@"
}

# ────────────────────────────────────────────── 小工具（全部可移植）

# 文件字节数。macOS 没有 stat -c → 一律用 wc -c，谁都有。
host_size() { wc -c < "$1" 2>/dev/null | tr -d ' \n'; }

# sha256。macOS 没有 sha256sum，它叫 shasum -a 256。
host_sha256() {
  if have sha256sum; then
    sha256sum "$1" | cut -d' ' -f1
  elif have shasum; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    python3 - "$1" <<'PY'
import hashlib, sys
h = hashlib.sha256()
with open(sys.argv[1], "rb") as f:
    for b in iter(lambda: f.read(1 << 20), b""):
        h.update(b)
print(h.hexdigest())
PY
  fi
}

# 从 debugLog.ts 里取 BUILD_TAG。不用 grep -P（BSD 没有）。
host_build_tag() {
  sed -n 's/.*BUILD_TAG[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "$1" 2>/dev/null | head -1
}

# 从 XPI(zip) 里读出打进产物的 BUILD_TAG —— 「运行时到底跑哪份代码」的唯一判据。
host_xpi_build_tag() {
  python3 - "$1" <<'PY' 2>/dev/null || true
import re, sys, zipfile
try:
    z = zipfile.ZipFile(sys.argv[1])
except Exception:
    raise SystemExit
for n in z.namelist():
    if n.endswith(".js"):
        m = re.findall(rb'BUILD_TAG = "([^"]+)"', z.read(n))
        if m:
            print(m[0].decode()); break
PY
}

# 补丁里声明的文件清单（+++ 侧，仓库根相对）。不用 grep -P。
#   `+++ src/src/utils/docx.ts`（diff -ruN pristine/ src/）→ src/utils/docx.ts
#   `+++ b/src/utils/docx.ts`  （git diff）                → src/utils/docx.ts
# 两种前缀都只剥第一段路径，结果一致；/dev/null（删除）要排掉。
host_patch_files() {
  sed -n 's|^+++ ||p' "$1" 2>/dev/null \
    | cut -f1 \
    | grep -v '^/dev/null$' \
    | sed 's|^[^/]*/||' \
    | grep -v '^$' \
    | sort -u
}

# /mnt/c/Users/x → C:\Users\x（只有 WSL 需要）。盘符要大写。
host_to_win_path() {
  case "$1" in
    /mnt/[a-zA-Z]/*)
      _d="$(printf '%s' "$1" | cut -c6 | tr 'a-z' 'A-Z')"
      _r="$(printf '%s' "$1" | cut -c7- | tr '/' '\\')"
      printf '%s:%s' "$_d" "$_r" ;;
    *) printf '%s' "$1" ;;
  esac
}

have() { command -v "$1" >/dev/null 2>&1; }

# 从 stdin 的路径列表里挑「版本号最大」的那个。
# 替代 `sort -V` —— BSD/macOS 的 sort 未必有 -V，而版本号字典序排序是错的
# （2.4.8.9 vs 2.4.8.10）。有 python 时按数字段比，没有就退回普通 sort。
host_latest() {
  _in="$(cat)"
  [ -n "$_in" ] || return 0
  if [ -n "$HOST_PY" ]; then
    _out="$(printf '%s\n' "$_in" | host_py -c '
import re, sys
def key(p):
    return [int(v) for v in re.findall(r"\d+", p)]
items = [l.strip() for l in sys.stdin if l.strip()]
if items:
    print(max(items, key=key))
' 2>/dev/null)"
    [ -n "$_out" ] && { printf '%s\n' "$_out"; return 0; }
  fi
  printf '%s\n' "$_in" | sort | tail -1
}

# ────────────────────────────────────────────── Zotero 进程：查 / 关 / 开
# 三种宿主三种做法，返回的都是「PID 列表（空格分隔）」
host_zotero_pids() {
  case "$HOST_OS" in
    wsl|windows)
      if [ -n "$HOST_PS" ]; then
        "$HOST_PS" -NoProfile -Command \
          "@(Get-Process zotero -ErrorAction SilentlyContinue).Id -join ' '" 2>/dev/null | tr -d '\r' | xargs
      fi
      ;;
    linux|macos)
      # ⭐ 这里以前是 bug：原版脚本在非 WSL 上一律返回空，
      #    于是装了 Zotero 还在跑，脚本却打印「已确认退出」——假确认。
      pgrep -x zotero 2>/dev/null | tr '\n' ' ' | xargs
      ;;
  esac
}

host_zotero_running() { [ -n "$(host_zotero_pids)" ]; }

host_zotero_stop() {
  case "$HOST_OS" in
    wsl|windows)
      [ -n "$HOST_PS" ] || { echo "  ⚠️ 找不到 PowerShell —— 请自己关掉 Zotero 再继续"; return 1; }
      "$HOST_PS" -NoProfile -Command \
        "Get-Process zotero -ErrorAction SilentlyContinue | Stop-Process -Force" >/dev/null 2>&1 || true
      ;;
    linux|macos)
      # 先温柔，再强杀；Zotero 退出时会回写 extensions.json，所以必须等它真的走
      pkill -x zotero 2>/dev/null || true
      ;;
  esac

  _i=0
  while [ "$_i" -lt 30 ]; do
    host_zotero_running || return 0
    sleep 1; _i=$((_i + 1))
  done
  # 还没死就强杀一次
  case "$HOST_OS" in
    linux|macos) pkill -9 -x zotero 2>/dev/null || true ;;
  esac
  sleep 2
  host_zotero_running && return 1 || return 0
}

# 启动 Zotero。$1 = 可执行文件路径（可用 POSIX 或 Windows 形式）
host_zotero_start() {
  _exe="$1"
  case "$HOST_OS" in
    wsl)
      [ -n "$HOST_PS" ] || { echo "  ⚠️ 无 PowerShell，请手工启动 Zotero"; return 1; }
      _win="$(host_to_win_path "$_exe")"
      "$HOST_PS" -NoProfile -Command "Start-Process '$_win'" >/dev/null 2>&1
      ;;
    windows)
      # Git-Bash 里 .exe 可以直接起
      ( "$_exe" >/dev/null 2>&1 & )
      ;;
    linux|macos)
      ( "$_exe" >/dev/null 2>&1 & )
      ;;
  esac
}

# ────────────────────────────────────────────── 日志增量（可移植版 tail -c +N）
# 9p 上有写回延迟，所以「看日志新增了什么」必须按字节偏移，不能整文件读。
host_log_tail_from() {
  _log="$1"; _off="$2"
  [ -f "$_log" ] || return 0
  if [ "$_off" -le 0 ] 2>/dev/null; then
    tail -n 20 "$_log"
  else
    tail -c "+$((_off + 1))" "$_log"
  fi
}

# ────────────────────────────────────────────── 自检（可直接跑本文件看结论）
host_report() {
  echo "HOST_OS   = $HOST_OS"
  echo "HOST_GNU  = $HOST_GNU   （1=有 GNU 工具，0=BSD/macOS 风格）"
  echo "PowerShell= ${HOST_PS:-（无）}"
  echo "bash      = ${BASH_VERSION:-?}"
  echo "Python    = ${HOST_PY:-（无）}"
  echo "zotero PID= [$(host_zotero_pids)]"
  for t in node npm npx python3 patch git unzip curl; do
    printf '  %-8s %s\n' "$t" "$(command -v "$t" 2>/dev/null || echo '（无）')"
  done
}

if [ "${BASH_SOURCE[0]}" = "${0}" ]; then host_report; fi
