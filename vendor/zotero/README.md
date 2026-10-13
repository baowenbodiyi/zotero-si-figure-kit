# Zotero 9.0.6（Windows x64 安装包）

```
Zotero-9.0.6_x64_setup.exe
sha256  973bfc96a7af8b2949bbfdc46b220366b2b204942ac30d50aef9835eb152d31c
大小    95,241,152 字节（90.8 MB）
```

## 为什么带的是 9.0.6，而不是最新版

本包里的插件补丁**只在 Zotero 9.0.6 上真跑过**（活体验证：浮窗、Word SI 出图、
段落间距、自动收起都是在这版上验的）。写这份包的时候官方稳定版已经是 **10.0.6**，
所以这里**故意钉住 9.0.6** —— 目标是"复现同一套环境"，不是"装最新"。

想用更新的 Zotero 也可以，但那就属于**未验证组合**了。

## 官方下载地址（2026-10-12 实测，均 HTTP 200）

| 平台 | 文件 | 大小（字节） |
|---|---|---|
| **Windows x64** | `https://download.zotero.org/client/release/9.0.6/Zotero-9.0.6_x64_setup.exe` | 95,241,152 |
| macOS | `https://download.zotero.org/client/release/9.0.6/Zotero-9.0.6.dmg` | 178,020,003 |
| Linux x86_64 | `https://download.zotero.org/client/release/9.0.6/Zotero-9.0.6_linux-x86_64.tar.xz` | 103,967,044 |

⚠️ 命名有坑：Windows 是 `_x64_setup.exe`（不是 `_win-x64_setup.exe`），
Linux 是 **`.tar.xz`**（`.tar.bz2` / `.tar.gz` 都 403）。写错就是 403，不是 404。

包内只带了 **Windows x64** 那一份（已下载 + 验签 + 记哈希）。
macOS / Linux 用 `bash scripts/fetch_zotero.sh 9.0.6 mac`（或 `linux-x86_64`）现拉。

## 来源与真实性

| 项 | 值 |
|---|---|
| 下载地址 | `https://download.zotero.org/client/release/9.0.6/Zotero-9.0.6_x64_setup.exe` |
| 下载日期 | 2026-10-12 |
| Authenticode 签名 | **Valid** |
| 签名主体 | `CN=Corporation for Digital Scholarship, O=Corporation for Digital Scholarship, L=Vienna, S=Virginia, C=US`（即 Zotero 官方机构） |
| 签发 CA | `CN=SSL.com EV Code Signing Intermediate CA RSA R3` |
| 证书指纹 | `1667BFAB98EFEB0E290B9B9C8EFF503AD1CFD33D` |
| 时间戳 | 有 |

Windows 上自己复核签名：

```powershell
Get-AuthenticodeSignature .\Zotero-9.0.6_x64_setup.exe | Format-List Status,SignerCertificate
```

Linux/WSL 上至少核对哈希：

```bash
sha256sum -c <<< "973bfc96a7af8b2949bbfdc46b220366b2b204942ac30d50aef9835eb152d31c  Zotero-9.0.6_x64_setup.exe"
```

> 官方 release 目录**不提供** per-file 的 `SHA256SUMS`（试过，403）。
> 所以这里的哈希是**下载后自己算的**，它能证明"文件没损坏/没被替换成别的版本"，
> 但**证明不了来源**——来源靠上面那条 Authenticode 签名。

## 安装

1. 双击 `Zotero-9.0.6_x64_setup.exe`（它会装到 `C:\Program Files\Zotero`，与你现有的可以共存/覆盖升级）
2. 装完启动一次，让它建好 profile
3. 回到包根目录： `bash scripts/discover_env.sh` → `bash scripts/install_plugin.sh`

## 许可

Zotero 是自由软件，**AGPL-3.0**。这里分发的是**官方未修改的安装包**（仅做搬运）。
源码与许可：<https://www.zotero.org/>、<https://github.com/zotero/zotero>

如果你不需要这一份，直接删掉 `vendor/` 即可 —— 包会从 ~90 MB 缩回 ~3.6 MB，
其余脚本会自动改用 `scripts/fetch_zotero.sh` 现场下载。
