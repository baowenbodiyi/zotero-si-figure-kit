# 拿到一篇文献的 Supporting Information（SI）并挂进 Zotero

> 场景：正文里引用了 `Figure S16`、`Table S1` 这类补充材料，但库里的条目只有正文 PDF，没有 SI。
> 建立于 2026-10-12，在 JACS 那篇（DOI `10.1021/jacs.5c00999`）上端到端跑通。

---

## 为什么不能靠插件自动下

| 方案 | 结果 |
|---|---|
| Zotero 内置隐藏设置 `extensions.zotero.translators.attachSupplementary` | ❌ **坏了**。issue `zotero/translators#3281`（2024-03 提）至今 open；2025-09 论坛帖证实 Zotero 7 里该设置**被忽略**，translator 读出来永远是 `false` |
| 第三方插件 `Israfil-Hossen/zotero-supplementary-downloader` v1.3.0 | ⚠️ **已装**（本机改过兼容上限），用 `Zotero.HTTP.request` 抓出版社页面。**ACS / Elsevier 会 403**（Cloudflare 反爬，实测 `pubs.acs.org` 三个 URL 全是 403）。Open Access 出版社（MDPI / PLOS / bioRxiv / PNAS）**可能能过**，可以拿那些试 |
| **用户的真实 Edge** | ✅ **能过**。真实浏览器会话能过 Cloudflare 挑战 —— 这是下面这套流程的基础 |

---

## 流程（一篇约 1 分钟）

### 0. 拿到 DOI

从 Zotero 条目的「DOI」字段读，或从正文页眉找。

### 1. 打通 Edge 调试通道

```bash
cd /home/<user>/deepseekagent
bash browser_up.sh --check          # 先体检
```

不通就启动调试 Edge（**独立 profile `C:\EdgeDebug`，不动日常浏览器**）：

```bash
/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -NoProfile -Command \
  "Start-Process -FilePath 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe' \
   -ArgumentList '--remote-debugging-port=9222','--user-data-dir=C:\EdgeDebug','--no-first-run','--no-default-browser-check'"
```

验证（`WINIP` 是 Windows 主机 IP）：

```bash
WINIP=$(ip route show default | awk '{print $3}')
curl -s "http://$WINIP:9222/json/version"     # 返回 {"Browser":"Edg/..."} 即通
```

> ⚠️ 若 netstat 显示 Edge 只监听 `[::1]:9222`，portproxy 必须是 **v4tov6 → ::1**（见 `~/.dsh/备忘_Edge浏览器控制.md` 第 2 节），需要管理员。

### 2. 用浏览器打开出版社页面（过 Cloudflare）

```bash
cd /home/<user>/deepseekagent
python3 mcp_browser_client.py navigate "https://doi.org/<DOI>"
sleep 15        # 给 Cloudflare 挑战留时间
python3 mcp_browser_client.py eval "() => document.title + ' || ' + location.href"
```

标题里出现真实论文名（不再是「请稍候…」）就说明过了。

> ⚠️ `evaluate_script` **只接受自包含函数表达式**：`() => ...` 可以，`((x)=>{...})("y")` 会报 `fn is not a function`。

### 3. 抓 SI 链接

```bash
python3 mcp_browser_client.py eval "() => { const out=[]; document.querySelectorAll('a').forEach(a=>{const t=(a.textContent||'').trim(),h=a.href||''; if(/suppl|supporting/i.test(t)||/suppl|supporting/i.test(h)) out.push(t.slice(0,50)+' >>> '+h);}); return [...new Set(out)].slice(0,10).join('\n'); }"
```

实测（ACS）会拿到形如：

```
https://pubs.acs.org/jacsat/article-supplement/3737023/pdf/ja5c00999_si_001/
```

### 4. 用会话下载

```bash
python3 mcp_browser_client.py eval "() => { const u='<上一步的 SI 链接>'; const a=document.createElement('a'); a.href=u; a.download='<DOI后缀>_si.pdf'; document.body.appendChild(a); a.click(); return 'ok'; }"
sleep 10
ls -la /mnt/c/Users/<user>/Downloads/ | tail -3
```

