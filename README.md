# Zotero 支撑信息（SI）看图补丁 —— 交接包

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
| 离线可验 | ✅ **134 项断言全部离线跑**，不需要 Zotero、不需要论文 PDF |

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
| Node.js + npm | ✅ 必需 | 构建插件。**实测 Node 24**；建议 ≥18 |
| bash | ✅ 必需 | 所有脚本；Windows 上请在 **WSL / Git Bash** 里跑 |
| `patch` | ✅ 必需 | 打补丁（GNU patch） |
| `unzip` | 打包 SI 插件时需要 | 其余步骤不需要 |
| python3 | 可选 | 有则：PNG 交叉验证多一层（PIL）；重新生成 fixture 时需要 |
| Python `PIL` | 可选 | 同上 |
| `parse5` | 自动装 | 段落间距测试必须用**真 HTML5 解析器**（`setup_deps.sh` 会装） |
| Zotero | ✅ 包内已带 | Windows x64 官方安装包（9.0.6）；其它平台用 `scripts/fetch_zotero.sh` |

> 补丁与**全部离线验收**不依赖 Zotero、不依赖任何论文 PDF —— 所以你可以先在本机把
> 逻辑全验一遍，再决定要不要装进 Zotero。

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

# ── 步骤 1：把补丁打到上游源码上（用包内自带的 v2.4.8 副本，离线可做）
bash scripts/apply_patch.sh
#   验收：✅ 补丁涉及的文件全部就位（39 个）
#         package.json version = 2.4.8.67   BUILD_TAG = 2.4.8.67+nodrag

# ── 步骤 2：装依赖（唯一必须联网的一步）
bash scripts/setup_deps.sh
#   验收：✅ parse5 可用
#   ⚠️ 若你这台机器还留着已失效的 npm 代理，脚本会自动用 --userconfig /dev/null 重试

# ── 步骤 3：⭐ 全部离线验收（不需要 Zotero！）
bash scripts/verify_all.sh
#   验收：✅ 全部离线验收通过
#         段落间距 21 / SI 定位 59 / PNG 13 / Word SI 41  ——  0 失败

# ── 步骤 4：构建 XPI（先类型检查，再打包，最后校验产物里的构建标记）
bash scripts/build_plugin.sh
#   验收：✅ 类型检查通过 / ✅ 产物里确认含 build=2.4.8.67+nodrag

# ── 步骤 5：装进 Zotero
bash scripts/install_plugin.sh
#   验收：✅ 启动标记已确认：build=2.4.8.67+nodrag
#   （脚本核对的是"运行时真的加载了这份代码"，不是"文件拷过去了"）
```

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
├── conf/kit.conf              ← discover_env.sh 生成（本机路径）
├── scripts/
│   ├── discover_env.sh        探测 Zotero/node/python → 写 conf/kit.conf
│   ├── apply_patch.sh         上游 v2.4.8 + 补丁 → work/translate
│   ├── setup_deps.sh          npm ci + parse5（唯一需要联网）
│   ├── verify_all.sh          ⭐ 一键跑完 4 组离线验收
│   ├── build_plugin.sh        tsc + 打包 + 校验产物里的构建标记
│   ├── install_plugin.sh      装进 Zotero + 校验"运行时真的加载了"
│   ├── build_si_plugin.sh     打包 SI 自动获取插件（可选）
│   ├── fetch_zotero.sh        下载 Zotero 安装包（包内已带 9.0.6，此为备用/换版本）
│   ├── audit_no_secrets.py    ⭐ 分发前自检：反查本机真实凭据是否被夹带
│   └── fetch_upstream.sh      从 GitHub 拉上游 v2.4.8（可选，包内已自带）
├── vendor/zotero/            ⭐ 官方 Zotero 9.0.6 Windows 安装包（90.8 MB，已验证签名）
│   │                            含来源 URL / sha256 / 签名指纹；不需要可整目录删掉
├── plugins/
│   ├── translate/
│   │   ├── zotero-pdf-translate-2.4.8.67-full.patch   ← 全部改动
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

### ✅ 离线已验证（134 项断言，任何机器可重跑）

| 组 | 项数 | 对拍对象（都是**独立实现**，不是拿被测代码自证） |
|---|---|---|
| 译文渲染 | 21 | **真 HTML5 解析器 parse5** 数 `<br>`；并把"修复前写法"复刻做 A/B |
| SI 定位 | 59 | 真实 SI 全文 + 真实正文；真值由独立正则扫出 |
| PNG 编码 | 13 | **PIL** 解回来比像素；Node `Buffer` 比 base64 |
| Word SI | 41 | **PIL** 比 TIFF 的 RGBA sha256；**python zlib** 比 inflate；真 `.docx` |

`SKIP` 的小节表示本机没有那类真数据 —— **不是失败**，且同一代码路径已被 fixture 覆盖。

### ⚠️ 未验证（别当成已完成）

- **SI 的"下载"环节**：从出版社页面抓 SI 需要联网 + 浏览器登录态，
  不在离线验收范围内（那是另一个插件 `si-fetcher` 的事）。
- **多文件 SI**：`supplementary.js` 目前只下**第一个** `mmc` 链接；
  一篇同时有 `mmc1.docx` + `mmc2.pdf` 时只会挂第一个。**已知未修**（改动很小，见 `docs/SI获取流程.md`）。
- **浮窗的拖动/缩放/自动收起**：需要真人在 Zotero 里操作验证（原机器已验，见 `evidence/`）。
- **跨平台**：只在 **Windows + WSL** 上真跑过。Linux/macOS 上补丁与离线测试应当可用，
  但"装进 Zotero"的脚本只覆盖 Windows/WSL 路径，其它平台请手工装 XPI。

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
