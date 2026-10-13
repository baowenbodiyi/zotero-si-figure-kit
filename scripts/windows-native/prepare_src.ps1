# =============================================================================
# scripts/windows-native/prepare_src.ps1
#   把「上游 pristine + 覆盖层」拼成 work\translate（Windows 原生，无需 patch/git）
#
#   用法： powershell -ExecutionPolicy Bypass -File .\scripts\windows-native\prepare_src.ps1
# =============================================================================
param(
    [string]$Pristine = ""
)

$ErrorActionPreference = 'Stop'
$KitRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
if (-not $KitRoot) { $KitRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path }

$TranslateDir = Join-Path $KitRoot 'plugins\translate'
$Work         = Join-Path $KitRoot 'work\translate'

if (-not $Pristine) { $Pristine = Join-Path $TranslateDir 'pristine-v2.4.8' }
if (-not (Test-Path $Pristine)) { throw "找不到上游源码树: $Pristine" }

$overlay = Get-ChildItem -Path $TranslateDir -Directory -Filter 'patched-*' -ErrorAction SilentlyContinue |
           Sort-Object Name | Select-Object -Last 1
if (-not $overlay) { throw "找不到覆盖层 plugins\translate\patched-*\" }

Write-Host "== 准备源码树（Windows 原生）=="
Write-Host "  上游   : $Pristine"
Write-Host "  覆盖层 : $($overlay.Name)"
Write-Host "  输出   : $Work"

if (Test-Path $Work) { Remove-Item -Recurse -Force $Work }
New-Item -ItemType Directory -Path (Split-Path $Work -Parent) -Force | Out-Null

# 复制上游整棵树（robocopy 对长路径/大量文件更稳；失败码 <8 都算成功）
$null = robocopy $Pristine $Work /E /NFL /NDL /NJH /NJS /NP
if ($LASTEXITCODE -ge 8) { throw "robocopy 复制上游失败，exit=$LASTEXITCODE" }
$global:LASTEXITCODE = 0

# 只删构建产物/版本控制目录。
# ⚠️ typings\ 是上游受控的源码（3 个 .d.ts），删了会让 tsc 报几百个
#    "Cannot find name 'Ztoolkit'" —— 别把它加进来。
foreach ($junk in 'node_modules', 'build', '.git', '.cache', 'tsconfig.tsbuildinfo') {
    $p = Join-Path $Work $junk
    if (Test-Path $p) { Remove-Item -Recurse -Force $p -ErrorAction SilentlyContinue }
}

# 盖覆盖层
$null = robocopy $overlay.FullName $Work /E /NFL /NDL /NJH /NJS /NP
if ($LASTEXITCODE -ge 8) { throw "robocopy 覆盖层失败，exit=$LASTEXITCODE" }
$global:LASTEXITCODE = 0
$nOverlay = (Get-ChildItem -Path $overlay.FullName -Recurse -File).Count
Write-Host "  已应用覆盖层（$nOverlay 个文件）"

# ---- 自洽校验：覆盖层里的每个文件都必须真的落到 work\translate 里且内容一致 ----
$bad = @()
foreach ($f in Get-ChildItem -Path $overlay.FullName -Recurse -File) {
    $rel = $f.FullName.Substring($overlay.FullName.Length).TrimStart('\')
    $dst = Join-Path $Work $rel
    if (-not (Test-Path $dst)) { $bad += "缺: $rel"; continue }
    $h1 = (Get-FileHash $f.FullName -Algorithm SHA256).Hash
    $h2 = (Get-FileHash $dst -Algorithm SHA256).Hash
    if ($h1 -ne $h2) { $bad += "内容不符: $rel" }
}
if ($bad.Count -gt 0) {
    Write-Host "  ❌ 覆盖层落盘校验失败:"
    $bad | Select-Object -First 10 | ForEach-Object { Write-Host "     $_" }
    throw "覆盖层没有正确落到 work\translate"
}
Write-Host "  ✅ 覆盖层 $nOverlay 个文件全部就位且逐字节一致"

# ---- 版本自检 ----
$pkg = Get-Content -Raw (Join-Path $Work 'package.json') | ConvertFrom-Json
$dbg = Join-Path $Work 'src\utils\debugLog.ts'
$tag = ''
if (Test-Path $dbg) {
    $m = [regex]::Match((Get-Content -Raw $dbg), 'BUILD_TAG\s*=\s*"([^"]*)"')
    if ($m.Success) { $tag = $m.Groups[1].Value }
}
Write-Host "  package.json version = $($pkg.version)   BUILD_TAG = $tag"
Write-Host ""
Write-Host "下一步： .\scripts\windows-native\go.ps1 -Step deps"