> 下载落在 Windows 的 `C:\Users\<user>\Downloads\`。

### 5. 挂进 Zotero（走 Zotero 自己的「附加存储的副本」，不碰数据库）

1. 库视图里右键该条目 → **添加附件 → 文件**
2. 弹出的「选择文件」对话框用**控件级**操作（零坐标）：
   - `ctl_set_text("选择文件", ctrlid=1148, text="C:\\Users\\Administrator\\Downloads\\xxx_si.pdf")`
   - `ctl_click("选择文件", ctrlid=1)`（打开）
3. 校验：`storage/<新KEY>/` 出现该 PDF，且 Zotero 自动生成 `.zotero-ft-cache`（说明已索引）

> ⚠️ 右键菜单在 UIA 树里是主窗口的子节点：用 `tool_skyshot` 拿到索引 → `tool_element_action_at(index, "press")`。
> 「添加附件」是子菜单，先 press 它，再 skyshot 一次拿子项索引（`文件` = 附加存储的副本）。

---

## 实测记录（2026-10-12，JACS 那篇）

| 步骤 | 结果 |
|---|---|
| `pubs.acs.org` 直接 HTTP（Zotero 插件那条路） | **403 Forbidden** |
| 用户的 Edge 打开 | 标题正常，Cloudflare 已过 |
| 抓到 SI 链接 | `.../article-supplement/3737023/pdf/ja5c00999_si_001/` |
| 下载 | `Downloads/ja5c00999_si_001.pdf`，**5,723,617 字节** |
| 内容校验 | **53 页**，36 个 `Figure/Table S*` 图注，含 S16–S24（与正文引用一致）✅ |
| 挂进 Zotero | 附件 `MMGQ9WX2`，parentItemID=1003，条目附件数 1 → **2** ✅ |

---

## 与「点 SI 角标跳到图」功能的关系

这条路解决的是**前提**：SI 得先在库里、且是**该条目的子附件**。
子附件挂好之后，「点译文里的 `Figure S18` → 跳到 SI 第 4 页」就能可靠工作了
（定位算法已验证：Zotero 的 `.zotero-ft-cache` 按 `\f` 切出来的段号 = PDF 页号，偏移 0）。

---

## 遗留

- 这套流程目前是**手工驱动**（用户说一句「帮我把这篇的 SI 弄进来」我就跑一遍）。
  频次低（一次一篇），没做成插件。
- 若要半自动化，可把第 2–4 步写成一个 `get_si.sh <DOI>` 脚本；
  最难自动化的其实是第 5 步（挂附件要过 Zotero UI），但已经有用 UIA + 控件级对话框的稳定做法。
- ⚠️ **多文件 SI 只会挂第一个**（2026-10-12 发现，未修）。
  `si-downloader/supplementary.js:188` 写的是 `links[0]`：
  一篇同时有 `mmc1.docx` + `mmc2.pdf`（Elsevier 很常见）时，只下 `mmc1`。
  `_extractLinks` 本身是返回全部的，所以改动能很小（循环 + 逐个 `_attachBytes`，
  浏览器路径 `SiCdp.fetchSi` 也要一起改成多个）。
  **没当场改的原因**：需要先找到一篇真有多条 `mmc` 链接的论文才能验证，
  而 ScienceDirect 现在挡住 curl、只能走浏览器 —— 不做没验证过的改动。
  遇见时告诉我，我改完照旧给离线 + 活体两套证据。

---

# 附：已改成插件（v1.4.2，2026-10-12）

把上面那套手工流程做进了插件 —— **改造自 `Israfil-Hossen/zotero-supplementary-downloader` v1.3.0**。

## 它现在做什么

选中条目 → 右键 → **「获取 Supporting Information（走浏览器）」**：

1. 探测/启动调试 Edge（`--remote-debugging-port=9222 --remote-allow-origins=* --user-data-dir=C:\EdgeDebug`）
2. 经 CDP 新开标签页 → 打开条目的 URL / DOI 页面（**过 Cloudflare**）
3. **轮询等 SI 链接出现**（最多 45s；只等标题是不够的，链接是后渲染的）
4. 在页面里 `fetch` SI 的字节 → base64 分块传回
5. 落临时文件 → `Zotero.Attachments.importFromFile` → 挂成该条目的**子附件**
   名字 `[SI] <原名>`，打 `SI` 标签（红色）

直接抓页面失败（403）时**自动回退**到原来的直连方式，开放出版社仍可用。

## 改造过程中验证掉的四个技术未知数

| 未知数 | 结论 |
|---|---|
| 插件沙箱能不能 HTTP 摸到 CDP | ✅ `http://127.0.0.1:9222` 直通 |
| 沙箱里有没有 `WebSocket` | ❌ **没有**（`globalThis.WebSocket === undefined`）；但 **`Zotero.getMainWindow().WebSocket` 可用** |
| 能不能连上 CDP | ⚠️ 必须带 `--remote-allow-origins=*`。实测：不带 Origin → `101`，**带 Origin → `403`**，加参数后 → `101` |
| 全链路取字节 | ✅ 页面内 `fetch` → base64 分 3 块 → 5,723,617 字节 → 53 页 SI，与浏览器下载逐字节一致 |

