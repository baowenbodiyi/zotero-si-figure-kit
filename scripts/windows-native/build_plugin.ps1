# =============================================================================
# scripts/windows-native/build_plugin.ps1
#   构建插件 XPI（Windows 原生）：先类型检查，再打包，最后验证产物里的 BUILD_TAG
#
#   ⚠️ 关键两条（都是实测踩出来的）：
#     1. `zotero-plugin build` 用 esbuild，**不做类型检查** ——
#        必须先 `tsc --noEmit`，否则类型错误会静默打进产物。
#     2. 调 npm/npx **必须走 .cmd**，不能走 .ps1：
#        PowerShell 默认执行策略会拒绝 npm.ps1（报 PSSecurityException:
#        UnauthorizedAccess），而 npm.cmd 不受影响。
#
#   用法： powershell -ExecutionPolicy Bypass -File .\scripts\windows-native\build_plugin.ps1
# =============================================================================
$ErrorActionPreference = 'Stop'

$KitRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Src     = Join-Path $KitRoot 'work\translate'
if (-not (Test-Path (Join-Path $Src 'src'))) {
    throw "缺 $Src\src —— 先跑 .\scripts\windows-native\prepare_src.ps1"
}

# esbuild 的缓存目录（默认会写用户目录，指到 kit 里更干净）
if (-not $env:XDG_CACHE_HOME) { $env:XDG_CACHE_HOME = Join-Path $KitRoot '.cache' }
New-Item -ItemType Directory -Force -Path $env:XDG_CACHE_HOME | Out-Null

. (Join-Path $PSScriptRoot '_common.ps1')

$npm = Resolve-Cmd 'npm'
$npx = Resolve-Cmd 'npx'
if (-not $npx) { throw "找不到 npx （装 Node.js 后重开一个 PowerShell 窗口）" }
Write-Host "== 宿主：windows-native =="
Write-Host "  npm : $npm"
Write-Host "  npx : $npx"

Push-Location $Src
try {
    Write-Host ""
    Write-Host "== 1/3 类型检查（tsc --noEmit）=="
    $rc = Invoke-Native -File $npx -Arguments @('tsc', '--noEmit')
    if ($rc -ne 0) { throw "tsc --noEmit 未通过（exit=$rc）" }
    Write-Host "  ✅ 类型检查通过"

    Write-Host ""
    Write-Host "== 2/3 打包（zotero-plugin build）=="
    $rc = Invoke-Native -File $npx -Arguments @('zotero-plugin', 'build')
    if ($rc -ne 0) { throw "zotero-plugin build 失败（exit=$rc）" }

    $xpi = Join-Path $Src 'build\translate-for-zotero.xpi'
    if (-not (Test-Path $xpi)) { throw "没产出 $xpi" }

    Write-Host ""
    Write-Host "== 3/3 校验产物里真有本次源码的构建标记 =="
    $tag = Get-BuildTag (Join-Path $Src 'src\utils\debugLog.ts')
    if (-not $tag) { throw "从 $Src\src\utils\debugLog.ts 读不到 BUILD_TAG" }

    $pkg = Get-Content -Raw (Join-Path $Src 'package.json') | ConvertFrom-Json

    # 在 XPI（其实就是个 zip）里找 BUILD_TAG 和 manifest.version
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::OpenRead($xpi)
    try {
        $manifestEntry = $zip.Entries | Where-Object { $_.FullName -eq 'manifest.json' } | Select-Object -First 1
        if (-not $manifestEntry) { throw "XPI 里没有 manifest.json" }
        $sr = New-Object System.IO.StreamReader($manifestEntry.Open())
        $manifest = $sr.ReadToEnd(); $sr.Close()
        $mv = [regex]::Match($manifest, '"version"\s*:\s*"([^"]+)"')
        if (-not $mv.Success) { throw "manifest.json 里读不到 version" }
        Write-Host "  产物版本 $($mv.Groups[1].Value) / 期望 $($pkg.version)"
        if ($mv.Groups[1].Value -ne $pkg.version) { throw "manifest 版本不符" }

        $found = $false
        foreach ($e in $zip.Entries) {
            if ($e.FullName -notlike '*.js') { continue }
            $esr = New-Object System.IO.StreamReader($e.Open())
            $txt = $esr.ReadToEnd(); $esr.Close()
            if ($txt.Contains($tag)) { $found = $true; break }
        }
        if (-not $found) { throw "产物的 JS 里找不到 BUILD_TAG $tag" }
        Write-Host "  ✅ 产物里确认含 build=$tag"
    } finally { $zip.Dispose() }

    $size = (Get-Item $xpi).Length
    Write-Host "  XPI: $xpi  $size 字节"
    Write-Host ""
    Write-Host "下一步： .\scripts\windows-native\go.ps1 -Step install"
} finally {
    Pop-Location
}
