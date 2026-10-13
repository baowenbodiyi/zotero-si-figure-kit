# =============================================================================
# scripts/windows-native/discover_env.ps1
#   在「Windows 原生」（没有 WSL）上探测环境，返回一个 hashtable。
#
#   用法（被别的脚本引入）：
#       $env = & "$PSScriptRoot\discover_env.ps1"
#   用法（单独看结论）：
#       powershell -ExecutionPolicy Bypass -File .\scripts\windows-native\discover_env.ps1
#
#   ⚠️ 本文件必须存成 UTF-8 **with BOM** —— 否则 Windows PowerShell 5.1
#      会按 ANSI 解析，中文注释变乱码甚至语法错。
# =============================================================================

function Get-KitEnv {
    $r = [ordered]@{
        OS          = 'windows-native'
        ZoteroDir   = ''
        ZoteroExe   = ''
        ProfilesRoot= ''
        ProfileDir  = ''
        DataDir     = ''
        StorageDir  = ''
        ZoteroVer   = ''
        Node        = ''
        Npm         = ''
        Npx         = ''
        PluginVer   = ''
        SiPluginVer = ''
    }

    # ---------- Zotero 程序目录 ----------
    $cands = @(
        (Join-Path ${env:ProgramFiles} 'Zotero'),
        (Join-Path ${env:ProgramFiles(x86)} 'Zotero'),
        (Join-Path $env:LOCALAPPDATA 'Zotero')
    )
    foreach ($c in $cands) {
        if ($c -and (Test-Path (Join-Path $c 'zotero.exe'))) { $r.ZoteroDir = $c; break }
    }
    if ($r.ZoteroDir) {
        $r.ZoteroExe = Join-Path $r.ZoteroDir 'zotero.exe'
        # ⚠️ Zotero 9.x 的版本在 **app\application.ini**，不在安装根目录。
        #    实测 C:\Program Files\Zotero\application.ini 根本不存在，
        #    只查根目录会静默读到空版本。
        foreach ($rel in 'app\application.ini', 'application.ini') {
            $ini = Join-Path $r.ZoteroDir $rel
            if (-not (Test-Path $ini)) { continue }
            $line = Select-String -Path $ini -Pattern '^Version=' -ErrorAction SilentlyContinue |
                    Select-Object -First 1
            if ($line) { $r.ZoteroVer = ($line.Line -split '=', 2)[1].Trim(); break }
        }
    }

    # ---------- profile ----------
    $profRoot = Join-Path $env:APPDATA 'Zotero\Zotero\Profiles'
    if (Test-Path $profRoot) {
        $r.ProfilesRoot = $profRoot
        $iniPath = Join-Path $profRoot 'profiles.ini'
        if (Test-Path $iniPath) {
            $m = Select-String -Path $iniPath -Pattern '^Path=(.+)$' -ErrorAction SilentlyContinue |
                 Select-Object -First 1
            if ($m) {
                $rel = $m.Matches[0].Groups[1].Value.Trim()
                $p = Join-Path $profRoot $rel
                if (Test-Path $p) { $r.ProfileDir = $p }
            }
        }
        if (-not $r.ProfileDir) {
            $d = Get-ChildItem -Path $profRoot -Directory -Filter '*.default' -ErrorAction SilentlyContinue |
                 Select-Object -First 1
            if ($d) { $r.ProfileDir = $d.FullName }
        }
    }

    # ---------- 数据目录：优先 prefs.js 里的 dataDir ----------
    if ($r.ProfileDir) {
        $prefs = Join-Path $r.ProfileDir 'prefs.js'
        if (Test-Path $prefs) {
            $txt = Get-Content -Raw -Encoding UTF8 $prefs
            $m = [regex]::Match($txt, 'extensions\.zotero\.dataDir",\s*"((?:[^"\\]|\\.)*)"')
            if ($m.Success) {
                $r.DataDir = $m.Groups[1].Value.Replace('\\', '\').Replace('\"', '"')
            }
        }
    }
    if (-not $r.DataDir) {
        $d = Join-Path $env:USERPROFILE 'Zotero'
        if (Test-Path $d) { $r.DataDir = $d }
    }
    if ($r.DataDir) { $r.StorageDir = Join-Path $r.DataDir 'storage' }

    # ---------- Node 工具链 ----------
    foreach ($pair in @(@('Node','node'), @('Npm','npm'), @('Npx','npx'))) {
        $g = Get-Command $pair[1] -ErrorAction SilentlyContinue
        if ($g) { $r[$pair[0]] = $g.Source }
    }

    # ---------- 已装插件版本（交给 node 读，避开 ConvertFrom-Json 的坑） ----------
    $mjs = Join-Path $PSScriptRoot 'patch_extensions.mjs'
    if ($r.ProfileDir -and $r.Node -and (Test-Path $mjs)) {
        $r.PluginVer   = (& $r.Node $mjs get $r.ProfileDir 'zoteropdftranslate@euclpts.com' 2>$null)
        $r.SiPluginVer = (& $r.Node $mjs get $r.ProfileDir 'suppl-dl@example.com' 2>$null)
    }

    return $r
}

# --- 直接运行时打印结论 -------------------------------------------------------
if ($MyInvocation.InvocationName -ne '.') {
    $e = Get-KitEnv
    Write-Host "== Windows 原生环境 =="
    foreach ($k in 'ZoteroDir','ZoteroExe','ProfilesRoot','ProfileDir','DataDir','StorageDir',
                   'ZoteroVer','PluginVer','SiPluginVer','Node','Npm','Npx') {
        $v = $e[$k]; if (-not $v) { $v = '(没找到)' }
        Write-Host ("  {0,-13} = {1}" -f $k, $v)
    }
    if (-not $e.Node) {
        Write-Host ""
        Write-Host "  ❌ 没找到 Node.js —— 这是构建插件的唯一硬依赖。"
        Write-Host "     装它： winget install OpenJS.NodeJS.LTS   或   https://nodejs.org/"
    }
    Write-Host ""
    Write-Host "  下一步： .\scripts\windows-native\go.ps1 -Step all"
}
