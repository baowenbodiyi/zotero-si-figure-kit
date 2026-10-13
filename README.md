# Zotero 支撑信息（SI）看图补丁 —— 交接包

[![verify](https://github.com/baowenbodiyi/zotero-si-figure-kit/actions/workflows/verify.yml/badge.svg)](https://github.com/baowenbodiyi/zotero-si-figure-kit/actions/workflows/verify.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)

把这套改动**在另一台机器上复刻出来**需要的全部东西，都在这个目录里。
所有脚本都**不写死路径**：先探测你自己的环境，再按你的路径干活。

> **一句话**：给 Zotero 的 PDF 翻译插件加了一个「独立浮窗，显示正文里引用的
> 支撑信息（SI）插图」的功能；顺带修了译文段落间距、日志丢行等问题。
> **SI 是 Word（`.docx`）时同样能出图** —— 这是最难的一段（TIFF 解码）。

---

## 0. 三分钟判断这东西适不适合你

| 项 | 值 |
|---|---|
| 目标软件 | Zotero（在其内运行的插件，**不改 Zotero 本体**） |
| 已验证的 Zotero | **9.0.6**（Windows）；插件本身面向 Zotero 7/8/9 |
| 基线插件 | [`windingwind/zotero-pdf-translate`](https://github.com/windingwind/zotero-pdf-translate) **v2.4.8** |
| 交付形态 | 一个全量补丁（39 文件）+ 一份上游源码副本 + 测试与 fixture |
| 补丁后版本 | `2.4.8.67`，构建标记 `2.4.8.67+nodrag` |
| 需要联网 | **只有两步**：装 npm 依赖、`git clone` 上游（后者可选，已自带副本） |
| **附带的 Zotero** | ✅ **`vendor/zotero/Zotero-9.0.6_x64_setup.exe`**（官方原件，已验证 Authenticode 签名；见 `vendor/zotero/README.md`） |
| 离线可验 | ✅ **147 项断言全部离线跑**（21+59+13+54），不需要 Zotero、不需要论文 PDF |

**它做什么**

1. **SI 插图浮窗**：译文里出现 `Figure S3` / `Table S1` 这类引用时，在旁边弹一个
   独立浮窗，把 SI 里那张图**真的取出来显示**（可拖动、可缩放、位置尺寸记忆），
   同时把图注翻译一份。下一次翻译不再提到 SI → 浮窗自动收起。
2. **Word 版 SI 也能出图**：`.docx` 里的图是 **LZW + Predictor2 的 TIFF**，
   浏览器根本不能渲染 —— 包内自己解 ZIP、解 TIFF、再交给 canvas 编成真 PNG。
3. 译文渲染修复：段落间距（原来每行被渲染成两行）、公式 KaTeX、章节标题加粗、
   引用角标可点。

---

## 1. 前置条件

| 依赖 | 必需？ | 说明 |
|---|---|---|
| **Node.js + npm** | ✅ **唯一硬依赖** | 构建插件。**实测 Node 24**；建议 ≥18 |
| bash | 用 bash 路线时 | WSL / Linux / macOS / Git-Bash |
| PowerShell | 用 Windows 原生路线时 | 系统自带 5.1 即可，**不需要 PowerShell 7** |
| `patch` | ❌ **不需要了** | 补丁结果已摊成覆盖层；有 `patch` 的机器会用它**交叉校验**覆盖层没漂移 |
| `git` | ❌ 不需要 | 上游 v2.4.8 已自带副本；只有你要换基线时才需要 |
| python3 / `python` | 可选 | 环境探测时读 JSON；`check_overlay.py` 用它比对。有 Python 时多一层校验 |
| Python `PIL` | 可选 | PNG/TIFF 交叉验证多一层独立实现 |
| `parse5` | 自动装 | 段落间距测试必须用**真 HTML5 解析器**（`setup_deps.sh` 会装） |
| Zotero | 装插件时必需 | 包内已带 Windows x64 官方安装包（9.0.6）；其它平台用 `scripts/fetch_zotero.sh` |

> 补丁与**全部离线验收**不依赖 Zotero、不依赖任何论文 PDF —— 所以你可以先在本机把
> 逻辑全验一遍，再决定要不要装进 Zotero。

---

## 1.5 ⭐ 你是哪种宿主？先看这张表

这套东西最初只在 **Windows + WSL** 上跑通过。为了让别人也能复刻，做了宿主适配层
（`scripts/lib/host.sh`）和一条 Windows 原生路线。**四种宿主都有对应入口：**

| 你的环境 | 入口 | 一句话 |
|---|---|---|
| **Windows + WSL** | `bash scripts/*.sh` | 原作者的路线，全通 |
| **Linux** | `bash scripts/*.sh` | 同 WSL（少几个 9p 相关的等待） |
| **macOS** | `bash scripts/*.sh` | 已处理 BSD userland 与 **bash 3.2** 的差异（`stat -c`/`grep -P`/`sort -V`/`declare -A` 全部换掉了） |
| **Windows 原生（没装 WSL）** | `powershell -File .\scripts\windows-native\go.ps1 -Step all` | ⭐ 见 `scripts/windows-native/README.md` |

**为什么 Windows 原生要单独一套**：那台机器上实测 **没有 `patch`、没有 `git`**，
而原来的第一步就是 `patch`。所以把补丁结果预先摊成了
`plugins/translate/patched-2.4.8.67/` 覆盖层 —— `prepare` 只是「复制上游 + 盖上覆盖层」，
**任何平台都不再需要 `patch`**。

> 覆盖层和补丁不是两处独立事实：`scripts/lib/check_overlay.py` 会逐字节比对两者，
> CI 每次跑（`.github/workflows/verify.yml`），防止它们漂移。

**这四个平台不是"我说支持"**：CI（就是上面那个徽章）在 `ubuntu-latest` /
`macos-latest` / `windows-latest`（PowerShell 路线）各跑一遍全部离线断言，
外加两条守卫（覆盖层↔补丁逐字节一致、可移植性 lint）。macOS 我没有真机，
所以那里的结论**来自 CI，不是我本机实测** —— 这条边界请照抄。

---

## 2. 复刻步骤（每步都有验收标准）

```bash
cd zotero-si-figure-kit

# ── 步骤 -1：装 Zotero（**包内已带**，官方原件）
#    vendor/zotero/Zotero-9.0.6_x64_setup.exe   ← 双击装即可
#    为什么钉 9.0.6：这个插件补丁只在 9.0.6 上真跑过；写包时官方稳定版已是 10.0.6。
#    真实性：Authenticode 签名 Valid，签名主体 = Corporation for Digital Scholarship。
#    不想要这 90 MB 就删掉 vendor/，然后： bash scripts/fetch_zotero.sh
#    （已有 Zotero 9.0.6 的机器可跳过这一步）

# ── 步骤 0：探测本机环境（不问不猜）
bash scripts/discover_env.sh
#   验收：打印出你机器上的 ZOTERO_DIR / PROFILE_DIR / DATA_DIR / Zotero 版本
#   探测不到也没关系 —— 只有"装进 Zotero"那一步需要它们

# ── 步骤 1：准备源码树（上游 v2.4.8 + 覆盖层；**不需要 patch**）
bash scripts/prepare_src.sh
#   验收：✅ 覆盖层 == 补丁结果（逐字节）      ← 有 patch(1) 的机器会真比对，没有则跳过
#         ✅ 补丁涉及的文件全部就位（39 个）
#         package.json version = 2.4.8.67   BUILD_TAG = 2.4.8.67+nodrag

# ── 步骤 2：装依赖（唯一必须联网的一步）
bash scripts/setup_deps.sh
#   验收：✅ parse5 可用
#   ⚠️ 若你这台机器还留着已失效的 npm 代理，脚本会自动用 --userconfig /dev/null 重试

# ── 步骤 3：⭐ 全部离线验收（不需要 Zotero！）
bash scripts/verify_all.sh
#   验收：✅ 全部离线验收通过（项数见 §5 的表）

# ── 步骤 4：构建 XPI（先类型检查，再打包，最后校验产物里的构建标记）
bash scripts/build_plugin.sh
#   验收：✅ 类型检查通过 / ✅ 产物里确认含 build=2.4.8.67+nodrag

# ── 步骤 5：装进 Zotero
bash scripts/install_plugin.sh
#   验收：✅ 启动标记已确认：build=2.4.8.67+nodrag
#   （脚本核对的是"运行时真的加载了这份代码"，不是"文件拷过去了"）
```

**Windows 原生（没装 WSL）** 把上面 1–5 步换成一条：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows-native\go.ps1 -Step all
```

细节与四个 Windows 专属坑见 `scripts/windows-native/README.md`。

**装不上 / 只是想看代码？** 步骤 0–4 就够了 —— 补丁、构建、全部测试都不碰 Zotero。
第 5 步失败时脚本会打印手工安装步骤，而不是硬猜路径。

### 步骤 6（可选）：活体验证

自动化鼠标脚本在 `windows/`（仅 Windows，需要手动改坐标）。要验的三件事：

1. 打开一篇有 SI 的论文 → 划选含 `Figure S3` 的句子 → 浮窗出现且**图是那一张**；
2. 划选一段**不含 SI 引用**的参考文献 → 浮窗自动收起；
3. 浮窗里点「打开 SI」→ 用系统默认程序打开 SI 文件。

> 这三条我已在原机器上验过（见 `evidence/`）。它们**依赖真实论文与真实 Zotero**，
> 所以没法做成离线断言 —— 这也是本包最诚实的边界。

---

### 本包有两个分发变体

| 变体 | 大小 | 内容 | 什么时候用 |
|---|---|---|---|
| **`-slim`** | ~3.6 MB | 只有补丁 / 脚本 / 测试 / fixture | 对方**已经装了 Zotero 9.0.6**，或想自己下 |
| **完整版**（文件名不带 slim） | ~94 MB | slim + `vendor/zotero/` 里的官方安装包 | 要"一个包搞定"，或对方机器上什么都没有 |

两者内容**除 `vendor/` 外完全一致**；完整版也能随手删掉 `vendor/` 变成 slim。

---

## 3. 目录结构

```
zotero-si-figure-kit/
├── README.md                  ← 你正在读的（步骤 + 验收）
├── HANDBOOK.md                ← 交接手册：架构、全部实测坑、为什么这么做
├── MANIFEST.json              ← 机读清单（版本/文件/依赖/验证状态）
├── LICENSE                    ← AGPL-3.0（衍生自上游，见 §7）
├── .github/workflows/         ⭐ CI：ubuntu / macos / windows 三平台各跑一遍离线断言
│   └── verify.yml                 + 覆盖层↔补丁一致性 + 可移植性 lint
├── conf/kit.conf              ← discover_env.sh 生成（本机路径）
├── scripts/
│   ├── lib/                   ⭐ 宿主适配层（4 种宿主的差异全关在这里）
│   │   ├── host.sh               平台探测 / host_size / host_sha256 / host_py /
│   │   │                         host_latest / Zotero 查-关-开（分平台）
│   │   ├── check_overlay.py      「覆盖层 == 补丁结果」逐字节校验（防漂移）
│   │   └── lint_portable.sh      可移植性 lint（bash 3.2 / BSD 工具 / .ps1 的 BOM）
│   ├── discover_env.sh        探测 Zotero/node/python → 写 conf/kit.conf
│   ├── prepare_src.sh         上游 v2.4.8 + 覆盖层 → work/translate（**不需要 patch**）
│   ├── setup_deps.sh          npm ci + parse5（唯一需要联网）
│   ├── verify_all.sh          ⭐ 一键跑完全部离线验收
│   ├── build_plugin.sh        tsc + 打包 + 校验产物里的构建标记
│   ├── install_plugin.sh      装进 Zotero + 校验"运行时真的加载了"（分平台）
│   ├── build_si_plugin.sh     打包 SI 自动获取插件（可选）
│   ├── fetch_zotero.sh        下载 Zotero 安装包（包内已带 9.0.6，此为备用/换版本）
│   ├── audit_no_secrets.py    ⭐ 分发前自检：反查本机真实凭据是否被夹带
│   ├── fetch_upstream.sh      从 GitHub 拉上游 v2.4.8（可选，包内已自带）
│   └── windows-native/        ⭐ Windows 原生路线（无 WSL / 无 patch / 无 git）
│       ├── README.md             为什么需要它 + 四个 Windows 专属坑
│       ├── go.ps1                唯一入口：-Step discover|prepare|deps|build|verify|install|all
│       ├── discover_env.ps1      探测环境（含 app\application.ini 的版本号坑）
│       ├── prepare_src.ps1       覆盖层路线（robocopy + 落盘校验）
│       ├── build_plugin.ps1      tsc + 打包 + 从 XPI 里读回 BUILD_TAG
│       ├── verify.ps1            全部离线验收
│       ├── install_plugin.ps1    装进 Zotero + 等启动标记
│       └── patch_extensions.mjs  改 extensions.json（避开 ConvertTo-Json 的 -Depth 坑）
├── vendor/zotero/            ⭐ 官方 Zotero 9.0.6 Windows 安装包（90.8 MB，已验证签名）
│   │                            含来源 URL / sha256 / 签名指纹；不需要可整目录删掉
├── plugins/
│   ├── translate/
│   │   ├── zotero-pdf-translate-2.4.8.67-full.patch   ← 全部改动（人读的"真相"）
│   │   ├── patched-2.4.8.67/                          ⭐ 补丁结果覆盖层（39 文件，给没有 patch 的机器）
│   │   └── pristine-v2.4.8/                           ← 上游副本（离线基线）
│   └── si-fetcher/            SI 自动获取插件（JS + 可安装 XPI）
├── tests/
│   ├── kit.js                 公共：路径解析 / 断言 / SKIP
│   ├── test_renderspacing.js  译文渲染（真 HTML5 解析器数 <br>）
│   ├── test_sirefs.js         SI 引用解析 / 图注定位 / 附件挑选
│   ├── test_pngencode.js      PNG 编码器 / base64
│   ├── test_wordsi.js         Word SI：docx / TIFF / inflate / 端到端
│   ├── gen_fixtures.py        重新生成 fixture（有真数据时用）
│   └── fixtures/              ⭐ 自带真数据 fixture（含真 LZW-TIFF）
├── integrations/             其他服务的接入配置（**Index-Translate 免费公共 API**）
│   ├── README.md              实测事实 / 三个坑 / 怎么配 / 怎么验证
│   ├── configure_indextranslate.py  写 prefs（会重启 Zotero）
│   └── indextranslate_prompt.txt    验证过的提示词（**去掉示例块格式会退化**）
├── docs/
│   ├── 支撑信息图注定位_修复说明.md  ⭐ **只讲 SI 图注定位那一个 bug**（症状/根因/改法/复现/验证），
│   │                                独立可读，也可单独交给别的 AI —— 桌面也放了一份
│   ├── 交接手册_完整版.md      原项目的超长记忆文档（1600+ 行，所有细节）
│   └── SI获取流程.md          SI 怎么从出版社拿到并挂进 Zotero
├── evidence/                  活体验证截图（浮窗、修复前后对比）
└── windows/                   Windows 活体验证用的鼠标/截图脚本（可选）
```

---

## 4. 换基线（上游出新版了怎么办）

```bash
bash scripts/fetch_upstream.sh                      # 拉上游最新（或指定 tag）
bash scripts/fetch_upstream.sh /tmp/up v2.4.9       # 指定目录与 tag
```
脚本会**先 dry-run 校验补丁能不能干净打上**。打不上就说明上游改动与补丁冲突，
需要人工 rebase —— 包里 `docs/交接手册_完整版.md` 的 §22 记录了每处改动**为什么**那样改，
rebase 时按那份清单逐条还原即可。

---

## 4.5 分发前自检：包里有我的密钥吗？

```bash
python3 scripts/audit_no_secrets.py
```

它不是"扫一眼有没有 sk- 开头"，而是**反查**：
先收集**本机真实存在**的凭据（key 文件 + Zotero `prefs.js` 里 `secretObj` 的每一个子密钥），
再把这些值（连同 16 字符片段）在待审目录里搜一遍，最后补一遍通用模式扫描。

**本包交付前的实测结果（2026-10-12）**：

| 项 | 结果 |
|---|---|
| 本机真实凭据（MiMo key / GitHub PAT / MP key / 插件里配的两把 `sk-`） | **0 命中** |
| 插件自带 `defaultSecret`（上游公开仓库里就有的默认值） | 10 个，自动识别为默认值，**不算泄漏** |
| 私钥块 / AWS / GitHub PAT / Bearer / password 赋值 模式 | **全无** |
| 个人信息 | 仅 `docs/` 里的**原作者工作日志**含他的机器路径与用户名（是上下文，不是凭据） |

> ⚠️ 曾经踩到的：上一轮把作者的**个人邮箱**写死在了 OpenAlex 请求里（polite pool），
> 已移除（`2.4.8.67+nodrag`）。**补丁的新增行里个人信息命中数 = 0。**
> 想进 polite pool 的人自己加 `&mailto=你的邮箱`。

---

## 5. 这个包**验过什么 / 没验什么**（请照抄这个边界，不要替我扩大）

### ✅ 离线已验证（147 项断言，任何机器可重跑）

| 组 | 项数 | 对拍对象（都是**独立实现**，不是拿被测代码自证） |
|---|---|---|
| 译文渲染 | 21 | **真 HTML5 解析器 parse5** 数 `<br>`；并把"修复前写法"复刻做 A/B |
| SI 定位 | 59 | 真实 SI 全文 + 真实正文；真值由独立正则扫出 |
| PNG 编码 | 13 | **PIL** 解回来比像素；Node `Buffer` 比 base64 |
| Word SI | 54 | **PIL** 比 TIFF 的 RGBA sha256；**python zlib** 比 inflate；真 `.docx` |

`SKIP` 的小节表示本机没有那类真数据 —— **不是失败**，且同一代码路径已被 fixture 覆盖。

### ⚠️ 未验证（别当成已完成）

- **SI 的"下载"环节**：从出版社页面抓 SI 需要联网 + 浏览器登录态，
  不在离线验收范围内（那是另一个插件 `si-fetcher` 的事）。
- **多文件 SI**：`supplementary.js` 目前只下**第一个** `mmc` 链接；
  一篇同时有 `mmc1.docx` + `mmc2.pdf` 时只会挂第一个。**已知未修**（改动很小，见 `docs/SI获取流程.md`）。
- **浮窗的拖动/缩放/自动收起**：需要真人在 Zotero 里操作验证（原机器已验，见 `evidence/`）。
- **macOS**：我**没有真机**。GNU-only 写法（`stat -c` / `grep -P` / `sort -V` /
  `declare -A`）已经全部换掉，并有 `lint_portable.sh` 守着，但结论**来自 CI，不是我本机实测**。
- **装进 Zotero 之后的"活体验证"**（浮窗拖动、抓 SI、出版社登录态）：只有原作者那一台
  Windows+WSL 机器上验过。别的平台上装机脚本能跑通、能确认 `BUILD_TAG` 加载，
  但浮窗交互没人替你验过。

### ✅ 平台支持（这条是 CI 跑的，不是我说的）

| 宿主 | 路线 | 谁验的 |
|---|---|---|
| Windows + WSL | `bash scripts/*.sh` | ✅ 作者本机全链路（prepare→deps→build→verify，147 项） |
| Linux | `bash scripts/*.sh` | ✅ CI `ubuntu-latest` |
| macOS | `bash scripts/*.sh` | ✅ CI `macos-latest` |
| Windows 原生（无 WSL） | `scripts/windows-native/go.ps1` | ✅ 作者本机真跑 + CI `windows-latest` |

外加两项 CI 守卫：**覆盖层 ↔ 补丁逐字节一致**、**可移植性 lint**。

---

## 6. 出问题先看这里

| 症状 | 先查 |
|---|---|
| `npm ci` 报 network error | 脚本会自动绕过失效代理重试；仍失败就检查你的 npm 代理 |
| 装完插件但"没反应" | 看数据目录下 `zpt-debug.log` 有没有 `[boot] … build=2.4.8.67+nodrag`。**没有就是没装进去**，别看版本号 |
| 等不到构建标记 | 脚本会自动重启重试一次（`/mnt/c` 是 9p 挂载，有写回延迟，会读到旧字节） |
| 补丁打不上 | 上游 tag 与基线不一致 → `bash scripts/fetch_upstream.sh v2.4.8` |
| 浮窗里图不对/不出现 | 看日志里 `解析 Word SI …` 与 `配到图 …` 两行；`[si]` 前缀的都是这条链路 |

更细的排查路径见 `HANDBOOK.md` 与 `docs/交接手册_完整版.md`。

---

## 7. 许可、出处与第三方内容

### 许可

本仓库是 **[windingwind/zotero-pdf-translate](https://github.com/windingwind/zotero-pdf-translate)
（AGPL-3.0-or-later）的衍生作品** —— 全部改动以补丁形式提供，因此**本仓库同样是 AGPL-3.0**（见 `LICENSE`）。
再分发时请保留同样的许可与出处。

| 目录 | 是什么 | 许可/出处 |
|---|---|---|
| `plugins/translate/*.patch` | 我对上游 v2.4.8 的全部改动 | AGPL-3.0（衍生自上游） |
| `plugins/translate/pristine-v2.4.8/` | **上游原始代码副本**，只为离线打补丁/自检 | AGPL-3.0，版权归上游作者 |
| `plugins/si-fetcher/` | SI 自动获取插件（fork） | 源自 [Israfil-Hossen/zotero-supplementary-downloader](https://github.com/Israfil-Hossen/zotero-supplementary-downloader) |
| `vendor/zotero/` | **不含安装包**（已被 `.gitignore` 排除），只有来源说明 | Zotero 本体为 AGPL-3.0，属 [Corporation for Digital Scholarship](https://www.zotero.org/) |

> 本仓库**不包含** Zotero 安装包二进制 —— 用 `bash scripts/fetch_zotero.sh` 下载并校验 sha256。
> `vendor/zotero/README.md` 里记了官方地址、文件大小、sha256 与 Authenticode 签名指纹。

### 测试数据（第三方内容）

`tests/fixtures/` 里有为验证而取的**真实样本**，用于对拍真实世界的格式怪癖
（Word 表格、LZW-TIFF 下标、图注写法差异等）：少量**已发表论文的文本片段**、一张论文插图，
以及一段机翻结果。它们**仅用于测试**，版权归各自出版方/作者所有，不随本仓库的许可授权。
若要再分发本仓库，请自行评估这部分，或按 `tests/gen_fixtures.py` 用**你自己的**样本重新生成
（该脚本支持 `--real-docx` / `--si-text` / `--main-text` / `--cache` 指向任意本地文件）。

`evidence/` 里的截图同理：是排查过程的记录，画面中含论文图表。
