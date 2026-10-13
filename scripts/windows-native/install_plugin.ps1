# =============================================================================
# scripts/windows-native/install_plugin.ps1
#   把构建好的 XPI 装进 Zotero，并**证明运行时真的加载了它**（Windows 原生）
#
#   ⚠️ 两个会骗人的坑：
#     1. Zotero 运行时会在退出时回写 extensions.json → 必须**先真关掉**再改文件，
#        否则它一回写就把你改的覆盖掉，装的其实一直没生效。
#     2. 换完文件**立刻启动**，Zotero 可能读到旧缓存 → 表现为
#        「版本号是新的、跑的还是旧逻辑」。所以要看**启动日志里的 BUILD_TAG**，
#        而不是看扩展管理器显示什么。等不到就重启一次再判。
#
#   用法： powershell -ExecutionPolicy Bypass -File .\scripts\windows-native\install_plugin.ps1
# =============================================================================
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot '_common.ps1')

$KitRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Xpi     = Join-Path $KitRoot 'work\translate\build\translate-for-zotero.xpi'
$ExtId   = 'zoteropdftranslate@euclpts.com'

if (-not (Test-Path $Xpi)) { throw "缺 $Xpi —— 先跑 .\scripts\windows-native\build_plugin.ps1" }

$env2 = & (Join-Path $PSScriptRoot 'discover_env.ps1')

$tag = Get-BuildTag (Join-Path $KitRoot 'work\translate\src\utils\debugLog.ts')
$pkg = Get-Content -Raw (Join-Path $KitRoot 'work\translate\package.json') | ConvertFrom-Json

if (-not $env2.ProfileDir) {
    Write-Host ""
    Write-Host "❌ 探测不到 Zotero profile。请手工装（一样有效）："
    Write-Host "   1. Zotero → 工具 → 插件 → 右上齿轮 → Install Plugin From File…"
    Write-Host "      选： $Xpi"
    Write-Host "   2. 重启 Zotero"
    Write-Host "   3. 看数据目录下的 zpt-debug.log，确认出现"
    Write-Host "        [boot] hooks.onStartup done | build=$tag"
    exit 1
}

$dst = Join-Path $env2.ProfileDir "extensions\$ExtId.xpi"
$log = if ($env2.DataDir) { Join-Path $env2.DataDir 'zpt-debug.log' } else { '' }

Write-Host "== 宿主：windows-native =="
Write-Host "== 目标：版本 $($pkg.version) / build=$tag =="
Write-Host "   profile : $($env2.ProfileDir)"
Write-Host "   日志     : $(if ($log) { $log } else { '(未探测到数据目录)' })"
Write-Host "   当前 PID : [$((Get-Process zotero -ErrorAction SilentlyContinue).Id -join ' ')]"

# ---- 1. 真关掉 Zotero ----
Write-Host "关闭 Zotero（强制）…"
Get-Process zotero -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
$ok = $false
for ($i = 0; $i -lt 30; $i++) {
    if (-not (Get-Process zotero -ErrorAction SilentlyContinue)) { $ok = $true; break }
    Start-Sleep -Seconds 1
}
if (-not $ok) { throw "Zotero 没关掉：$((Get-Process zotero).Id -join ' ')" }
Write-Host "  已确认退出（真查过进程）"

# ---- 2. 换 XPI ----
$extDir = Join-Path $env2.ProfileDir 'extensions'
New-Item -ItemType Directory -Force -Path $extDir | Out-Null
if (Test-Path $dst) { Remove-Item -Force $dst }
Copy-Item $Xpi $dst -Force
if ((Get-Item $dst).Length -ne (Get-Item $Xpi).Length) { throw "XPI 大小不一致" }

# ---- 3. 同步 extensions.json（用 node，无损读写） ----
$node = $env2.Node
if (-not $node) { throw "找不到 node —— 改 extensions.json 需要它" }
$rc = Invoke-Native -File $node -Arguments @(
    (Join-Path $PSScriptRoot 'patch_extensions.mjs'), 'set', $env2.ProfileDir, $ExtId, $pkg.version)