## ⚠️ 打包的坑（很重要）

**自己重写 manifest 会被 Zotero 拒绝安装**，报「可能无法与该版本的 Zotero 兼容」，
而且**直接塞进 `extensions/` 也会在下次启动时被清掉**（连 XPI 一起删）。

二分定位：从**原始能装的 XPI** 出发，只替换 JS 文件 + 改版本号 → **通过**。
所以问题出在我改写的 manifest 字段上（怀疑是缺 `update_url`，或 `strict_min_version` 从 `6.999` 改成 `7.0`）。
**教训：改别人的插件，manifest 别动，只换实现。**

## 安装

```bash
# 已装好。重装：Zotero → 工具 → 插件 → 齿轮 → Install Plugin From File…
D:\<datadir>\_zotero_patch\zotero-si-fetcher-1.4.2.xpi
```

## 与「看图」需求的衔接

SI 挂成**子附件**（名字带 `[SI]`、带 `SI` 标签）之后，「把 SI 里那张图**单独**显示出来」
就能可靠认出这是哪篇的 SI 了。

**这条已经做完并活体验证通过**（2026-10-12，翻译插件 **2.4.8.45**）：

| | |
|---|---|
| 识别 SI | 同一父条目下的 PDF 里按 `[SI]` 前缀 / `supporting information` / `SI` 标签打分，**够了才用**，没有就静默不显示 |
| 认引用 | `parseSiRefs()` 只认带 `S` 的号（`Figure S18`）；`Figure 3` 不算 —— 这是「SI 图 vs 本文图」的唯一防线 |
| 找页码 | SI 已索引全文按 `\f` 分页，**段号 = 0-based 页码**；只认**行首**图注（排除表格说明里的行内引用）；`S6b` 找不到就退到 `S6` |
| **取图** | 图页恰好只有一张嵌入位图 → pdf.js 取出解码后的 RGBA → **reader 窗口的 canvas 编真 PNG（原始分辨率）** |
| 显示 | **独立浮窗**（不在翻译弹窗里）：拖标题栏移动、拖右下角改大小、位置尺寸记忆；插图为原始分辨率，缩放后依然清晰 |

实测：划选含 `(Figure 4 and Figure S3)` 的句子 → 浮窗**只列 Figure S3**（不列 Figure 4），
显示 1402×1551 原图（dataURL 仅 255922 字符 —— 真 zlib 压缩，比降采样那版**分辨率 3 倍、体积小 5 倍**）。

已知边界：**表格页是矢量的、没有嵌入位图**，这一版取不到图，浮窗里只保留图注 + 页码。

实现细节与踩坑（**四个跨 realm 的坑**）见 `README_持久化翻译记忆补丁.md` §22。

---

# ⚠️ Elsevier 专题（2026-10-12 实测，别再踩）

## 结论一：**ScienceDirect 的付费墙提示 ≠ 支撑信息下不了**

用户看到的 `North Minzu University does not subscribe to this content on ScienceDirect.` 只管**正文**。
Elsevier 的 SI 放在 **`ars.els-cdn.com`**，实测**不带任何凭据**（curl 无 cookie）就能拿到：

| SI 文件 | 结果 |
|---|---|
| `…S0008622317311703-mmc1.docx` | HTTP 200，1,459,647 字节 |
| `…S1385894726039252-mmc1.docx` | HTTP 200，20,508,100 字节 |

所以「没订阅」时照样可以下 SI。

## 结论二：但插件当时**两条路都断了**（已修，v1.4.4）

