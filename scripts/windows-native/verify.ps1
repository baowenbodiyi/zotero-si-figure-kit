# =============================================================================
# scripts/windows-native/verify.ps1
#   Windows 原生跑「全部离线验收」（不需要 Zotero，不需要联网）
#
#   做两件事（与 scripts/verify_all.sh 等价）：
#     1. 用 esbuild 把「要发布的源码」里那几个模块编成 CJS（测的就是要发布的那份）
#     2. 依次跑 4 组测试，最后汇总
#
#   用法： powershell -ExecutionPolicy Bypass -File .\scripts\windows-native\verify.ps1
# =============================================================================
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot '_common.ps1')

$KitRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Src     = if ($env:ZPT_SRC) { $env:ZPT_SRC } else { Join-Path $KitRoot 'work\translate' }
$Build   = if ($env:ZPT_BUILD) { $env:ZPT_BUILD } else { Join-Path $env:TEMP 'zpt-verify' }
$Fixt    = if ($env:ZPT_FIXTURES) { $env:ZPT_FIXTURES } else { Join-Path $KitRoot 'tests\fixtures' }

if (-not (Test-Path (Join-Path $Src 'src'))) { throw "缺 $Src\src —— 先跑 prepare_src.ps1" }
New-Item -ItemType Directory -Force -Path $Build | Out-Null

$esb = Join-Path $Src 'node_modules\.bin\esbuild.cmd'
if (-not (Test-Path $esb)) {
    $esb = Join-Path $Src 'node_modules\.bin\esbuild'
    if (-not (Test-Path $esb)) {
        throw "缺 esbuild（$Src\node_modules\.bin\esbuild.cmd）—— 先跑 go.ps1 -Step deps"
    }
}

# 测试脚本按这些环境变量找产物
$env:ZPT_SRC      = $Src
$env:ZPT_BUILD    = $Build
$env:ZPT_FIXTURES = $Fixt

Write-Host "== 编译要发布的源码（就是插件里跑的那几个模块）=="
foreach ($mod in 'inflate', 'tiff', 'docx', 'siRefs', 'pngEncode', 'debugLog', 'mathRenderer') {
    $out = Join-Path $Build "$mod.cjs"
    $rc = Invoke-Native -File $esb -Arguments @(
        (Join-Path $Src "src\utils\$mod.ts"),
        '--bundle', '--format=cjs', '--platform=node',
        "--outfile=$out", '--log-level=warning')
    if ($rc -ne 0) { throw "编译 $mod.ts 失败（exit=$rc）" }
    Write-Host "  ✅ $mod.cjs"
}

$rc = 0
function Invoke-Test([string]$file, [string]$title) {
    Write-Host ""
    Write-Host "────────────────────────────────────────────────────────────"
    Write-Host "▶ $title"
    Write-Host "────────────────────────────────────────────────────────────"
    Push-Location (Join-Path $KitRoot 'tests')
    try {
        $node = (Get-Command node -ErrorAction SilentlyContinue).Source
        if (-not $node) { throw "找不到 node" }
        $testRc = Invoke-Native -File $node -Arguments @($file)
        if ($testRc -ne 0) { $script:rc = 1 }
    } finally { Pop-Location }
}

Invoke-Test 'test_renderspacing.js' '1/4 译文渲染（段落间距 / <br> 语义）'
Invoke-Test 'test_sirefs.js'        '2/4 SI 引用解析与图注定位'
Invoke-Test 'test_pngencode.js'     '3/4 PNG 编码器 / base64'
Invoke-Test 'test_wordsi.js'        '4/4 Word 版 SI（docx / TIFF / inflate / 端到端）'

Write-Host ""
Write-Host "════════════════════════════════════════════════════════════"
if ($rc -eq 0) {
    Write-Host "✅ 全部离线验收通过"
    Write-Host "   （SKIP 的小节表示本机没有那类真数据；kit 自带的 fixture 已覆盖同一代码路径）"
} else {
    Write-Host "❌ 有测试失败 —— 看上面 ❌ 的明细"
}
Write-Host "════════════════════════════════════════════════════════════"
exit $rc
