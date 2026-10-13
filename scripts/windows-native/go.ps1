# =============================================================================
# scripts/windows-native/go.ps1 —— Windows 原生唯一入口
#
#   用法（在 kit 根目录下）：
#       powershell -ExecutionPolicy Bypass -File .\scripts\windows-native\go.ps1 -Step all
#       .\scripts\windows-native\go.ps1 -Step discover     # 只看环境
#       .\scripts\windows-native\go.ps1 -Step build
#
#   步骤： discover → prepare → deps → build → verify → install
#          -Step all 会依次跑完（install 需要 Zotero 不在用；它会强制关掉再开）
#
#   ⚠️ 为什么会有这一套：kit 原来只支持 WSL/Linux/macOS 的 bash 路线。
#      而 Zotero 插件用户里「Windows 且没装 WSL」是最常见的情况，
#      偏偏那种机器上没有 patch、没有 git（实测），只有 Node。
#      所以把补丁结果摊成覆盖层（prepare 不再需要 patch），
#      再补一条纯 PowerShell 的路，Node 就是唯一硬依赖。
# =============================================================================
param(
    [ValidateSet('discover', 'prepare', 'deps', 'build', 'verify', 'install', 'all')]
    [string]$Step = 'all'
)

$ErrorActionPreference = 'Stop'
$KitRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Native  = $PSScriptRoot
$Src     = Join-Path $KitRoot 'work\translate'

# shellcheck 无关：PowerShell 的公共包装（Invoke-Native / Resolve-Cmd / Get-BuildTag）
. (Join-Path $PSScriptRoot '_common.ps1')

function Step-Discover { & (Join-Path $Native 'discover_env.ps1') }

function Step-Prepare { & (Join-Path $Native 'prepare_src.ps1') }

function Step-Deps {
    if (-not (Test-Path (Join-Path $Src 'package.json'))) { throw "先跑 prepare" }
    $npm = Resolve-Cmd 'npm'
    if (-not $npm) { throw "找不到 npm —— 装 Node.js LTS： winget install OpenJS.NodeJS.LTS" }
    $hasLock = Test-Path (Join-Path $Src 'package-lock.json')
    Write-Host "== 装依赖（$(if ($hasLock) { 'npm ci' } else { 'npm install' })）=="
    Push-Location $Src
    try {
        # ⚠️ 必须走 Invoke-Native：npm 往 stderr 写进度，而 ErrorActionPreference='Stop'
        #    会把那当成终止性错误 —— 表现是 npm 装完了脚本却停在这、后面一步都不跑。
        # ⚠️ 两个 PowerShell 陷阱，都踩过：
        #   1. 别用 $args 当变量名 —— 它是自动变量（脚本参数）
        #   2. **别写 `$a = if (...) { @('ci') }`** —— 单元素数组会被解包成字符串，
        #      后面 `+=` 数组时按 $OFS 拼接，结果粘成 `ci--no-audit --no-fund`
        #      传给 npm，报 `Unknown command`。必须显式逐项追加。
        $npmArgs = @()
        if ($hasLock) { $npmArgs += 'ci' } else { $npmArgs += 'install' }
        $npmArgs += '--no-audit'
        $npmArgs += '--no-fund'
        $rc = Invoke-Native -File $npm -Arguments $npmArgs
        if ($rc -ne 0) {
            Write-Host "  正常装失败，改用 --userconfig nul 重试（忽略用户级 npm 配置里的失效代理）…"
            $retryArgs = $npmArgs + @('--userconfig', 'nul')
            $rc = Invoke-Native -File $npm -Arguments $retryArgs
        }
        if ($rc -ne 0) { throw "装依赖失败（exit=$rc）" }
    } finally { Pop-Location }
    Write-Host "  ✅ 插件构建依赖就绪"

    # ⚠️ parse5 必须单独装到 tests/ —— 它是**测试**依赖，不在插件 package.json 里。
    #    漏了这一步的后果实测过：4 组断言里第 1 组直接报「缺 parse5」，
    #    其余 3 组照跑通过 —— 看起来像"部分失败"，其实是依赖没装全。
    Write-Host ""
    Write-Host "== 测试依赖：parse5（真 HTML5 解析器，段落间距回归必须用它）=="
    $tests = Join-Path $KitRoot 'tests'
    New-Item -ItemType Directory -Force -Path $tests | Out-Null
    $tPkg = Join-Path $tests 'package.json'
    if (-not (Test-Path $tPkg)) {
        '{"name":"zpt-kit-tests","private":true,"type":"commonjs"}' |
            Set-Content -Path $tPkg -Encoding UTF8
    }
    $nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
    if (-not $nodeExe) { throw "找不到 node" }
    # ⚠️ require 检查**必须在 tests 目录里做**：node 的模块解析是按 cwd 往上找的。
    #    在外面做会报 Cannot find module 'parse5' —— 明明装上了却说没装。
    Push-Location $tests
    try {
        if (-not (Test-Path (Join-Path $tests 'node_modules\parse5'))) {
            $rc = Invoke-Native -File $npm -Arguments @('install', '--no-audit', '--no-fund', 'parse5')
            if ($rc -ne 0) {
                $rc = Invoke-Native -File $npm -Arguments @('install', '--userconfig', 'nul', '--no-audit', '--no-fund', 'parse5')
            }
            if ($rc -ne 0) { throw "parse5 装不上（exit=$rc）" }
        } else {
            Write-Host "  已有 parse5，跳过安装"
        }
        $rc = Invoke-Native -File $nodeExe -Arguments @('-e', "require('parse5'); console.log('  OK parse5 可用')")
        if ($rc -ne 0) { throw "parse5 装了但 require 不了" }
    } finally { Pop-Location }
}

function Step-Build   { & (Join-Path $Native 'build_plugin.ps1') }
function Step-Verify  { & (Join-Path $Native 'verify.ps1') }
function Step-Install { & (Join-Path $Native 'install_plugin.ps1') }

# ⚠️ 固定工作目录：如果 PowerShell 是从 WSL 里启动的，cwd 会是
#    \\wsl.localhost\... 这种 UNC 路径，某些工具（node 的模块解析、npm）会出怪问题。
Set-Location $KitRoot

Write-Host "############################################################"
Write-Host "#  Zotero SI kit —— Windows 原生路线（无需 WSL / patch / git）"
Write-Host "#  kit : $KitRoot"
Write-Host "#  step: $Step"
Write-Host "############################################################"

switch ($Step) {
    'discover' { Step-Discover }
    'prepare'  { Step-Prepare }
    'deps'     { Step-Deps }
    'build'    { Step-Build }
    'verify'   { Step-Verify }
    'install'  { Step-Install }
    'all' {
        Step-Prepare
        Step-Deps
        Step-Build
        Step-Verify
        Write-Host ""
        Write-Host "############################################################"
        Write-Host "#  离线部分全部通过。下面是「装进 Zotero」——它会强制关掉再开 Zotero。"
        Write-Host "#  不想现在装就按 Ctrl+C，然后手工：Zotero → 工具 → 插件 → 齿轮 →"
        Write-Host "#  Install Plugin From File… → work\translate\build\translate-for-zotero.xpi"
        Write-Host "############################################################"
        Start-Sleep -Seconds 5
        Step-Install
    }
}
