# =============================================================================
# scripts/windows-native/_common.ps1 —— 被其它 .ps1 点源引入
# =============================================================================

# ---------------------------------------------------------------------------
# 让外部程序（node / npm / npx）写的中文能正确显示。
#
# 为什么需要：node 往 stdout 写的是 **UTF-8 字节**，而 Windows PowerShell 5.1
# 按**当前控制台码页**（中文系统默认 936）去解码 —— 于是日志里的中文全变乱码，
# 而且 Out-File 再存一次就变成有损的二次编码，事后都还原不回来。
# 把输出编码显式设成 UTF-8 就对了。
# ---------------------------------------------------------------------------
try {
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
    $OutputEncoding = New-Object System.Text.UTF8Encoding $false
} catch {
    # 某些重定向/无控制台场景设不了 —— 不影响功能，只是中文可能显示不好
}

# ⭐ 调用外部程序（npm / npx / node / robocopy …）的安全包装。
#
# 为什么必须有它 —— 这是 PowerShell 5.1 最坑人的行为之一：
#   `$ErrorActionPreference = 'Stop'` 时，**外部程序往 stderr 写的任何一行**
#   都会被 PowerShell 变成终止性错误，脚本当场中止。
#   而 `npm ci` 会往 stderr 写进度和 deprecated 警告 —— 于是：
#     npm 明明装完了（node_modules/.package-lock.json 已写），
#     脚本却停在那里，后面的步骤一步都没跑，日志还只剩半行。
#   实测踩到过：Windows 路线的 deps 卡住、"日志只有 5 行"。
#
# 正确做法：调用期间把 ErrorActionPreference 放宽成 Continue，
#   把 stderr 合并进来自己打印，然后**以退出码判断成败**（不看有没有红字）。
function Invoke-Native {
    param(
        [Parameter(Mandatory = $true)][string]$File,
        [string[]]$Arguments = @()
    )
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $out = & $File @Arguments 2>&1
        $rc = $LASTEXITCODE
        foreach ($line in $out) {
            if ($line -is [System.Management.Automation.ErrorRecord]) {
                Write-Host $line.ToString()
            } else {
                Write-Host "$line"
            }
        }
        return $rc
    } finally {
        $ErrorActionPreference = $prev
    }
}

# 找 npm/npx 一律优先 .cmd：
#   PowerShell 会把 `npm` 解析成 npm.ps1，而默认执行策略拒绝它
#   → PSSecurityException: UnauthorizedAccess。npm.cmd 不受影响。
function Resolve-Cmd {
    param([Parameter(Mandatory = $true)][string]$Base)
    foreach ($name in @("$Base.cmd", $Base)) {
        $c = Get-Command $name -ErrorAction SilentlyContinue
        if ($c) { return $c.Source }
    }
    return $null
}

# 从文本里取 BUILD_TAG（与 bash 侧 host_build_tag 等价）
function Get-BuildTag {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path $Path)) { return '' }
    $m = [regex]::Match((Get-Content -Raw -Encoding UTF8 $Path), 'BUILD_TAG\s*=\s*"([^"]*)"')
    if ($m.Success) { return $m.Groups[1].Value }
    return ''
}

# 从 XPI（zip）里读回打进产物的 BUILD_TAG —— 「运行时到底跑哪份代码」的唯一判据
function Get-XpiBuildTag {
    param([Parameter(Mandatory = $true)][string]$Path)
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    try { $zip = [System.IO.Compression.ZipFile]::OpenRead($Path) } catch { return '' }
    try {
        foreach ($e in $zip.Entries) {
            if ($e.FullName -notlike '*.js') { continue }
            $sr = New-Object System.IO.StreamReader($e.Open())
            $txt = $sr.ReadToEnd(); $sr.Close()
            $m = [regex]::Match($txt, 'BUILD_TAG = "([^"]+)"')
            if ($m.Success) { return $m.Groups[1].Value }
        }
    } finally { $zip.Dispose() }
    return ''
}