| # | 问题 | 修法 |
|---|---|---|
| ① | **找不到 SI 链接**。判据要求链接里出现 `suppl`/`supporting`，而 Elsevier 的链接是 `…-mmc1.docx`、文案是 `Download: Download Word document (1MB)` —— 两头都不含，直接被丢掉 | 判据补上 `/\/mmc\d/`、`/-mmc\d/` 以及文案里的 `supplement`/`appendix` |
| ② | **拿到了也下不动**。原来只在**页面内 `fetch`** 取字节，而 `sciencedirect.com → ars.els-cdn.com` 是跨站，**被 CORS 拦死**：`TypeError: Failed to fetch` | 改成**直连优先**：`Zotero.HTTP` 没有 CORS 限制，先直连；失败（如 ACS 一律 403）再退回页面内 fetch |

**实测（v1.4.4）**：对 `10.1016/j.carbon.2017.11.056` 跑一遍 →

```
处理前附件数: 1  →  处理后附件数: 2
★ [SI] One-pot environment-friendly synthesis of boron doped graphene - 1-s2.0-…-mmc1.docx
   1,459,647 字节
```

字节数与 CDN 报的 `content-length` **完全一致**。

## 结论三：**综述类文章通常本来就没有 SI**

用户问的那篇 `10.1016/j.trechm.2024.11.003`（Trends in Chemistry 综述）实测：

```
付费墙   : 「North Minzu University does not subscribe …」
SI 文本  : []        ← 页面上没有 Supplementary/Appendix 字样
mmc 链接 : （无）     ← 没有任何 SI 文件链接
```

**是「本来就没有」，不是「被墙住」。**

## 打包铁律（再强调一次）

`manifest.json` **绝不能自己重写** —— 重写过的会被 Zotero 拒装，硬塞进 `extensions/`
也会在下次启动时连 XPI 一起被删掉。用 `bash build_si_plugin.sh <上一版能装的.xpi> <输出.xpi>`：
以能装的版本为基底，**只覆盖 JS + 改 version**，其它字段一律保持原样。

---

# ⚠️ Word 版 SI 专题（2026-10-12）

## 下载这一侧：本来就是好的

两篇真 SI 都是 `.docx`，插件（v1.4.4）**下得下来、挂得上去**，标题自动带 `[SI] ` 前缀：

| 论文（Zotero 父条目） | SI 附件 | 大小 |
|---|---|---|
| One-pot … boron doped graphene-SnO₂ | `[SI] …S0008622317311703-mmc1.docx` | 1.46 MB |
| Quantifying graphitic curvature … | `[SI] …S1385894725070251-mmc1.docx` | **13.55 MB** |

## 出图这一侧：**以前整条是断的**（翻译插件 2.4.8.56 起已修）

> 详细技术记录见 `README_持久化翻译记忆补丁.md` **§22.13**。这里只留结论。

**两个断点：**

1. `findSiAttachment` 只认 `application/pdf` → Word SI 的候选池是空的，浮窗永不出现（不报错）。
   → 现在按 `pdf / word(.docx) / doc(老 .doc) ` 分档。
2. `.docx` 里的图是 **TIFF（LZW + Predictor 2）**，Firefox **不能**渲染 `data:image/tiff`。
   → 新增 `inflate.ts` + `tiff.ts` + `docx.ts` 自己解：ZIP → TIFF → RGBA → reader 窗口 canvas → 真 PNG。

**图注配图规则**：图独占一段、图注在紧邻段（有时反过来），
所以按 **`i-1 → i+1 → i → i-2 → i+2`** 就近取图。
`Table S1` 这类真 Word 表格本来就无图 → **只翻图注，不假装有图**。

## 实测（两篇真 SI，29 张图）

| 检查 | 结果 |
|---|---|
| TIFF 解码 vs PIL RGBA | **29/29 逐字节一致** |
| 图注→图映射（独立 python 实现对拍） | **29/29** |
| 活体：13.5 MB docx | 解析 **99 ms**（图按需解压），4 条引用全部配到正确图 |
| 活体：画面 | 浮窗显示原图，清晰度与 PDF 路线一致；图注翻译正常 |
| 活体：自动收起 | 选纯参考文献段 → 浮窗自动消失（PDF / Word 两条路一致） |
| 活体：点「打开 SI」 | 用**系统默认程序**打开 `.docx`（本机是 WPS Office，不是 Word） |

> ⚠️ 顺带发现并修掉一个**更隐蔽**的问题：`debugLog` 是「读整个文件 → 拼一行 → 整文件写回」，
> **没有排队**。40 条并发只落 1 条。因为本项目的验收全建立在日志上，
> 这会直接让验收标准失效 —— 详见 README §22.14。