if ($rc -ne 0) { throw "extensions.json 改写失败（exit=$rc）" }

# ---- 4. 清启动缓存 ----
Remove-Item -Force (Join-Path $env2.ProfileDir 'addonStartup.json.lz4') -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force (Join-Path $env2.ProfileDir 'startupCache') -ErrorAction SilentlyContinue
Write-Host "  启动缓存已清"

# ---- 5. 回读：从 profile 里那份 XPI 解出 BUILD_TAG ----
$rb = Get-XpiBuildTag $dst
if ($tag -and $rb -ne $tag) {
    Write-Host "  ⚠️ 刚写完回读到 [$rb]（应为 $tag）—— 重写一次"
    Start-Sleep -Seconds 2
    Remove-Item -Force $dst; Copy-Item $Xpi $dst -Force
    $rb = Get-XpiBuildTag $dst
}
Write-Host "  回读 profile 内 XPI 的构建标记：[$(if ($rb) { $rb } else { '读不到' })]"

# ---- 6. 启动 + 等启动标记 ----
function Start-Zotero {
    if (-not $env2.ZoteroExe) { Write-Host "  ⚠️ 没找到 zotero.exe，请手工启动"; return }
    Start-Process $env2.ZoteroExe | Out-Null
}
function Wait-BootTag([string]$logPath, [int]$from, [string]$want, [int]$tries = 30) {
    if (-not $logPath -or -not (Test-Path $logPath)) { return $false }
    for ($i = 0; $i -lt $tries; $i++) {
        Start-Sleep -Seconds 2
        $txt = ''
        try {
            $fs = [System.IO.File]::Open($logPath, 'Open', 'Read', 'ReadWrite')
            try {
                $fs.Seek($from, 'Begin') | Out-Null
                $sr = New-Object System.IO.StreamReader($fs)
                $txt = $sr.ReadToEnd(); $sr.Close()
            } finally { $fs.Close() }
        } catch { continue }
        if ($txt -match [regex]::Escape("[boot] hooks.onStartup done | build=$want")) { return $true }
    }
    return $false
}

$logStart = 0
if ($log -and (Test-Path $log)) { $logStart = (Get-Item $log).Length }

Write-Host "启动 Zotero…"
Start-Zotero

if (-not $log -or -not (Test-Path $log)) {
    Write-Host "  ⚠️ 读不到日志 $(if ($log) { $log } else { '(未探测到)' }) —— 无法自动裁决"
    Write-Host "     请手工确认日志里出现 build=$tag"
    exit 0
}

if (Wait-BootTag $log $logStart $tag) {
    Write-Host "✅ 启动标记已确认：build=$tag"
} else {
    Write-Host "  没等到标记，再重启一次（区分「真没装上」与「读到旧缓存」）…"
    Get-Process zotero -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    for ($i = 0; $i -lt 30; $i++) {
        if (-not (Get-Process zotero -ErrorAction SilentlyContinue)) { break }
        Start-Sleep -Seconds 1
    }
    Remove-Item -Force (Join-Path $env2.ProfileDir 'addonStartup.json.lz4') -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force (Join-Path $env2.ProfileDir 'startupCache') -ErrorAction SilentlyContinue
    $logStart = if (Test-Path $log) { (Get-Item $log).Length } else { 0 }
    Start-Zotero
    if (Wait-BootTag $log $logStart $tag) {
        Write-Host "✅ 第二次启动确认：build=$tag"
    } else {
        Write-Host "❌ 两次启动都没出现 build=$tag —— 插件没加载这份代码（别当成功）"
        Write-Host "   （profile 内 XPI 回读到的标记：$(if ($rb) { $rb } else { '读不到' })）"
        Get-Content $log -Tail 8 | ForEach-Object { Write-Host "   $_" }
        exit 1
    }
}
Write-Host ""
Write-Host "== 装完：版本 $($pkg.version)，运行中的构建 = $tag =="
