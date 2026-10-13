# Windows 原生路线（不需要 WSL）

**给谁用**：Zotero 装在 Windows 上，但**没有装 WSL**（这是 Zotero 插件用户里最常见的情况）。

## 为什么需要单独一条路

kit 原来只有 bash 路线。在一台干净的 Windows 上我实测过工具链：

| 工具 | Windows 原生 | 说明 |
|---|---|---|
| `node` / `npm` / `npx` | ✅ 有 | 插件的唯一硬依赖 |
| `curl.exe` / `tar.exe` | ✅ 有 | Win10 起自带 |
| **`patch`** | ❌ **没有** | 打补丁必需 —— 而这是原来的第一步 |
| **`git`** | ❌ **没有** | `fetch_upstream.sh` 需要 |
| `zip` / `sha256sum` | ❌ 没有 | 有替代品（`Compress-Archive` / `Get-FileHash`） |

所以「装个 patch 和 git」比「直接用 Node」麻烦得多。
本目录的做法是**把 patch 变成不必要**：补丁结果已预先摊成覆盖层
`plugins/translate/patched-2.4.8.67/`，`prepare` 只是「复制上游 + 盖上覆盖层」。

> 覆盖层与补丁**不是两处独立事实**：`scripts/lib/check_overlay.py` 会在有
> `patch(1)` 的机器上逐字节比对两者，CI 每次都会跑（见 `.github/workflows/verify.yml`）。

## 前置条件

| 依赖 | 必需 | 说明 |
|---|---|---|
| **Node.js LTS** | ✅ | `winget install OpenJS.NodeJS.LTS` 或 https://nodejs.org/ |
| PowerShell | ✅ | 系统自带 5.1 即可（不需要 PowerShell 7） |
| Zotero | 装插件那步需要 | 没装也能跑完 prepare/deps/build/verify |

## 一条命令

```powershell
cd zotero-si-figure-kit
powershell -ExecutionPolicy Bypass -File .\scripts\windows-native\go.ps1 -Step all
```

`-Step all` = `prepare → deps → build → verify → install`（最后一步会强制关掉再开 Zotero）。

想分步做：

```powershell
.\scripts\windows-native\go.ps1 -Step discover   # 只看环境，不改任何东西
.\scripts\windows-native\go.ps1 -Step prepare    # 上游 + 覆盖层 → work\translate
.\scripts\windows-native\go.ps1 -Step deps       # npm ci（唯一需要联网的一步）
.\scripts\windows-native\go.ps1 -Step build      # tsc --noEmit + 打包 + 校验 BUILD_TAG
.\scripts\windows-native\go.ps1 -Step verify     # 全部离线验收
.\scripts\windows-native\go.ps1 -Step install    # 装进 Zotero 并证明它真加载了
```

## 每步的验收标准

| 步骤 | 你应该看到 |
|---|---|
| `discover` | `ZoteroDir` / `ProfileDir` / `DataDir` / `ZoteroVer` 有值（探测不到会显示「(没找到)」，且不猜） |
| `prepare` | `✅ 覆盖层 39 个文件全部就位且逐字节一致` + `BUILD_TAG = 2.4.8.67+nodrag` |
| `deps` | `✅ 依赖就绪` |
| `build` | `✅ 类型检查通过` + `✅ 产物里确认含 build=2.4.8.67+nodrag` |
| `verify` | `✅ 全部离线验收通过` |
| `install` | `✅ 启动标记已确认：build=2.4.8.67+nodrag` |

## 七个实测坑（都在这套脚本里处理掉了）

1. **`npm`/`npx` 必须走 `.cmd`，不能走 `.ps1`。**
   PowerShell 默认执行策略会拒绝 `npm.ps1`（`PSSecurityException: UnauthorizedAccess`），
   `npm.cmd` 不受影响。脚本里 `Resolve-Cmd` 优先找 `.cmd`。

2. **Zotero 9.x 的版本号在 `app\application.ini`，不在安装根目录。**
   `C:\Program Files\Zotero\application.ini` **不存在** —— 只查根目录会静默读到空版本。

3. **`.ps1` 必须存成 UTF-8 with BOM。**
   否则 Windows PowerShell 5.1 按 ANSI 解析，中文注释变乱码。
   `scripts/lib/lint_portable.sh` 会检查这一点（CI 里跑）。

4. **改 `extensions.json` 不要用 `ConvertTo-Json`。**
   它默认 `-Depth 2`，深层字段会被截成字符串，而这是 Zotero 的真实文件 ——
   写坏了 Zotero 会认为插件损坏并把它删掉。所以这一步交给
   `patch_extensions.mjs`（Node 的 `JSON.parse/stringify` 是无损的）。

5. **⭐ `ErrorActionPreference='Stop'` + 外部程序写 stderr = 脚本中途死掉。**
   `npm ci` 会往 stderr 写 deprecated 警告，PowerShell 把那当成**终止性错误** ——
   表现是「npm 明明装完了（`node_modules/.package-lock.json` 已写），脚本却停在那儿，
   后面一步都不跑，日志只剩半行」。所以所有外部程序调用都走
   `Invoke-Native`（调用期间放宽 ErrorActionPreference，**以退出码判成败**，不看有没有红字）。

6. **`$x = if (...) { @('ci') }` 会把单元素数组解包成字符串。**
   后面 `+=` 数组时按 `$OFS` 拼接，结果粘成 `ci--no-audit --no-fund` 传给 npm，
   报 `Unknown command: "ci--no-audit --no-fund"`。必须**显式逐项 `+=`**。

7. **`require('parse5')` 必须在 `tests/` 目录里做。**
   Node 的模块解析是按 cwd 往上找的。在别处做会报 `Cannot find module 'parse5'` ——
   明明装上了却说没装。（同理：PowerShell 若从 WSL 启动，cwd 会是
   `\\wsl.localhost\...` 这种 UNC 路径，所以 `go.ps1` 开头会把 cwd 钉到 kit 根。）

另外：`_common.ps1` 会把控制台输出编码设成 UTF-8，否则 node 写的中文
在中文 Windows（码页 936）上是乱码，`Out-File` 再存一次就变成**有损的二次编码**，
事后都还原不回来。

## 和 bash 路线的关系

两条路线**产物一致**，都实测过：

| 比什么 | 结果 |
|---|---|
| `prepare` 输出的源码树 | **191 个文件逐字节相同**（Windows 原生 vs WSL） |
| 构建出的 XPI | 都是 **928,845 字节**；内部 68 项里 **67 项字节相同**，唯一差异是 `preferences.xhtml` 里嵌入的**构建时间戳**（`"time": "…"`），长度都一样 |
| 147 项离线断言 | 两边都 **147/147 通过** |

区别只在外壳：

| | bash 路线 | Windows 原生路线 |
|---|---|---|
| 入口 | `scripts/*.sh` | `scripts/windows-native/*.ps1` |
| 宿主 | WSL / Linux / macOS / Git-Bash | Windows PowerShell |
| 装 Zotero | PowerShell（WSL 借道）或直接启进程 | `Get-Process` / `Start-Process` |

如果你在 Windows 上装了 Git Bash，**两条都能用**；不装 WSL 就用本目录这条。
